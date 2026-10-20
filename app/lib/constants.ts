// Shared constants for delivery write paths.
//
// Centralized here so each value has a single source of truth. Previously
// `RESCHEDULED_ORDER_TAG` was duplicated as a string literal in both reschedule
// routes (apps.schedule-rules.reschedule.ts + public.customer-account.reschedule.ts),
// which risked the two diverging silently. Import from here instead.

/**
 * The order tag used as the reschedule lock primitive. Once present on an order,
 * the online (customer-facing) reschedule flow is closed — only one online
 * reschedule is allowed. Removing this tag on the Shopify side re-opens the flow.
 */
export const RESCHEDULED_ORDER_TAG = "resched";
