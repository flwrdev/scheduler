// What happens to a new order's delivery data (called by the orders/create webhook): loads the
// schedule rules, evaluates the chosen date and slot, and writes the metafields and the schedule
// tag. Every step is idempotent, so Shopify can safely redeliver the webhook.

import {
  type AdminGraphQLClient,
  evaluateDeliverySyncStatus,
  syncOrderDeliveryMetafields,
  syncOrderDeliveryScheduleTag,
} from "./order-delivery-metafields.server";
import { getScheduleRulesDetailed } from "./schedule-rules.server";

export interface OrderDeliverySyncInput {
  shop: string;
  orderId: string;
  deliveryDate: string | null;
  timeSlot: string | null;
  checkoutTime: Date;
}

export interface OrderDeliverySyncResult {
  ok: boolean;
  errors: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Every step is idempotent on the Shopify side (metafieldsSet overwrites,
// tagsAdd skips existing tags), so a Shopify webhook redelivery can safely re-run it.
export async function syncOrderDelivery(
  admin: AdminGraphQLClient,
  input: OrderDeliverySyncInput,
): Promise<OrderDeliverySyncResult> {
  const errors: string[] = [];
  const { deliveryDate, timeSlot } = input;

  if (deliveryDate && timeSlot) {
    try {
      // The order is excluded from the counts so a redelivery, whose
      // `custom.date` may already be written, never counts against its own slot.
      const { rules, countsMeta } = await getScheduleRulesDetailed(input.shop, admin, {
        excludeOrderId: input.orderId,
      });
      if (countsMeta.status === "error" || countsMeta.status === "partial") {
        console.warn(
          `[delivery-sync] booked counts ${countsMeta.status}; capacity check ran fail-open for ${input.orderId}.`,
        );
      }
      const syncStatus = evaluateDeliverySyncStatus(
        rules,
        deliveryDate,
        timeSlot,
        input.checkoutTime,
      );
      if (syncStatus !== "ok") {
        console.warn(
          `[delivery-sync] ${input.orderId} needs attention (${syncStatus}); syncing anyway.`,
        );
      }
      const result = await syncOrderDeliveryMetafields(admin, {
        orderId: input.orderId,
        deliveryDate,
        timeSlot,
        syncStatus,
      });
      if (!result.ok) {
        errors.push(`metafields: ${result.errors.join("; ") || "sync failed"}`);
      }
    } catch (error) {
      errors.push(`metafields: ${errorMessage(error)}`);
    }

    try {
      const tagResult = await syncOrderDeliveryScheduleTag(admin, {
        orderId: input.orderId,
        deliveryDate,
        timeSlot,
      });
      if (!tagResult.ok) {
        errors.push(`tags: ${tagResult.errors.join("; ") || "sync failed"}`);
      }
    } catch (error) {
      errors.push(`tags: ${errorMessage(error)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
