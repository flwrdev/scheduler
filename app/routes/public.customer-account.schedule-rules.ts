// Endpoint for the customer account "Reschedule Delivery" extension: returns the schedule
// rules and availability for the order. The extension sends a Shopify customer account session
// token; it is verified here with the app secret (signature, audience, shop). CORS only allows
// Shopify's extension origin.

import { jwtVerify } from "jose";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { unauthenticated } from "../shopify.server";

declare const process: {
  env: Record<string, string | undefined>;
};

type ScheduleRulesRequestBody = {
  sessionToken?: unknown;
  orderId?: unknown;
};

type SessionTokenPayload = {
  aud?: string;
  dest?: string;
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
  // Customer-account extensions call this route from Shopify's CDN origin, so explicit
  // CORS headers are required for the schedule rules request to succeed in the browser.
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

async function parseRequestBody(request: Request): Promise<ScheduleRulesRequestBody> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as ScheduleRulesRequestBody;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formBody = await request.text();
    const searchParams = new URLSearchParams(formBody);

    return {
      sessionToken: searchParams.get("sessionToken"),
      orderId: searchParams.get("orderId"),
    };
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return {
      sessionToken: formData.get("sessionToken"),
      orderId: formData.get("orderId"),
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
  // Verify the session token here so the route only serves schedule rules to a genuine
  // customer-account extension request for this app and shop.
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
    return jsonResponse(request, { ok: false, error: "Method not allowed" }, 405);
  }

  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && !isAllowedOrigin(request)) {
    return jsonResponse(request, { ok: false, error: "Invalid origin" }, 403);
  }

  let body: ScheduleRulesRequestBody;
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
    console.warn("[customer-account schedule-rules] invalid session token:", error);
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  const shop = extractShopFromSessionToken(verifiedSessionToken);
  if (!shop) {
    return jsonResponse(request, { ok: false, error: "Invalid shop context" }, 400);
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    // Return the same server-calculated rules used by other delivery surfaces so the
    // customer-account reschedule UI stays aligned with live capacity and blackout data.
    // excludeOrderId keeps this in parity with the reschedule submit path (which already
    // excludes the order's own current booking, DEF-14) — otherwise a slot this order
    // already occupies can read as "full" here even though picking it back would succeed.
    const rules = await getScheduleRulesWithBookedCounts(shop, admin, {
      excludeOrderId: isNonEmptyString(body.orderId) ? body.orderId : undefined,
    });

    return jsonResponse(request, {
      ok: true,
      rules,
    });
  } catch (error) {
    console.error("[customer-account schedule-rules] failed to load rules:", error);
    return jsonResponse(
      request,
      { ok: false, error: "Failed to load schedule rules" },
      500,
    );
  }
};