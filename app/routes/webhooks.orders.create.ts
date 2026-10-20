// orders/create delivery sync. The request is verified by Shopify's webhook
// HMAC (authenticate.webhook) and the sync runs inside it: the delivery
// metafields and the schedule tag are written straight to the Shopify order.
// Nothing is stored in Postgres.
//
// A paid order's delivery data is always written when date+slot are
// parseable; validation only stamps `delivery.sync_status`, and its clock is
// the order's checkout time, never the webhook processing time.
//
// On any failed step the handler answers 500 so Shopify redelivers the
// webhook; every step is idempotent, so a redelivery only fills in what is
// still missing.

import { authenticate } from "../shopify.server";
import {
  extractDeliveryAttributesFromPayload,
  getOrderGidFromPayload,
  resolveOrderCheckoutTime,
} from "../services/order-delivery-metafields.server";
import { syncOrderDelivery } from "../services/order-delivery-sync.server";

export const action = async ({ request }: { request: Request }) => {
  const { admin, payload, shop } = await authenticate.webhook(request);
  const orderPayload = payload as Record<string, unknown>;
  const orderId = getOrderGidFromPayload(orderPayload);
  const { deliveryDate, timeSlot } =
    extractDeliveryAttributesFromPayload(orderPayload);

  console.log("[orders/create] webhook received.");

  // An order with no delivery date and slot has nothing to write, so we stop here.
  if (!orderId || !deliveryDate || !timeSlot) {
    console.log(
      "[orders/create] delivery sync skipped: missing required delivery attributes.",
    );
    return new Response();
  }

  // No offline session means the app is uninstalled; a redelivery cannot help.
  if (!admin) {
    console.warn(`[orders/create] no offline session for ${shop}; sync skipped for ${orderId}.`);
    return new Response();
  }

  const result = await syncOrderDelivery(admin, {
    shop,
    orderId,
    deliveryDate,
    timeSlot,
    checkoutTime: resolveOrderCheckoutTime(orderPayload),
  });

  if (!result.ok) {
    console.warn(
      `[orders/create] sync incomplete for ${orderId} (${result.errors.join(" | ")}); asking Shopify to redeliver.`,
    );
    return new Response(null, { status: 500 });
  }

  console.log(`[orders/create] ${orderId}: synced.`);
  return new Response();
};
