// Bulk-action executor for the /app/orders bulk ops, run inline inside the
// route action.
//
// Param VALIDATION does not live here: the route action validates (400s,
// capacity warn+override) BEFORE calling this, so a `BulkOpParams` is valid by
// construction wherever it appears.
//
// Retry idempotency (a resubmitted selection re-executes an item, so every op
// must be safe to run twice):
// - archive/unarchive/tagsAdd/tagsRemove: naturally idempotent at Shopify.
// - cancel: an "already cancelled" userError on re-execution is reported as
//   success, not failure.
// - markAsPaid: a "cannot be marked as paid" userError on re-execution (order
//   already fully paid) is reported as success, not failure.
// - markFulfilled: the fulfillmentOrders re-check finds nothing fulfillable on
//   a re-run; when the order's displayFulfillmentStatus is FULFILLED that is
//   reported as success ("Already fulfilled"), not failure.
// - reschedule: an order whose CANONICAL metafields already sit at the target
//   date+slot is skipped as success — deliberately metafield-only (never the
//   customAttribute fallback), so a drifted order still gets repaired while a
//   retry (metafields written by the prior attempt) produces no duplicate
//   history entry.

import { rescheduleOrderDelivery } from "./reschedule-order-delivery.server";
import { sendRescheduleNotice } from "./reschedule-notice.server";
import { getScheduleRules } from "./schedule-rules.server";
import { buildOrderEventTag } from "../lib/order-tags";
import { getShopLocalDate } from "../lib/delivery-availability";

export interface AdminGraphQLClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

// ─── Names / caps / result types (single source; the route re-exports) ──────

export type BulkActionName =
  | "archive"
  | "unarchive"
  | "cancel"
  | "tagsAdd"
  | "tagsRemove"
  | "markFulfilled"
  | "markAsPaid"
  | "reschedule";

export const BULK_ACTION_NAMES: readonly BulkActionName[] = [
  "archive",
  "unarchive",
  "cancel",
  "tagsAdd",
  "tagsRemove",
  "markFulfilled",
  "markAsPaid",
  "reschedule",
];

export const MAX_SELECTED_ORDER_IDS = 10;

export function isBulkActionName(value: string): value is BulkActionName {
  return (BULK_ACTION_NAMES as readonly string[]).includes(value);
}

export interface BulkActionItemResult {
  orderId: string;
  success: boolean;
  message?: string;
}

export interface BulkActionResponse {
  ok: boolean;
  action: BulkActionName | null;
  message?: string;
  results: BulkActionItemResult[];
  summary: { ok: number; failed: number };
  // Reschedule only (REC-4): the target slot's capacity would be exceeded and
  // the submit did not carry the explicit override — the modal re-renders as
  // a confirm step showing the projected load instead of a toast.
  code?: "capacity_override_required";
  capacity?: {
    capacity: number;
    booked: number;
    moving: number;
    projected: number;
  };
}

// Validated op inputs, passed from the route action to the executor.
export type BulkOpParams =
  | { op: "archive" }
  | { op: "unarchive" }
  | {
      op: "cancel";
      reason: string;
      restock: boolean;
      notifyCustomer: boolean;
      staffNote: string | null;
    }
  | { op: "tagsAdd"; tags: string[] }
  | { op: "tagsRemove"; tags: string[] }
  | { op: "markAsPaid" }
  | {
      op: "markFulfilled";
      trackingUrl: string;
      notifyCustomer: boolean;
    }
  | {
      op: "reschedule";
      date: string;
      timeSlot: string;
      // Stamped once at submit time so every chunk/retry writes the same
      // history timestamp.
      requestedAt: string;
      shopTimezone: string;
      // Email the customer after a successful write (2026-09-04). Optional so
      // BulkActionJob rows queued before the field existed still parse; absent
      // means no email.
      notifyCustomer?: boolean;
    };

// ─── Mutations / queries (moved verbatim from app.orders.tsx) ────────────────

const ORDER_CLOSE_MUTATION = `
  mutation OrderClose($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const ORDER_OPEN_MUTATION = `
  mutation OrderOpen($input: OrderOpenInput!) {
    orderOpen(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $restock: Boolean!
    $notifyCustomer: Boolean
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      restock: $restock
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      job { id }
      orderCancelUserErrors { field message code }
    }
  }
`;

const ORDER_MARK_AS_PAID_MUTATION = `
  mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

// Fulfillment-order workflow — used ONLY on markFulfilled. Requires
// read/write_merchant_managed_fulfillment_orders. Builds one aliased query for
// the whole id set instead of N roundtrips.
// displayFulfillmentStatus feeds the re-run idempotency check.
function buildBatchFulfillmentQuery(ids: string[]): string {
  const fragments = ids
    .map(
      (id, i) =>
        `  o${i}: order(id: "${id}") {
    id
    displayFulfillmentStatus
    fulfillmentOrders(first: 50) {
      nodes {
        id
        status
        supportedActions { action }
      }
    }
  }`,
    )
    .join("\n");
  return `query BatchFulfillmentOrders {\n${fragments}\n}`;
}

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

// Rewrite raw Shopify access-denied / scope errors into something the merchant can act on.
function scopeHint(msg: string): string {
  if (
    /access denied|fulfillmentOrders|not authorized|missing.*scope/i.test(msg)
  ) {
    return "Access denied — the app needs fulfillment-order permission. Please reinstall the app to grant the new scope.";
  }
  return msg;
}

// Batch current-delivery-state read for the reschedule op: the from→to history
// values, attribute rewrite, and tag replacement all derive from the order
// state at write time (single call per execution).
const RESCHEDULE_ORDER_STATE_QUERY = `#graphql
  query RescheduleOrderStates($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        email
        tags
        customer {
          firstName
          defaultEmailAddress {
            emailAddress
          }
        }
        customAttributes {
          key
          value
        }
        currentDeliveryDate: metafield(namespace: "custom", key: "date") {
          value
        }
        currentDeliveryTimeSlot: metafield(namespace: "custom", key: "time_slot") {
          value
        }
        rescheduleHistory: metafield(namespace: "delivery", key: "reschedule_history") {
          value
        }
      }
    }
  }
`;

const SHOPIFY_ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

// ─── Reschedule state helpers (also used by the route's capacity projection) ─

export type RescheduleOrderState = {
  id: string;
  // Recipient fields for the customer notice — server-read from the order
  // (E-4: never a client-supplied address).
  name?: string | null;
  email?: string | null;
  customer?: {
    firstName?: string | null;
    defaultEmailAddress?: { emailAddress?: string | null } | null;
  } | null;
  tags?: string[] | null;
  customAttributes?: Array<{ key: string; value: string }> | null;
  currentDeliveryDate?: { value?: string | null } | null;
  currentDeliveryTimeSlot?: { value?: string | null } | null;
  rescheduleHistory?: { value?: string | null } | null;
};

export function rescheduleAttrValueOf(
  state: RescheduleOrderState,
  key: string,
): string | null {
  return state.customAttributes?.find((a) => a.key === key)?.value ?? null;
}

export function rescheduleCurrentDateOf(state: RescheduleOrderState): string | null {
  return (
    state.currentDeliveryDate?.value?.trim() ||
    rescheduleAttrValueOf(state, "Delivery Date")
  );
}

export function rescheduleCurrentSlotOf(state: RescheduleOrderState): string | null {
  return (
    state.currentDeliveryTimeSlot?.value?.trim() ||
    rescheduleAttrValueOf(state, "Delivery Time")
  );
}

export async function fetchRescheduleOrderStates(
  admin: AdminGraphQLClient,
  ids: string[],
): Promise<
  | { ok: true; stateByOrderId: Map<string, RescheduleOrderState> }
  | { ok: false; message: string }
> {
  try {
    const stateRes = await admin.graphql(RESCHEDULE_ORDER_STATE_QUERY, {
      variables: { ids },
    });
    const stateJson = (await stateRes.json()) as {
      data?: { nodes?: Array<RescheduleOrderState | null> };
      errors?: Array<{ message: string }>;
    };
    if (stateJson.errors?.length) {
      return {
        ok: false,
        message: stateJson.errors.map((e) => e.message).join("; "),
      };
    }
    const stateByOrderId = new Map<string, RescheduleOrderState>();
    for (const node of stateJson.data?.nodes ?? []) {
      if (node?.id) stateByOrderId.set(node.id, node);
    }
    return { ok: true, stateByOrderId };
  } catch (e: unknown) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Failed to read order state.",
    };
  }
}

// ─── The executor ────────────────────────────────────────────────────────────

export async function executeBulkAction(
  admin: AdminGraphQLClient,
  shop: string,
  params: BulkOpParams,
  orderIds: string[],
): Promise<BulkActionItemResult[]> {
  const results: BulkActionItemResult[] = [];

  const runOne = async (
    id: string,
    mutation: string,
    variables: Record<string, unknown>,
    rootKey: string,
    errorsKey: "userErrors" | "orderCancelUserErrors",
  ) => {
    try {
      const res = await admin.graphql(mutation, { variables });
      const j = (await res.json()) as {
        data?: Record<string, { [k: string]: unknown }>;
        errors?: Array<{ message: string }>;
      };
      if (j.errors?.length) {
        results.push({
          orderId: id,
          success: false,
          message: j.errors.map((e) => e.message).join("; "),
        });
        return j;
      }
      const errs =
        (j?.data?.[rootKey]?.[errorsKey] as Array<{ message: string }>) || [];
      if (errs.length) {
        results.push({
          orderId: id,
          success: false,
          message: errs.map((e) => e.message).join("; "),
        });
      } else {
        results.push({ orderId: id, success: true });
      }
      return j;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "GraphQL error";
      results.push({ orderId: id, success: false, message });
      return undefined;
    }
  };

  if (params.op === "archive") {
    for (const id of orderIds) {
      await runOne(
        id,
        ORDER_CLOSE_MUTATION,
        { input: { id } },
        "orderClose",
        "userErrors",
      );
    }
  } else if (params.op === "unarchive") {
    for (const id of orderIds) {
      await runOne(
        id,
        ORDER_OPEN_MUTATION,
        { input: { id } },
        "orderOpen",
        "userErrors",
      );
    }
  } else if (params.op === "markAsPaid") {
    for (const id of orderIds) {
      const before = results.length;
      await runOne(
        id,
        ORDER_MARK_AS_PAID_MUTATION,
        { input: { id } },
        "orderMarkAsPaid",
        "userErrors",
      );
      // Retry idempotency: an order already fully paid answers with a
      // "cannot be marked as paid" userError on re-execution — that is a
      // success (end state is already correct), not a failure.
      const r = results[results.length - 1];
      if (
        results.length > before &&
        !r.success &&
        /cannot be marked as paid/i.test(r.message ?? "")
      ) {
        r.success = true;
        r.message = "Already paid.";
      }
    }
  } else if (params.op === "cancel") {
    for (const id of orderIds) {
      const before = results.length;
      await runOne(
        id,
        ORDER_CANCEL_MUTATION,
        {
          orderId: id,
          reason: params.reason,
          restock: params.restock,
          notifyCustomer: params.notifyCustomer,
          staffNote: params.staffNote,
        },
        "orderCancel",
        "orderCancelUserErrors",
      );
      // Retry idempotency: a re-execution of an already-cancelled order is a
      // success, not a failure.
      const r = results[results.length - 1];
      if (
        results.length > before &&
        !r.success &&
        /already.*cancel/i.test(r.message ?? "")
      ) {
        r.success = true;
        r.message = "Already cancelled.";
      }
    }
  } else if (params.op === "tagsAdd" || params.op === "tagsRemove") {
    const mutation =
      params.op === "tagsAdd" ? TAGS_ADD_MUTATION : TAGS_REMOVE_MUTATION;
    const rootKey = params.op === "tagsAdd" ? "tagsAdd" : "tagsRemove";
    for (const id of orderIds) {
      await runOne(id, mutation, { id, tags: params.tags }, rootKey, "userErrors");
    }
  } else if (params.op === "markFulfilled") {
    const { trackingUrl, notifyCustomer } = params;

    // ── Step 1: Batch-fetch fulfillment orders (single API call per execution) ─
    const safeIds = orderIds.filter((id) => SHOPIFY_ORDER_GID_RE.test(id));
    for (const id of orderIds) {
      if (!SHOPIFY_ORDER_GID_RE.test(id)) {
        results.push({ orderId: id, success: false, message: "Invalid order ID." });
      }
    }

    type FulfillmentNode = {
      id: string;
      status: string;
      supportedActions?: Array<{ action: string }>;
    };
    const fulfillableByOrderId = new Map<string, FulfillmentNode[]>();
    const fulfillmentStatusByOrderId = new Map<string, string>();
    let batchQueryFailed = false;

    if (safeIds.length > 0) {
      const batchQuery = buildBatchFulfillmentQuery(safeIds);
      let batchJson: {
        data?: Record<string, {
          id: string;
          displayFulfillmentStatus?: string | null;
          fulfillmentOrders: { nodes: FulfillmentNode[] };
        } | null>;
        errors?: Array<{ message: string }>;
      } = {};
      try {
        const batchRes = await admin.graphql(batchQuery);
        batchJson = await batchRes.json();
      } catch (e: unknown) {
        batchQueryFailed = true;
        const m =
          e instanceof Error ? e.message : "Failed to read fulfillment orders";
        for (const id of safeIds) {
          results.push({ orderId: id, success: false, message: scopeHint(m) });
        }
      }

      if (!batchQueryFailed) {
        if (batchJson.errors?.length) {
          batchQueryFailed = true;
          const msg = batchJson.errors.map((e) => e.message).join("; ");
          for (const id of safeIds) {
            results.push({ orderId: id, success: false, message: scopeHint(msg) });
          }
        } else {
          safeIds.forEach((id, i) => {
            const orderData = batchJson.data?.[`o${i}`];
            fulfillmentStatusByOrderId.set(
              id,
              orderData?.displayFulfillmentStatus ?? "",
            );
            fulfillableByOrderId.set(
              id,
              (orderData?.fulfillmentOrders?.nodes ?? []).filter((n) =>
                (n.supportedActions || []).some(
                  (a) => a.action === "CREATE_FULFILLMENT",
                ),
              ),
            );
          });
        }
      }
    }

    // ── Step 2: Create fulfillments (one mutation per order) ─────────────────
    if (!batchQueryFailed) {
      for (const id of safeIds) {
        const fulfillable = fulfillableByOrderId.get(id) ?? [];
        if (fulfillable.length === 0) {
          // Retry idempotency: a re-run against an already-fulfilled order is
          // a success, not "no fulfillable items".
          if (fulfillmentStatusByOrderId.get(id) === "FULFILLED") {
            results.push({ orderId: id, success: true, message: "Already fulfilled." });
          } else {
            results.push({
              orderId: id,
              success: false,
              message: "No fulfillable items remaining.",
            });
          }
          continue;
        }

        const fulfillment: Record<string, unknown> = {
          lineItemsByFulfillmentOrder: fulfillable.map((fo) => ({
            fulfillmentOrderId: fo.id,
          })),
          notifyCustomer,
        };
        if (trackingUrl) {
          fulfillment.trackingInfo = { url: trackingUrl };
        }

        const before = results.length;
        await runOne(
          id,
          FULFILLMENT_CREATE_MUTATION,
          { fulfillment },
          "fulfillmentCreate",
          "userErrors",
        );
        for (let i = before; i < results.length; i++) {
          const r = results[i];
          if (!r.success && r.message) r.message = scopeHint(r.message);
        }
      }

      // ── Step 3: timeline event tag, only for orders that actually got
      //    tracking and only where the fulfillment succeeded. A tagging
      //    failure never turns a successful fulfillment into a reported
      //    failure — the tag is a mirror, like the reschedule sync's.
      if (trackingUrl) {
        const fulfilledIds = results
          .filter((r) => r.success && safeIds.includes(r.orderId))
          .map((r) => r.orderId);
        if (fulfilledIds.length > 0) {
          try {
            const { timezone } = await getScheduleRules(shop);
            const eventTag = buildOrderEventTag(
              "trackingAdded",
              getShopLocalDate(timezone),
            );
            if (eventTag) {
              for (const id of fulfilledIds) {
                const res = await admin.graphql(TAGS_ADD_MUTATION, {
                  variables: { id, tags: [eventTag] },
                });
                const j = (await res.json()) as {
                  data?: {
                    tagsAdd?: { userErrors?: Array<{ message: string }> } | null;
                  };
                  errors?: Array<{ message: string }>;
                };
                const tagErrors = [
                  ...(j.errors?.map((e) => e.message) ?? []),
                  ...(j.data?.tagsAdd?.userErrors?.map((e) => e.message) ?? []),
                ];
                if (tagErrors.length > 0) {
                  console.warn(
                    "[markFulfilled] tracking event tag errors:",
                    id,
                    tagErrors,
                  );
                }
              }
            }
          } catch (e: unknown) {
            console.warn("[markFulfilled] tracking event tag threw:", e);
          }
        }
      }
    }
  } else if (params.op === "reschedule") {
    const { date, timeSlot, requestedAt, shopTimezone } = params;

    const safeIds = orderIds.filter((id) => SHOPIFY_ORDER_GID_RE.test(id));
    for (const id of orderIds) {
      if (!SHOPIFY_ORDER_GID_RE.test(id)) {
        results.push({ orderId: id, success: false, message: "Invalid order ID." });
      }
    }

    if (safeIds.length > 0) {
      const stateFetch = await fetchRescheduleOrderStates(admin, safeIds);
      if (!stateFetch.ok) {
        for (const id of safeIds) {
          results.push({ orderId: id, success: false, message: stateFetch.message });
        }
      } else {
        const { stateByOrderId } = stateFetch;
        for (const id of safeIds) {
          const state = stateByOrderId.get(id);
          if (!state) {
            results.push({
              orderId: id,
              success: false,
              message: "Order not found.",
            });
            continue;
          }
          // Retry idempotency (§2a): metafields already EXACTLY at the target
          // → nothing to write, no duplicate history entry. Deliberately an
          // exact string compare, not the canonical slot matcher: a crash-
          // retry re-runs an order whose metafields the prior attempt wrote
          // with the exact target values (skip ✓), while a DRIFTED spelling
          // ("9:00AM - 12:00PM" vs "9AM-12PM") or an attr-only match still
          // gets the full repair write below — the pinned §5 behavior.
          const metaDate = state.currentDeliveryDate?.value?.trim() || null;
          const metaSlot = state.currentDeliveryTimeSlot?.value?.trim() || null;
          if (metaDate === date && metaSlot === timeSlot) {
            results.push({
              orderId: id,
              success: true,
              message: "Already at the selected date and slot.",
            });
            continue;
          }
          try {
            const r = await rescheduleOrderDelivery(admin, {
              orderId: id,
              date,
              timeSlot,
              source: "merchant",
              currentDeliveryDate: rescheduleCurrentDateOf(state),
              currentDeliveryTimeSlot: rescheduleCurrentSlotOf(state),
              currentTags: state.tags ?? [],
              currentCustomAttributes: (state.customAttributes ?? []).map(
                (a) => ({ key: a.key, value: a.value }),
              ),
              existingRescheduleHistoryValue:
                state.rescheduleHistory?.value ?? null,
              requestedAt,
              shopTimezone,
            });
            if (!r.ok) {
              const msg =
                [...r.canonicalErrors.graphql, ...r.canonicalErrors.user].join(
                  "; ",
                ) || "Failed to update the delivery schedule.";
              results.push({ orderId: id, success: false, message: msg });
              continue;
            }
            const failedMirrors = [
              r.historySync === "failed" ? "history" : null,
              r.attributeSync === "failed" ? "attributes" : null,
              r.tagSync === "failed" ? "tags" : null,
            ].filter(Boolean);
            const notes: string[] = [];
            if (failedMirrors.length > 0) {
              notes.push(
                `Rescheduled, but the ${failedMirrors.join(" + ")} sync failed.`,
              );
            }
            // Customer notice runs only after the canonical write succeeded
            // and is reported, never thrown: the reschedule already happened,
            // so an SMTP hiccup must not read as a failed reschedule (and a
            // retry must not re-run the write to re-send the mail).
            if (params.notifyCustomer) {
              const notice = await sendRescheduleNotice(shop, {
                orderId: id,
                orderName: state.name ?? null,
                to:
                  state.customer?.defaultEmailAddress?.emailAddress?.trim() ||
                  state.email?.trim() ||
                  null,
                firstName: state.customer?.firstName ?? null,
                fromDate: rescheduleCurrentDateOf(state),
                fromTimeSlot: rescheduleCurrentSlotOf(state),
                toDate: date,
                toTimeSlot: timeSlot,
              });
              if (notice.status === "sent") {
                notes.push(`Customer emailed at ${notice.to}.`);
              } else if (notice.status === "skipped_no_email") {
                notes.push("No customer email on file, so no email was sent.");
              } else {
                notes.push(`Customer email failed: ${notice.error}`);
              }
            }
            results.push({
              orderId: id,
              success: true,
              message: notes.length > 0 ? notes.join(" ") : undefined,
            });
          } catch (e: unknown) {
            results.push({
              orderId: id,
              success: false,
              message: e instanceof Error ? e.message : "Reschedule failed.",
            });
          }
        }
      }
    }
  }

  return results;
}
