// Records which reschedules (and email replies) the merchant has acknowledged with Seen, by
// writing the event's timestamp to an app-owned order metafield. Stored on the order so it is
// shared across devices and staff, and a newer event on the same order shows up again.

import type { AdminGraphQLClient } from "./order-delivery-metafields.server";

// The `markRescheduleSeen` op behind the Orders Ops "Rescheduled today"
// banner's Seen / Mark all seen buttons (2026-09-04). It records the
// requestedAt of the reschedule the merchant acknowledged on an app-reserved
// order metafield.
//
// Why a `$app` metafield and not Postgres or a tag: no migration, shared across
// every device/staff member (unlike localStorage), invisible to other apps, and
// keyed by the event's own timestamp — so a later reschedule of the same order
// (a newer requestedAt) resurfaces on its own. It is an ORDER write but NOT a
// delivery write: it touches none of the fields in api.md §2.

export interface SeenMetafield {
  namespace: string;
  key: string;
  type: "date_time";
}

export const RESCHEDULE_SEEN_METAFIELD = {
  namespace: "$app",
  key: "reschedule_seen_at",
  type: "date_time",
} as const satisfies SeenMetafield;

// Shopify caps one metafieldsSet call at 25 entries.
const METAFIELDS_SET_BATCH = 25;
// Bounded by the banner's own fetch (50 orders) — anything larger is not ours.
export const MAX_SEEN_ENTRIES = 50;

const ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

const MARK_RESCHEDULE_SEEN_MUTATION = `#graphql
  mutation MarkRescheduleSeen($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

export type MarkSeenAction = "markRescheduleSeen" | "markEmailReplySeen";

export interface MarkSeenResponse<A extends MarkSeenAction = MarkSeenAction> {
  ok: boolean;
  action: A;
  message: string;
  orderIds: string[];
}

export type MarkRescheduleSeenResponse = MarkSeenResponse<"markRescheduleSeen">;

export interface MarkSeenOpConfig<A extends MarkSeenAction = MarkSeenAction> {
  action: A;
  metafield: SeenMetafield;
  timestampField: string;
  noun: string;
}

export const RESCHEDULE_SEEN_OP: MarkSeenOpConfig<"markRescheduleSeen"> = {
  action: "markRescheduleSeen",
  metafield: RESCHEDULE_SEEN_METAFIELD,
  timestampField: "requestedAt",
  noun: "reschedules",
};

export interface SeenEntry {
  orderId: string;
  seenAt: string;
}

export type MarkSeenInput =
  | { ok: true; entries: SeenEntry[] }
  | { ok: false; message: string };

export type MarkRescheduleSeenInput = MarkSeenInput;

/**
 * Accepts one pair (`orderId` + timestamp field) or N parallel pairs (repeated
 * fields, same order) — the single Seen button and Mark all seen share the op.
 */
export function parseMarkSeenInput(
  fd: FormData,
  timestampField: string,
  noun: string,
): MarkSeenInput {
  const orderIds = fd.getAll("orderId").map((v) => String(v).trim());
  const requestedAts = fd.getAll(timestampField).map((v) => String(v).trim());
  if (orderIds.length === 0 || orderIds.length !== requestedAts.length) {
    return {
      ok: false,
      message: `orderId and ${timestampField} must be supplied in pairs.`,
    };
  }
  if (orderIds.length > MAX_SEEN_ENTRIES) {
    return { ok: false, message: `Mark at most ${MAX_SEEN_ENTRIES} ${noun} at a time.` };
  }
  const entries: SeenEntry[] = [];
  const seenOrderIds = new Set<string>();
  for (let i = 0; i < orderIds.length; i += 1) {
    const orderId = orderIds[i];
    if (!ORDER_GID_RE.test(orderId)) {
      return { ok: false, message: "orderId must be an Order GID." };
    }
    const ts = Date.parse(requestedAts[i]);
    if (Number.isNaN(ts)) {
      return { ok: false, message: `${timestampField} must be a valid timestamp.` };
    }
    if (seenOrderIds.has(orderId)) continue;
    seenOrderIds.add(orderId);
    entries.push({ orderId, seenAt: new Date(ts).toISOString() });
  }
  return { ok: true, entries };
}

export function parseMarkRescheduleSeenInput(fd: FormData): MarkSeenInput {
  return parseMarkSeenInput(
    fd,
    RESCHEDULE_SEEN_OP.timestampField,
    RESCHEDULE_SEEN_OP.noun,
  );
}

interface MetafieldsSetBody {
  data?: {
    metafieldsSet?: {
      userErrors?: Array<{ field?: string[] | null; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

async function writeSeenBatch(
  admin: AdminGraphQLClient,
  metafield: SeenMetafield,
  batch: SeenEntry[],
): Promise<string[]> {
  const response = await admin.graphql(MARK_RESCHEDULE_SEEN_MUTATION, {
    variables: {
      metafields: batch.map((entry) => ({
        ownerId: entry.orderId,
        namespace: metafield.namespace,
        key: metafield.key,
        type: metafield.type,
        value: entry.seenAt,
      })),
    },
  });
  const body = (await response.json()) as MetafieldsSetBody;
  return [
    ...(body.errors?.map((e) => e.message) ?? []),
    ...(body.data?.metafieldsSet?.userErrors?.map((e) => e.message) ?? []),
  ];
}

export async function handleMarkSeenOp<A extends MarkSeenAction>(
  admin: AdminGraphQLClient,
  fd: FormData,
  config: MarkSeenOpConfig<A>,
): Promise<Response> {
  const { action, metafield, timestampField, noun } = config;
  const input = parseMarkSeenInput(fd, timestampField, noun);
  if (!input.ok) {
    // Validation stays 4xx; only upstream trouble is 200 + ok:false (ADR-11).
    return Response.json(
      {
        ok: false,
        action,
        message: input.message,
        orderIds: [],
      } satisfies MarkSeenResponse<A>,
      { status: 400 },
    );
  }

  const orderIds = input.entries.map((entry) => entry.orderId);
  const failureMessage = `Could not mark these ${noun} as seen. Try again in a moment.`;
  const failure = (): Response =>
    Response.json({
      ok: false,
      action,
      message: failureMessage,
      orderIds,
    } satisfies MarkSeenResponse<A>);

  try {
    for (let i = 0; i < input.entries.length; i += METAFIELDS_SET_BATCH) {
      const batch = input.entries.slice(i, i + METAFIELDS_SET_BATCH);
      const errors = await writeSeenBatch(admin, metafield, batch);
      if (errors.length > 0) {
        console.warn(
          `[orders action] ${action} (${batch.length} orders): ${errors.join("; ")}`,
        );
        return failure();
      }
    }
  } catch (error) {
    console.warn(
      `[orders action] ${action} threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return failure();
  }

  const n = orderIds.length;
  return Response.json({
    ok: true,
    action,
    message: n === 1 ? "Marked as seen." : `Marked ${n} ${noun} as seen.`,
    orderIds,
  } satisfies MarkSeenResponse<A>);
}

export async function handleMarkRescheduleSeenOp(
  admin: AdminGraphQLClient,
  fd: FormData,
): Promise<Response> {
  return handleMarkSeenOp(admin, fd, RESCHEDULE_SEEN_OP);
}
