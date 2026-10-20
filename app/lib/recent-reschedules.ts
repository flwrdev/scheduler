// Pure helpers behind two Orders page surfaces:
//   · the reschedule rows in the Notifications bell (reschedules the merchant
//     has not yet marked Seen, up to 48 hours old), and
//   · the row/panel badge that carries the reschedule time.
// Everything here is shop-local: the loader passes the shop timezone and its
// own todayISO, so a VA on a non-Manila machine reads the same labels as the merchant.

import { getShopLocalDate } from "./delivery-availability";
import { buildOrderEventTag } from "./order-tags";
import {
  type Order,
  type RescheduleTimelineEvent,
  getCustomerName,
  getRescheduleTimelineEvents,
} from "./order-utils";

export const RECENT_RESCHEDULE_WINDOW_MS = 48 * 60 * 60 * 1000;

// Three shop-local days of `resched-<day>` tags, not two: the 48-hour window
// straddles the shop-day boundary (at 10 AM, 48 h ago is 10 AM two days back).
export const RECENT_RESCHEDULE_TAG_DAYS = 3;

/**
 * Shopify orders-search string for the recent-reschedules loader query. Tag search is
 * the only server-side handle available — metafield terms are ignored by the
 * orders search — and the event tag is stamped on BOTH reschedule paths. The
 * exact window, the source filter, and the Seen marker are applied afterwards
 * by `selectRecentReschedules`.
 */
export function buildRecentRescheduleTagQuery(
  todayISO: string,
  days: number = RECENT_RESCHEDULE_TAG_DAYS,
): string {
  const terms: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const tag = buildOrderEventTag("reschedule", shiftISODate(todayISO, -i));
    if (tag) terms.push(`tag:${tag}`);
  }
  return terms.join(" OR ");
}

/**
 * The full orders-search string the recent-reschedules loader query sends: the
 * event-tag OR plus `-status:closed`, so archived orders are left out.
 */
export function buildRecentRescheduleSearchQuery(
  todayISO: string,
  days: number = RECENT_RESCHEDULE_TAG_DAYS,
): string {
  const tags = buildRecentRescheduleTagQuery(todayISO, days);
  return tags ? `(${tags}) -status:closed` : "";
}

// Reschedule sources that are listed: customer and merchant moves.
// The `sources` option can narrow this list.
export const RECENT_RESCHEDULE_SOURCES: ReadonlyArray<string> = [
  "customer",
  "merchant",
];

export interface RecentRescheduleItem {
  orderId: string;
  /** Numeric Shopify id — what the page's `?order=` param keys off. */
  legacyId: string;
  name: string;
  customerName: string;
  /** e.g. "Fri, Sep 4 9AM-12PM" */
  from: string;
  /** e.g. "Mon, Sep 28 9AM-12PM" */
  to: string;
  requestedAt: string;
  source: string;
  /** Shop-local: "Today" | "Yesterday" | "Sep 2" */
  dayLabel: string;
  /** Shop-local clock time, e.g. "8:47 AM" */
  timeLabel: string;
}

export interface ShopLocalContext {
  todayISO: string;
  timezone: string;
}

export interface SelectRecentReschedulesOptions extends ShopLocalContext {
  now?: Date;
  windowMs?: number;
  sources?: ReadonlyArray<string>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shift a `YYYY-MM-DD` string by whole days with UTC arithmetic (no zone drift). */
export function shiftISODate(iso: string, days: number): string {
  if (!ISO_DATE_RE.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** "Sep 4" from "2026-09-04" — no weekday, for compact badges. */
export function formatShortMonthDay(iso: string): string {
  if (!ISO_DATE_RE.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Fri, Sep 4" from "2026-09-04" — the from/to dates of a reschedule. */
export function formatWeekdayMonthDay(iso: string): string {
  if (!ISO_DATE_RE.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatShopLocalTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return date.toLocaleTimeString("en-US", { ...options, timeZone: timezone });
  } catch {
    // An invalid stored timezone must cost the zone, not the label.
    return date.toLocaleTimeString("en-US", options);
  }
}

function formatDelivery(date: string, slot: string): string {
  const dateLabel = date && date !== "—" ? formatWeekdayMonthDay(date) : "";
  const slotLabel = slot && slot !== "—" ? slot : "";
  return [dateLabel, slotLabel].filter(Boolean).join(" ") || "—";
}

/** The newest reschedule event with a parseable timestamp, or null. */
export function latestRescheduleEvent(order: Order): RescheduleTimelineEvent | null {
  // getRescheduleTimelineEvents sorts newest-first and sinks unparseable
  // timestamps to the bottom, so the first parseable entry is the latest.
  for (const event of getRescheduleTimelineEvents(order)) {
    if (!Number.isNaN(Date.parse(event.requestedAt))) return event;
  }
  return null;
}

function dayLabelFor(
  eventDateISO: string,
  { todayISO }: Pick<ShopLocalContext, "todayISO">,
): string {
  if (eventDateISO === todayISO) return "Today";
  if (eventDateISO === shiftISODate(todayISO, -1)) return "Yesterday";
  return formatShortMonthDay(eventDateISO);
}

export function selectRecentReschedules(
  orders: ReadonlyArray<Order>,
  options: SelectRecentReschedulesOptions,
): RecentRescheduleItem[] {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const windowMs = options.windowMs ?? RECENT_RESCHEDULE_WINDOW_MS;
  const sources = options.sources ?? RECENT_RESCHEDULE_SOURCES;

  const items: Array<{ ts: number; item: RecentRescheduleItem }> = [];
  for (const order of orders) {
    const event = latestRescheduleEvent(order);
    if (!event) continue;
    if (event.status.trim().toLowerCase() !== "confirmed") continue;
    if (!sources.includes(event.source.trim().toLowerCase())) continue;

    const ts = Date.parse(event.requestedAt);
    if (nowMs - ts > windowMs) continue;

    // Seen = the merchant acknowledged THIS event (or a later one). An older
    // acknowledgement must not hide a fresh reschedule of the same order.
    const seenValue = order.rescheduleSeenAt?.value;
    const seenTs = seenValue ? Date.parse(seenValue) : Number.NaN;
    if (!Number.isNaN(seenTs) && seenTs >= ts) continue;

    const eventDateISO = getShopLocalDate(options.timezone, new Date(ts));
    const legacyId =
      order.legacyResourceId?.trim() || order.id.split("/").pop() || order.id;
    items.push({
      ts,
      item: {
        orderId: order.id,
        legacyId,
        name: order.name,
        customerName: getCustomerName(order),
        from: formatDelivery(event.fromDate, event.fromTimeSlot),
        to: formatDelivery(event.date, event.timeSlot),
        requestedAt: new Date(ts).toISOString(),
        source: event.source,
        dayLabel: dayLabelFor(eventDateISO, options),
        timeLabel: formatShopLocalTime(event.requestedAt, options.timezone),
      },
    });
  }

  items.sort((a, b) => b.ts - a.ts);
  return items.map((entry) => entry.item);
}

/**
 * "Rescheduled · 8:47 AM" when the latest reschedule happened today
 * (shop-local), otherwise "Rescheduled · Sep 3, 5:09 PM". Null when the order
 * has no timestamped reschedule — callers fall back to the plain label.
 */
export function rescheduleBadgeLabel(
  order: Order,
  context: ShopLocalContext,
): string | null {
  const event = latestRescheduleEvent(order);
  if (!event) return null;
  const when = new Date(event.requestedAt);
  const time = formatShopLocalTime(event.requestedAt, context.timezone);
  if (!time) return null;
  const eventDateISO = getShopLocalDate(context.timezone, when);
  return eventDateISO === context.todayISO
    ? `Rescheduled · ${time}`
    : `Rescheduled · ${formatShortMonthDay(eventDateISO)}, ${time}`;
}
