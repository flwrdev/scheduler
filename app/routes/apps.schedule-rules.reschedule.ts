// App proxy endpoint (POST /apps/schedule-rules/reschedule): lets a logged-in customer
// reschedule their own order from the storefront. Shopify adds `logged_in_customer_id` to the
// signed request; the route checks that customer owns the order, that the order is still
// reschedulable (not fulfilled, `resched` tag absent), validates the new date and slot, then
// writes the delivery metafields, attributes and tags on the order.

import type { ActionFunctionArgs } from "react-router";

import { RESCHEDULED_ORDER_TAG } from "../lib/constants";
import {
  canRescheduleDelivery,
  validateDeliverySelection,
} from "../lib/delivery-availability";
import {
  buildNextDeliveryCustomAttributes,
  syncOrderDeliveryScheduleTag,
  type OrderCustomAttribute,
} from "../services/order-delivery-metafields.server";
import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { authenticate } from "../shopify.server";

const ORDER_DELIVERY_STATE_QUERY = `#graphql
  query orderDeliveryState($id: ID!) {
    order(id: $id) {
      id
      displayFulfillmentStatus
      tags
      customAttributes {
        key
        value
      }
      customer {
        id
      }
      currentDeliveryDate: metafield(namespace: "custom", key: "date") {
        value
      }
    }
  }
`;

const SET_RESCHEDULE_METAFIELDS_MUTATION = `#graphql
  mutation setRescheduleMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        value
        namespace
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const UPDATE_ORDER_DELIVERY_ATTRIBUTES_MUTATION = `#graphql
  mutation updateOrderDeliveryAttributes($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const RECHECK_ORDER_STATE_QUERY = `#graphql
  query RecheckOrderState($id: ID!) {
    order(id: $id) {
      displayFulfillmentStatus
      tags
    }
  }
`;

interface RescheduleRequestBody {
  orderId?: unknown;
  date?: unknown;
  timeSlot?: unknown;
}

type OrderUpdateResponse = {
  data?: {
    orderUpdate?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
};

const CUSTOMER_ACCOUNT_ORIGINS = new Set(["https://account.flowercart.store"]);
const DELIVERY_DATE_ATTRIBUTE_KEY = "Delivery Date";
const RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE =
  "This order has already been rescheduled once. Please contact us if you need further assistance.";
const RESCHEDULE_CLOSED_MESSAGE =
  "This delivery can no longer be rescheduled online because the delivery date is too close or has already passed. Please contact us for manual assistance.";
const RESCHEDULE_FULFILLED_MESSAGE =
  "This order can no longer be rescheduled online because it is already being prepared or has been fulfilled. Please contact us for manual assistance.";
const ONLINE_RESCHEDULE_BLOCKED_FULFILLMENT_STATUSES = new Set([
  "FULFILLED",
  "PARTIALLY_FULFILLED",
  "IN_PROGRESS",
  "SCHEDULED",
]);

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasRescheduleTag(tags: string[] | null | undefined): boolean {
  return (tags ?? []).some(
    (tag) => tag.trim().toLowerCase() === RESCHEDULED_ORDER_TAG,
  );
}

function isFulfilledForOnlineReschedule(
  status: string | null | undefined,
): boolean {
  return ONLINE_RESCHEDULE_BLOCKED_FULFILLMENT_STATUSES.has(
    (status ?? "").trim().toUpperCase(),
  );
}

function getCustomAttributeValue(
  attributes: OrderCustomAttribute[] | null | undefined,
  key: string,
): string | null {
  return attributes?.find((attribute) => attribute.key === key)?.value ?? null;
}

function getCurrentDeliveryDate(order: {
  currentDeliveryDate?: { value?: string | null } | null;
  customAttributes?: OrderCustomAttribute[] | null;
}): string | null {
  const metafieldValue = order.currentDeliveryDate?.value;
  if (isNonEmptyString(metafieldValue)) {
    return metafieldValue;
  }

  return getCustomAttributeValue(order.customAttributes, DELIVERY_DATE_ATTRIBUTE_KEY);
}

function isAllowedCustomerAccountOrigin(origin: string | null): boolean {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    if (CUSTOMER_ACCOUNT_ORIGINS.has(url.origin)) return true;
    return url.hostname.endsWith(".account.myshopify.com");
  } catch {
    return false;
  }
}

function buildCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  if (!isAllowedCustomerAccountOrigin(origin)) {
    return {
      Vary: "Origin",
    };
  }

  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonError(
  message: string,
  status: number,
  request: Request,
): Response {
  return Response.json(
    { ok: false, error: message },
    { status, headers: buildCorsHeaders(request) },
  );
}

function orderUnavailableError(request: Request): Response {
  return jsonError("Order not found or unavailable", 404, request);
}

async function parseRequestBody(
  request: Request,
): Promise<RescheduleRequestBody> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as RescheduleRequestBody;
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return {
      orderId: formData.get("orderId"),
      date: formData.get("date"),
      timeSlot: formData.get("timeSlot"),
    };
  }

  throw new Error("Unsupported content type");
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: buildCorsHeaders(request),
    });
  }

  if (request.method !== "POST") {
    return jsonError("Method not allowed", 405, request);
  }

  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin) {
    return jsonError("Unauthorized", 401, request);
  }

  // Shopify injects logged_in_customer_id into the proxy URL before signing the HMAC.
  // After authenticate.public.appProxy succeeds the value is cryptographically authentic.
  const proxyUrl = new URL(request.url);
  const rawCustomerId = proxyUrl.searchParams.get("logged_in_customer_id");
  if (!rawCustomerId) {
    return jsonError("Unauthorized", 401, request);
  }
  const customerGid = `gid://shopify/Customer/${rawCustomerId}`;

  let body: RescheduleRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonError("Invalid request body", 400, request);
  }

  const { orderId, date, timeSlot } = body;

  if (!isNonEmptyString(orderId)) {
    return jsonError("orderId is required", 400, request);
  }
  if (!isNonEmptyString(date) || !isValidDate(date)) {
    return jsonError("date must be a valid YYYY-MM-DD string", 400, request);
  }
  if (!isNonEmptyString(timeSlot)) {
    return jsonError("timeSlot is required", 400, request);
  }

  // Resolve numeric ID → GID if the caller passed a bare numeric string
  const orderGid = orderId.startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const orderStateResponse = await admin.graphql(ORDER_DELIVERY_STATE_QUERY, {
    variables: { id: orderGid },
  });
  const orderStateResult = (await orderStateResponse.json()) as {
    data?: {
      order?: {
        displayFulfillmentStatus?: string | null;
        tags?: string[] | null;
        customAttributes?: OrderCustomAttribute[] | null;
        customer?: { id?: string | null } | null;
        currentDeliveryDate?: { value?: string | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (orderStateResult.errors?.length) {
    console.error("[reschedule] order lookup errors:", orderStateResult.errors);
    return jsonError("Failed to load order delivery state", 500, request);
  }

  const orderState = orderStateResult.data?.order;
  if (!orderState) {
    return orderUnavailableError(request);
  }

  // Verify the order belongs to the customer authenticated by the proxy.
  // Use the same response for missing and not-owned orders so the caller cannot
  // infer whether a submitted order ID exists.
  const orderCustomerId = orderState.customer?.id ?? null;
  if (!orderCustomerId || orderCustomerId !== customerGid) {
    return orderUnavailableError(request);
  }

  if (isFulfilledForOnlineReschedule(orderState.displayFulfillmentStatus)) {
    return jsonError(RESCHEDULE_FULFILLED_MESSAGE, 422, request);
  }

  if (hasRescheduleTag(orderState.tags)) {
    return jsonError(RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE, 422, request);
  }

  // This order's own booking is excluded from the counts so it cannot block
  // itself out of a slot when rescheduling.
  const scheduleRules = await getScheduleRulesWithBookedCounts(
    session?.shop,
    admin,
    { excludeOrderId: orderGid },
  );
  const validation = validateDeliverySelection(scheduleRules, date, timeSlot);
  if (!validation.ok) {
    return jsonError(validation.message, 422, request);
  }

  const currentDeliveryDate = getCurrentDeliveryDate(orderState);
  if (
    !currentDeliveryDate ||
    !isValidDate(currentDeliveryDate) ||
    !canRescheduleDelivery(currentDeliveryDate, new Date(), scheduleRules)
  ) {
    return jsonError(RESCHEDULE_CLOSED_MESSAGE, 422, request);
  }

  // Re-read the two fields that can change while this request was validating.
  // A concurrent reschedule or fulfillment between the first fetch and the mutations
  // below would otherwise pass every guard on stale data.
  const recheckResponse = await admin.graphql(RECHECK_ORDER_STATE_QUERY, {
    variables: { id: orderGid },
  });
  const recheckResult = (await recheckResponse.json()) as {
    data?: {
      order?: {
        displayFulfillmentStatus?: string | null;
        tags?: string[] | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (recheckResult.errors?.length || !recheckResult.data?.order) {
    return jsonError("Failed to verify order state before rescheduling", 500, request);
  }

  if (isFulfilledForOnlineReschedule(recheckResult.data.order.displayFulfillmentStatus)) {
    return jsonError(RESCHEDULE_FULFILLED_MESSAGE, 422, request);
  }

  if (hasRescheduleTag(recheckResult.data.order.tags)) {
    return jsonError(RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE, 422, request);
  }

  const rescheduledAt = new Date().toISOString();

  const metafields = [
    // Update the canonical delivery date and time slot immediately
    {
      ownerId: orderGid,
      namespace: "custom",
      key: "date",
      value: date,
      type: "date",
    },
    {
      ownerId: orderGid,
      namespace: "custom",
      key: "time_slot",
      value: timeSlot,
      type: "single_line_text_field",
    },
    // Record the reschedule as confirmed — no manual approval needed
    {
      ownerId: orderGid,
      namespace: "$app",
      key: "reschedule_status",
      value: "confirmed",
      type: "single_line_text_field",
    },
    {
      ownerId: orderGid,
      namespace: "$app",
      key: "reschedule_requested_at",
      value: rescheduledAt,
      type: "date_time",
    },
  ];

  const response = await admin.graphql(SET_RESCHEDULE_METAFIELDS_MUTATION, {
    variables: { metafields },
  });

  const result = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        metafields: Array<{ key: string; value: string; namespace: string }>;
        userErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (result.errors && result.errors.length > 0) {
    console.error("[reschedule] GraphQL errors:", result.errors);
    return jsonError("Failed to save reschedule request", 500, request);
  }

  const userErrors = result.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.warn("[reschedule] metafieldsSet userErrors:", userErrors);
    return jsonError(
      userErrors[0].message ?? "Failed to save reschedule request",
      422,
      request,
    );
  }

  const nextDeliveryAttributes = buildNextDeliveryCustomAttributes(
    orderState.customAttributes,
    date,
    timeSlot,
  );
  let attributeSyncFailed = false;

  const attributeSyncResponse = await admin.graphql(
    UPDATE_ORDER_DELIVERY_ATTRIBUTES_MUTATION,
    {
      variables: {
        input: {
          id: orderGid,
          customAttributes: nextDeliveryAttributes,
        },
      },
    },
  );
  const attributeSyncResult =
    (await attributeSyncResponse.json()) as OrderUpdateResponse;
  const attributeSyncUserErrors =
    attributeSyncResult.data?.orderUpdate?.userErrors ?? [];

  if (
    !attributeSyncResponse.ok ||
    attributeSyncResult.errors?.length ||
    attributeSyncUserErrors.length > 0
  ) {
    attributeSyncFailed = true;
  }

  const tagSyncResult = await syncOrderDeliveryScheduleTag(admin, {
    orderId: orderGid,
    deliveryDate: date,
    timeSlot,
    currentTags: orderState.tags,
    additionalTags: [RESCHEDULED_ORDER_TAG],
  });

  return Response.json(
    {
      ok: true,
      orderId: orderGid,
      rescheduledAt,
      rescheduleStatus: "confirmed",
      newDate: date,
      newTimeSlot: timeSlot,
      deliveryAttributeSync: attributeSyncFailed ? "failed" : "updated",
      deliveryTagSync: tagSyncResult.ok ? "updated" : "failed",
    },
    {
      headers: {
        "Cache-Control": "no-store",
        ...buildCorsHeaders(request),
      },
    },
  );
};
