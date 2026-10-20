// Resource route (GET /app/orders/reschedule-rules): the schedule rules and live booked counts
// the reschedule modal needs. Fetched only when the modal opens so the orders loader does not
// pay for the booked-count query on every page load. Read-only; admin session required.

import type { LoaderFunctionArgs } from "react-router";

import type {
  DeliveryScheduleCapacity,
  DeliveryScheduleSlot,
} from "../lib/delivery-availability";
import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { authenticate } from "../shopify.server";

// Read-only resource route for the /app/orders reschedule modal (Phase 4).
// Fetched lazily (fetcher.load) when the modal opens so the orders loader
// doesn't pay the live booked-count aggregation on every page load. Session
// (embedded admin) auth; no delivery state is written here.
export interface RescheduleRulesData {
  timezone: string;
  slots: DeliveryScheduleSlot[];
  disabledDates: string[];
  disabledSlots: Record<string, string[]>;
  slotCapacity: Record<string, Record<string, DeliveryScheduleCapacity>>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const rules = await getScheduleRulesWithBookedCounts(session.shop, admin);

  return Response.json({
    timezone: rules.timezone,
    slots: rules.slots,
    disabledDates: rules.disabledDates,
    disabledSlots: rules.disabledSlots,
    slotCapacity: rules.slotCapacity,
  } satisfies RescheduleRulesData);
};
