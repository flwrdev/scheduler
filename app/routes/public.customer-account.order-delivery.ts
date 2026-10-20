// Endpoint for the customer account order status extension: returns the order's current delivery
// date, time slot and reschedule status (read from order metafields). Verifies the session token
// and that the order belongs to the signed-in customer.

import { jwtVerify } from "jose";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { unauthenticated } from "../shopify.server";

declare const process: {
  env: Record<string, string | undefined>;
};

const ORDER_DELIVERY_QUERY = `#graphql
  query orderDelivery($id: ID!) {
    order(id: $id) {
      customer {
        id
      }
      customAttributes {
        key
        value
      }
      deliveryDate: metafield(namespace: "custom", key: "date") {
        value
      }
      timeSlot: metafield(namespace: "custom", key: "time_slot") {
        value
      }
      rescheduleStatus: metafield(namespace: "$app", key: "reschedule_status") {
        value
      }
    }
  }
`;

type OrderDeliveryRequestBody = {
  orderId?: unknown;
  sessionToken?: unknown;
};

type SessionTokenPayload = {
  aud?: string;
  dest?: string;
  sub?: string;
};

const CUSTOMER_ACCOUNT_ORIGINS = new Set(["https://extensions.shopifycdn.com"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  return origin && CUSTOMER_ACCOUNT_ORIGINS.has(origin) ? origin : null;
}

function createHmacKey(secret: string): Uint8Array {
  const key = new Uint8Array(secret.length);
  for (let index = 0; index < secret.length; index += 1) {
    key[index] = secret.charCodeAt(index);
  }
  return key;
}

function buildResponseHeaders(request: Request): Headers {
  // Customer-account extensions run from Shopify's CDN origin, so every response
  // needs explicit CORS headers or the block cannot read the backend result at all.
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

async function parseRequestBody(request: Request): Promise<OrderDeliveryRequestBody> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as OrderDeliveryRequestBody;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formBody = await request.text();
    const searchParams = new URLSearchParams(formBody);

    return {
      orderId: searchParams.get("orderId"),
      sessionToken: searchParams.get("sessionToken"),
    };
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return {
      orderId: formData.get("orderId"),
      sessionToken: formData.get("sessionToken"),
    };
  }

  throw new Error("Unsupported content type");
}

function extractShopFromSessionToken(sessionToken: SessionTokenPayload): string | null {
  const dest = sessionToken.dest;
  if (!isNonEmptyString(dest)) {
    return null;
  }

  try {
    const url = dest.startsWith("http://") || dest.startsWith("https://")
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
  // The extension only gets a lightweight session token, so we verify it here before
  // trusting any claimed customer or shop context in a direct browser request.
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

function getCustomAttribute(
  attributes: Array<{ key: string; value: string }> | null | undefined,
  key: string,
) {
  return attributes?.find((attribute) => attribute.key === key)?.value ?? null;
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
    return jsonResponse(request, { ok: false, error: "Method not allowed" }, 405);
  }

  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && !isAllowedOrigin(request)) {
    return jsonResponse(request, { ok: false, error: "Invalid origin" }, 403);
  }

  let body: OrderDeliveryRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonResponse(request, { ok: false, error: "Invalid request body" }, 400);
  }

  if (!isNonEmptyString(body.sessionToken)) {
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  let verifiedSessionToken: SessionTokenPayload;
  try {
    verifiedSessionToken = await validateCustomerAccountSessionToken(body.sessionToken);
  } catch (error) {
    console.warn("[customer-account order-delivery] invalid session token:", error);
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  const customerGid = verifiedSessionToken.sub;
  if (!isNonEmptyString(customerGid)) {
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  const shop = extractShopFromSessionToken(verifiedSessionToken);
  if (!shop) {
    return jsonResponse(request, { ok: false, error: "Invalid shop context" }, 400);
  }

  if (!isNonEmptyString(body.orderId)) {
    return jsonResponse(request, { ok: false, error: "orderId is required" }, 400);
  }

  const orderGid = body.orderId.startsWith("gid://")
    ? body.orderId
    : `gid://shopify/Order/${body.orderId}`;

  try {
    const { admin } = await unauthenticated.admin(shop);
    // Read from Admin as the source of truth for the latest saved delivery data,
    // then fall back to legacy order attributes for older orders that still rely on them.
    const response = await admin.graphql(ORDER_DELIVERY_QUERY, {
      variables: { id: orderGid },
    });

    const result = (await response.json()) as {
      data?: {
        order?: {
          customer?: { id?: string | null } | null;
          customAttributes?: Array<{ key: string; value: string }> | null;
          deliveryDate?: { value?: string | null } | null;
          timeSlot?: { value?: string | null } | null;
          rescheduleStatus?: { value?: string | null } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };

    if (result.errors?.length) {
      console.error("[customer-account order-delivery] GraphQL errors:", result.errors);
      return jsonResponse(request, { ok: false, error: "Failed to load order delivery" }, 500);
    }

    const order = result.data?.order ?? null;
    if (!order) {
      return orderUnavailableResponse(request);
    }

    const orderCustomerId = order.customer?.id ?? null;
    // Even with a valid customer-account token, only return delivery details for the
    // signed-in customer's own order to avoid leaking order metadata across accounts.
    if (!orderCustomerId || orderCustomerId !== customerGid) {
      return orderUnavailableResponse(request);
    }

    return jsonResponse(request, {
      ok: true,
      delivery: {
        date: order.deliveryDate?.value ?? getCustomAttribute(order.customAttributes, "Delivery Date"),
        timeSlot:
          order.timeSlot?.value ?? getCustomAttribute(order.customAttributes, "Delivery Time"),
        status: order.rescheduleStatus?.value ?? null,
      },
    });
  } catch (error) {
    console.error("[customer-account order-delivery] failed to load order delivery:", error);
    return jsonResponse(
      request,
      { ok: false, error: "Failed to load order delivery" },
      500,
    );
  }
};
