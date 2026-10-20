// The one write sequence for changing an order's delivery date and slot. Shared by the customer
// account route (source "customer") and the merchant reschedule (source "merchant").
// Updates the canonical and mirror metafields, the custom attributes and the schedule tags,
// adds the `resched` lock and event tag, and appends an entry to the reschedule history.

import { RESCHEDULED_ORDER_TAG } from "../lib/constants";
import { getShopLocalDate } from "../lib/delivery-availability";
import { buildOrderEventTag } from "../lib/order-tags";
import {
  type AdminGraphQLClient,
  type OrderCustomAttribute,
  buildNextDeliveryCustomAttributes,
  buildOrderDeliveryMetafields,
  syncOrderDeliveryScheduleTag,
} from "./order-delivery-metafields.server";

// ONE place that defines the delivery reschedule write sequence (REC-1).
// Both delivery-schedule writers call this service:
//   - the customer route (public.customer-account.reschedule.ts), after its
//     self-service gates pass, with source: "customer"
//   - the merchant op (app.orders.tsx action "reschedule"), after merchant-mode
//     validation passes, with source: "merchant"
// The sequence and payload shapes match the orchestration that previously
// lived inline in the customer route, with one locked change (REC-2): the
// canonical metafieldsSet now also writes the legacy mirrors delivery.date,
// delivery.time_slot, and sidekick.delivery_date, so reschedules keep the
// mirrors in sync exactly like the orders/create webhook does.

export type RescheduleSource = "customer" | "merchant";

// "skipped" = the canonical write failed, so the mirror step never ran.
export type RescheduleSyncState = "updated" | "failed" | "skipped";

export interface RescheduleHistoryEvent {
  fromDate: string;
  fromTimeSlot: string;
  toDate: string;
  toTimeSlot: string;
  requestedAt: string;
  status: "confirmed";
  source: RescheduleSource;
}

export interface RescheduleOrderDeliveryOptions {
  orderId: string;
  date: string;
  timeSlot: string;
  source: RescheduleSource;
  // Pre-fetched order state supplied by the caller (both callers already query
  // the order for their own gates). The service deliberately does NOT re-read
  // reschedule_history before appending — REC-5 declined hardening.
  currentDeliveryDate: string | null;
  currentDeliveryTimeSlot: string | null;
  currentTags: string[];
  currentCustomAttributes: OrderCustomAttribute[];
  existingRescheduleHistoryValue: string | null;
  requestedAt?: string;
  /**
   * Shop IANA timezone, used to stamp the `resched-<date>` event tag on the
   * merchant's calendar day. Both callers already have it on the loaded rules.
   * Omitted falls back to the shop default rather than the server's zone —
   * stamping UTC is what put a 4:07 AM reschedule on the previous day.
   */
  shopTimezone?: string;
}

export interface RescheduleOrderDeliveryResult {
  // true = the canonical metafield write succeeded. Mirror-step failures are
  // reported per step below and do not flip this off.
  ok: boolean;
  rescheduledAt: string;
  canonicalErrors: { graphql: string[]; user: string[] };
  historySync: RescheduleSyncState;
  attributeSync: RescheduleSyncState;
  tagSync: RescheduleSyncState;
}

const SET_RESCHEDULE_METAFIELDS_MUTATION = `#graphql
  mutation SetRescheduleMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

const UPDATE_ORDER_DELIVERY_ATTRIBUTES_MUTATION = `#graphql
  mutation UpdateOrderDeliveryAttributes($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

interface MetafieldsSetResponse {
  data?: {
    metafieldsSet?: {
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface OrderUpdateResponse {
  data?: {
    orderUpdate?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export function parseRescheduleHistory(
  value: string | null | undefined,
): RescheduleHistoryEvent[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as RescheduleHistoryEvent[]) : [];
  } catch {
    return [];
  }
}

async function setMetafields(
  admin: AdminGraphQLClient,
  metafields: Array<Record<string, string>>,
): Promise<{ ok: boolean; graphql: string[]; user: string[] }> {
  const response = await admin.graphql(SET_RESCHEDULE_METAFIELDS_MUTATION, {
    variables: { metafields },
  });
  const result = (await response.json()) as MetafieldsSetResponse;
  const graphql = result.errors?.map((error) => error.message) ?? [];
  const user =
    result.data?.metafieldsSet?.userErrors?.map((error) => error.message) ??
    [];
  return { ok: graphql.length === 0 && user.length === 0, graphql, user };
}

export async function rescheduleOrderDelivery(
  admin: AdminGraphQLClient,
  options: RescheduleOrderDeliveryOptions,
): Promise<RescheduleOrderDeliveryResult> {
  const rescheduledAt = options.requestedAt ?? new Date().toISOString();

  const failedResult = (
    graphql: string[],
    user: string[],
  ): RescheduleOrderDeliveryResult => ({
    ok: false,
    rescheduledAt,
    canonicalErrors: { graphql, user },
    historySync: "skipped",
    attributeSync: "skipped",
    tagSync: "skipped",
  });

  // ── Step 1: canonical delivery metafields (custom.* + the delivery.* /
  //    sidekick.* legacy mirrors, REC-2) + the $app reschedule markers, in a
  //    single metafieldsSet. A failure here aborts the whole reschedule —
  //    mirrors must never run ahead of the canonical state.
  const deliveryMetafields = buildOrderDeliveryMetafields({
    orderId: options.orderId,
    deliveryDate: options.date,
    timeSlot: options.timeSlot,
  });
  if (deliveryMetafields.length === 0) {
    return failedResult([], ["date must be a valid YYYY-MM-DD string"]);
  }

  const canonicalMetafields = [
    ...deliveryMetafields,
    {
      ownerId: options.orderId,
      namespace: "$app",
      key: "reschedule_status",
      value: "confirmed",
      type: "single_line_text_field",
    },
    {
      ownerId: options.orderId,
      namespace: "$app",
      key: "reschedule_requested_at",
      value: rescheduledAt,
      type: "date_time",
    },
  ];

  let canonical: { ok: boolean; graphql: string[]; user: string[] };
  try {
    canonical = await setMetafields(admin, canonicalMetafields);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "metafieldsSet failed";
    return failedResult([message], []);
  }
  if (!canonical.ok) {
    return failedResult(canonical.graphql, canonical.user);
  }

  // ── Step 2: append to delivery.reschedule_history (read-append-write over
  //    the caller-supplied snapshot; the metafield value is fully replaced on
  //    each write).
  const newHistoryEvent: RescheduleHistoryEvent = {
    fromDate: options.currentDeliveryDate ?? "",
    fromTimeSlot: options.currentDeliveryTimeSlot ?? "",
    toDate: options.date,
    toTimeSlot: options.timeSlot,
    requestedAt: rescheduledAt,
    status: "confirmed",
    source: options.source,
  };
  const updatedHistory = [
    ...parseRescheduleHistory(options.existingRescheduleHistoryValue),
    newHistoryEvent,
  ];

  let historySync: RescheduleSyncState = "updated";
  try {
    const historyResult = await setMetafields(admin, [
      {
        ownerId: options.orderId,
        namespace: "delivery",
        key: "reschedule_history",
        value: JSON.stringify(updatedHistory),
        type: "json",
      },
    ]);
    if (!historyResult.ok) {
      historySync = "failed";
      console.warn(
        "[rescheduleOrderDelivery] reschedule_history write errors:",
        [...historyResult.graphql, ...historyResult.user],
      );
    }
  } catch (error) {
    historySync = "failed";
    console.warn(
      "[rescheduleOrderDelivery] reschedule_history write threw:",
      error,
    );
  }

  // ── Step 3: mirror into the legacy Delivery Date / Delivery Time
  //    customAttributes (reschedules bypass the order-created Flow that
  //    normally maintains them).
  let attributeSync: RescheduleSyncState = "updated";
  try {
    const attributesResponse = await admin.graphql(
      UPDATE_ORDER_DELIVERY_ATTRIBUTES_MUTATION,
      {
        variables: {
          input: {
            id: options.orderId,
            customAttributes: buildNextDeliveryCustomAttributes(
              options.currentCustomAttributes,
              options.date,
              options.timeSlot,
            ),
          },
        },
      },
    );
    const attributesResult =
      (await attributesResponse.json()) as OrderUpdateResponse;
    const attributeErrors = [
      ...(attributesResult.errors?.map((error) => error.message) ?? []),
      ...(attributesResult.data?.orderUpdate?.userErrors?.map(
        (error) => error.message,
      ) ?? []),
    ];
    if (attributeErrors.length > 0) {
      attributeSync = "failed";
      console.warn(
        "[rescheduleOrderDelivery] customAttributes write errors:",
        attributeErrors,
      );
    }
  } catch (error) {
    attributeSync = "failed";
    console.warn(
      "[rescheduleOrderDelivery] customAttributes write threw:",
      error,
    );
  }

  // ── Step 4: schedule tags — remove prior delivery tags, add the new date +
  //    slot labels. Two additional tags, which are NOT the same thing:
  //      · `resched` — the self-service LOCK, customer-flow-only (§5): a
  //        merchant override does not consume the customer's one online
  //        reschedule. Matched exactly by both reschedule routes.
  //      · `resched-<shop-local date>` — the timeline event tag, written on
  //        BOTH paths. Survives the sync's removal pass because it is not
  //        shaped like a delivery schedule tag (pinned by a test).
  let tagSync: RescheduleSyncState = "updated";
  try {
    // Stamped from `rescheduledAt`, not from "now", so the tag date and the
    // reschedule_history timestamp can never disagree about which day this
    // was — and so the write is deterministic for a caller that supplies
    // requestedAt.
    const eventTag = buildOrderEventTag(
      "reschedule",
      getShopLocalDate(options.shopTimezone, new Date(rescheduledAt)),
    );
    const additionalTags = [
      ...(options.source === "customer" ? [RESCHEDULED_ORDER_TAG] : []),
      ...(eventTag ? [eventTag] : []),
    ];
    const tagResult = await syncOrderDeliveryScheduleTag(admin, {
      orderId: options.orderId,
      deliveryDate: options.date,
      timeSlot: options.timeSlot,
      currentTags: options.currentTags,
      additionalTags,
    });
    if (!tagResult.ok) {
      tagSync = "failed";
      console.warn(
        "[rescheduleOrderDelivery] schedule tag sync errors:",
        tagResult.errors,
      );
    }
  } catch (error) {
    tagSync = "failed";
    console.warn("[rescheduleOrderDelivery] schedule tag sync threw:", error);
  }

  return {
    ok: true,
    rescheduledAt,
    canonicalErrors: { graphql: [], user: [] },
    historySync,
    attributeSync,
    tagSync,
  };
}
