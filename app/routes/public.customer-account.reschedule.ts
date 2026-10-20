// Endpoint for the customer account reschedule modal. Verifies the session token and that the
// order belongs to the customer, applies the self-service gates (not fulfilled, not already
// rescheduled), validates the new date and slot, then calls
// services/reschedule-order-delivery.server.ts to write the change.

import { jwtVerify } from "jose";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { RESCHEDULED_ORDER_TAG } from "../lib/constants";
import {
  canRescheduleDelivery,
  validateDeliverySelection,
  type DeliveryScheduleRules,
} from "../lib/delivery-availability";
import { rescheduleOrderDelivery } from "../services/reschedule-order-delivery.server";
import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { unauthenticated } from "../shopify.server";

declare const process: {
  env: Record<string, string | undefined>;
};

const ORDER_CUSTOMER_QUERY = `#graphql
  query orderCustomer($id: ID!) {
    order(id: $id) {
      id
      tags
      displayFulfillmentStatus
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
      customer {
        id
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

const DELIVERY_DATE_ATTRIBUTE_KEY = "Delivery Date";
const DELIVERY_TIME_ATTRIBUTE_KEY = "Delivery Time";
const CUSTOMER_RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE =
  "This order has already been rescheduled once. Please contact us if you need further assistance.";
const CUSTOMER_RESCHEDULE_CLOSED_MESSAGE =
  "This delivery can no longer be rescheduled online because the delivery date is too close or has already passed. Please contact us for manual assistance.";
const CUSTOMER_RESCHEDULE_FULFILLED_MESSAGE =
  "This order can no longer be rescheduled online because it is already being prepared or has been fulfilled. Please contact us for manual assistance.";
const ONLINE_RESCHEDULE_BLOCKED_FULFILLMENT_STATUSES = new Set([
  "FULFILLED",
  "PARTIALLY_FULFILLED",
  "IN_PROGRESS",
  "SCHEDULED",
]);

interface RescheduleRequestBody {
  orderId?: unknown;
  date?: unknown;
  timeSlot?: unknown;
  sessionToken?: unknown;
}

type SessionTokenPayload = {
  aud?: string;
  dest?: string;
  sub?: string;
};

type OrderCustomAttribute = {
  key: string;
  value: string;
};

const CUSTOMER_ACCOUNT_ORIGINS = new Set(["https://extensions.shopifycdn.com"]);

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  return origin && CUSTOMER_ACCOUNT_ORIGINS.has(origin) ? origin : null;
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

  return getCustomAttributeValue(
    order.customAttributes,
    DELIVERY_DATE_ATTRIBUTE_KEY,
  );
}

function getCurrentDeliveryTimeSlot(order: {
  currentDeliveryTimeSlot?: { value?: string | null } | null;
  customAttributes?: OrderCustomAttribute[] | null;
}): string | null {
  const metafieldValue = order.currentDeliveryTimeSlot?.value;
  if (isNonEmptyString(metafieldValue)) {
    return metafieldValue;
  }

  return getCustomAttributeValue(
    order.customAttributes,
    DELIVERY_TIME_ATTRIBUTE_KEY,
  );
}

function isCurrentDeliveryDateTooCloseOrPast(
  currentDeliveryDate: string | null | undefined,
  scheduleRules: DeliveryScheduleRules,
  currentDeliveryTimeSlot: string | null = null,
  now = new Date(),
): boolean {
  if (
    !isNonEmptyString(currentDeliveryDate) ||
    !isValidDate(currentDeliveryDate)
  ) {
    return true;
  }

  return !canRescheduleDelivery(
    currentDeliveryDate,
    now,
    scheduleRules,
    currentDeliveryTimeSlot,
  );
}

function createHmacKey(secret: string): Uint8Array {
  const key = new Uint8Array(secret.length);
  for (let index = 0; index < secret.length; index += 1) {
    key[index] = secret.charCodeAt(index);
  }
  return key;
}

function buildResponseHeaders(request: Request): Headers {
  // Customer-account extensions post to this route from Shopify's CDN origin, so the
  // response must include explicit CORS headers for the browser request to complete.
  const headers = new Headers({
    "Cache-Control": "no-store",
    Vary: "Origin",
  });

  const allowedOrigin = isAllowedOrigin(request);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }

  return headers;
}

function emptyResponse(request: Request, status = 204): Response {
  return new Response(null, {
    status,
    headers: buildResponseHeaders(request),
  });
}

function jsonResponse(request: Request, body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: buildResponseHeaders(request),
  });
}

function orderUnavailableResponse(request: Request): Response {
  return jsonResponse(
    request,
    { ok: false, error: "Order not found or unavailable" },
    404,
  );
}

async function parseRequestBody(
  request: Request,
): Promise<RescheduleRequestBody> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as RescheduleRequestBody;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formBody = await request.text();
    const searchParams = new URLSearchParams(formBody);

    return {
      orderId: searchParams.get("orderId"),
      date: searchParams.get("date"),
      timeSlot: searchParams.get("timeSlot"),
      sessionToken: searchParams.get("sessionToken"),
    };
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return {
      orderId: formData.get("orderId"),
      date: formData.get("date"),
      timeSlot: formData.get("timeSlot"),
      sessionToken: formData.get("sessionToken"),
    };
  }

  throw new Error("Unsupported content type");
}

function extractShopFromSessionToken(
  sessionToken: SessionTokenPayload,
): string | null {
  const dest = sessionToken.dest;
  if (!isNonEmptyString(dest)) return null;

  try {
    const url =
      dest.startsWith("http://") || dest.startsWith("https://")
        ? new URL(dest)
        : new URL(`https://${dest}`);
    return url.host;
  } catch {
    return null;
  }
}

async function validateCustomerAccountSessionToken(
  sessionToken: string,
): Promise<SessionTokenPayload> {
  // Verify the lightweight extension token before trusting the customer or shop claims
  // in a browser-initiated reschedule write.
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("Shopify app credentials are not configured");
  }

  const { payload } = await jwtVerify(sessionToken, createHmacKey(apiSecret), {
    algorithms: ["HS256"],
    clockTolerance: 10,
  });

  if (payload.aud !== apiKey) {
    throw new Error("Session token had invalid API key");
  }

  return payload as SessionTokenPayload;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return emptyResponse(request);
  }

  return jsonResponse(request, { ok: false, error: "Method not allowed" }, 405);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return emptyResponse(request);
  }

  if (request.method !== "POST") {
    return jsonResponse(
      request,
      { ok: false, error: "Method not allowed" },
      405,
    );
  }

  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && !isAllowedOrigin(request)) {
    return jsonResponse(request, { ok: false, error: "Invalid origin" }, 403);
  }

  let body: RescheduleRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonResponse(
      request,
      { ok: false, error: "Invalid request body" },
      400,
    );
  }

  const { orderId, date, timeSlot, sessionToken } = body;

  if (!isNonEmptyString(sessionToken)) {
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  let verifiedSessionToken: SessionTokenPayload;
  try {
    verifiedSessionToken =
      await validateCustomerAccountSessionToken(sessionToken);
  } catch (error) {
    console.warn("[customer-account reschedule] invalid session token:", error);
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  const customerGid = verifiedSessionToken.sub;
  if (!isNonEmptyString(customerGid)) {
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  const shop = extractShopFromSessionToken(verifiedSessionToken);
  if (!shop) {
    return jsonResponse(
      request,
      { ok: false, error: "Invalid shop context" },
      400,
    );
  }

  try {
    const { admin } = await unauthenticated.admin(shop);

    if (!isNonEmptyString(orderId)) {
      return jsonResponse(
        request,
        { ok: false, error: "orderId is required" },
        400,
      );
    }
    if (!isNonEmptyString(date) || !isValidDate(date)) {
      return jsonResponse(
        request,
        { ok: false, error: "date must be a valid YYYY-MM-DD string" },
        400,
      );
    }
    if (!isNonEmptyString(timeSlot)) {
      return jsonResponse(
        request,
        { ok: false, error: "timeSlot is required" },
        400,
      );
    }

    const orderGid = orderId.startsWith("gid://")
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    const orderOwnerResponse = await admin.graphql(ORDER_CUSTOMER_QUERY, {
      variables: { id: orderGid },
    });

    const orderOwnerResult = (await orderOwnerResponse.json()) as {
      data?: {
        order?: {
          tags?: string[] | null;
          displayFulfillmentStatus?: string | null;
          customAttributes?: OrderCustomAttribute[] | null;
          currentDeliveryDate?: { value?: string | null } | null;
          currentDeliveryTimeSlot?: { value?: string | null } | null;
          rescheduleHistory?: { value?: string | null } | null;
          customer?: { id?: string | null } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };

    if (orderOwnerResult.errors?.length) {
      console.error(
        "[customer-account reschedule] order lookup errors:",
        orderOwnerResult.errors,
      );
      return jsonResponse(
        request,
        { ok: false, error: "Failed to validate order" },
        500,
      );
    }

    const order = orderOwnerResult.data?.order ?? null;
    if (!order) {
      return orderUnavailableResponse(request);
    }

    const orderCustomerId = order.customer?.id ?? null;
    // Confirm order ownership before validating or writing anything so a signed-in
    // customer can only reschedule their own order without revealing whether another
    // submitted order ID exists.
    if (!orderCustomerId || orderCustomerId !== customerGid) {
      return orderUnavailableResponse(request);
    }

    if (
      isFulfilledForOnlineReschedule(
        order.displayFulfillmentStatus,
      )
    ) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_FULFILLED_MESSAGE,
          code: "order_already_fulfilled",
        },
        422,
      );
    }

    if (hasRescheduleTag(order.tags)) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE,
          code: "already_rescheduled_once",
        },
        422,
      );
    }

    // Reuse the shared delivery rules contract here so the customer-account flow stays
    // in parity with storefront and admin availability decisions. This order's own
    // booking is excluded from the counts so it cannot block itself out of a slot.
    const scheduleRules = await getScheduleRulesWithBookedCounts(shop, admin, {
      excludeOrderId: orderGid,
    });

    const currentDeliveryDate = getCurrentDeliveryDate(order);
    const currentDeliveryTimeSlot = getCurrentDeliveryTimeSlot(order);
    if (
      isCurrentDeliveryDateTooCloseOrPast(
        currentDeliveryDate,
        scheduleRules,
        currentDeliveryTimeSlot,
      )
    ) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_CLOSED_MESSAGE,
          code: "current_delivery_date_too_close_or_past",
        },
        422,
      );
    }
    const validation = validateDeliverySelection(scheduleRules, date, timeSlot);
    if (!validation.ok) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: validation.message,
          code: validation.code,
          minDate: validation.minDate,
          maxDate: validation.maxDate,
          availableSlots: validation.availableSlots.map((slot) => ({
            display: slot.display,
            value: slot.value,
          })),
        },
        422,
      );
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
      return jsonResponse(
        request,
        { ok: false, error: "Failed to verify order state before rescheduling" },
        500,
      );
    }

    if (isFulfilledForOnlineReschedule(recheckResult.data.order.displayFulfillmentStatus)) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_FULFILLED_MESSAGE,
          code: "order_already_fulfilled",
        },
        422,
      );
    }

    if (hasRescheduleTag(recheckResult.data.order.tags)) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE,
          code: "already_rescheduled_once",
        },
        422,
      );
    }

    // The write orchestration lives in the shared rescheduleOrderDelivery()
    // service (REC-1) — the same sequence the merchant op uses. This route
    // keeps only the customer self-service gates above.
    const result = await rescheduleOrderDelivery(admin, {
      orderId: orderGid,
      date,
      timeSlot,
      source: "customer",
      currentDeliveryDate: currentDeliveryDate,
      currentDeliveryTimeSlot,
      currentTags: order.tags ?? [],
      currentCustomAttributes: order.customAttributes ?? [],
      existingRescheduleHistoryValue: order.rescheduleHistory?.value ?? null,
      shopTimezone: scheduleRules.timezone,
    });

    if (!result.ok) {
      if (result.canonicalErrors.graphql.length > 0) {
        console.error(
          "[customer-account reschedule] GraphQL errors:",
          result.canonicalErrors.graphql,
        );
        return jsonResponse(
          request,
          { ok: false, error: "Failed to save reschedule request" },
          500,
        );
      }
      console.warn(
        "[customer-account reschedule] metafieldsSet userErrors:",
        result.canonicalErrors.user,
      );
      return jsonResponse(
        request,
        {
          ok: false,
          error:
            result.canonicalErrors.user[0] ??
            "Failed to save reschedule request",
        },
        422,
      );
    }

    return jsonResponse(request, {
      ok: true,
      orderId: orderGid,
      rescheduledAt: result.rescheduledAt,
      rescheduleStatus: "confirmed",
      newDate: date,
      newTimeSlot: timeSlot,
      deliveryAttributeSync: result.attributeSync,
      deliveryTagSync: result.tagSync,
      rescheduleHistorySync: result.historySync,
    });
  } catch (error) {
    console.error(
      "[customer-account reschedule] failed to save reschedule:",
      error,
    );
    return jsonResponse(
      request,
      { ok: false, error: "Failed to save reschedule request" },
      500,
    );
  }
};
