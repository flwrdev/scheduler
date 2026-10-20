// The order-tag vocabulary — one module that owns every tag this app writes,
// reads, or reasons about.
//
// Before this existed the knowledge was spread across four files:
// `delivery-availability.ts` (buildDeliveryTags / isDeliveryScheduleTag),
// `order-delivery-metafields.server.ts` (the sync + its removal pattern),
// `constants.ts` (the reschedule lock), and `order-utils.ts` (display + hiding).
// Adding a tag meant knowing all four. New tags go here.
//
// ── Two hard constraints, both measured live on 2026-08-14 ───────────────────
//
// 1. A Shopify order tag is capped at 40 CHARACTERS. 41 is rejected with the
//    unhelpful "Order tags is invalid" — and the rejection fails the WHOLE
//    `tagsAdd` call, so one over-length tag silently takes every other tag in
//    the same batch down with it. (`MAX_TAG_LENGTH` in app.orders.tsx said 255
//    until this module landed.)
//
// 2. `syncOrderDeliveryScheduleTag` REMOVES prior delivery-schedule tags on
//    every reschedule, and `isDeliveryScheduleTag` matches a bare ISO date
//    (`2026-08-14`), a bare slot (`9AM-12PM`), and anything starting
//    `delivery:` / `delivery date:` / `delivery time:`. An event tag shaped
//    like any of those would be deleted by the next reschedule, with no error.
//    `assertEventTagsSurviveScheduleSync` in the test suite pins this.
//
// ── What is deliberately NOT changed ─────────────────────────────────────────
//
// The existing date and slot tags keep their bare shapes. They sit on thousands
// of live orders, the `resched` lock is matched exactly by both reschedule
// routes, and merchant-saved admin views filter on them. Re-shaping them is a
// migration, not a cleanup.

import { RESCHEDULED_ORDER_TAG } from "./constants";

/** Shopify's hard per-tag limit. Live-verified: 40 passes, 41 is rejected. */
export const MAX_ORDER_TAG_LENGTH = 40;

/**
 * Event tags — the merchant-facing timeline. Each is `<prefix>-<YYYY-MM-DD>`,
 * where the date is the SHOP-LOCAL day the event happened.
 *
 * The date lives inside the tag because Shopify tags carry no timestamp and no
 * ordering. It also means the timeline is readable straight from the Tags
 * column of the orders list, without opening each order — which the admin's own
 * Timeline feed cannot do.
 *
 * Consequence of that same design: two events of one kind on one day collapse
 * into a single tag. `delivery.reschedule_history` remains the precise audit
 * trail (it carries from/to, an exact timestamp, and the source).
 */
export const ORDER_EVENT_TAGS = {
  /** Delivery date or slot changed — written by both reschedule paths. */
  reschedule: "resched",
  /** Shipping address or receiver phone changed — the `editDetails` op. */
  addressEdited: "addr",
  /** Fulfilled with a tracking number or URL — the `markFulfilled` op. */
  trackingAdded: "tracked",
} as const;

export type OrderEventName = keyof typeof ORDER_EVENT_TAGS;

const PREFIX_TO_EVENT = new Map<string, OrderEventName>(
  (Object.entries(ORDER_EVENT_TAGS) as Array<[OrderEventName, string]>).map(
    ([event, prefix]) => [prefix, event],
  ),
);

const EVENT_TAG_PATTERN = /^([a-z]+)-(\d{4}-\d{2}-\d{2})$/;

const EVENT_LABELS: Record<OrderEventName, string> = {
  reschedule: "Rescheduled",
  addressEdited: "Address edited",
  trackingAdded: "Tracking added",
};

export interface ParsedOrderEventTag {
  event: OrderEventName;
  /** Shop-local `YYYY-MM-DD` the event happened. */
  date: string;
}

/**
 * Build the event tag for `event` on `shopLocalDate`.
 *
 * `shopLocalDate` must already be a shop-local `YYYY-MM-DD` — resolve it with
 * `getShopLocalDate(rules.timezone)`. Passing a UTC date here is the bug that
 * made a 4:07 AM Manila reschedule display as the previous day
 * (see the 2026-08-14 verification-log entry).
 *
 * Returns "" for an unusable date rather than writing a malformed tag.
 */
export function buildOrderEventTag(
  event: OrderEventName,
  shopLocalDate: string,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shopLocalDate)) return "";
  const tag = `${ORDER_EVENT_TAGS[event]}-${shopLocalDate}`;
  // Every prefix here is far short of the cap; this guard exists so a future
  // longer prefix fails loudly in tests rather than silently killing the batch.
  return tag.length <= MAX_ORDER_TAG_LENGTH ? tag : "";
}

/**
 * Parse an event tag. Returns null for anything else — including the bare
 * `resched` LOCK tag, which shares the reschedule prefix but is a different
 * thing: it gates the customer's one online reschedule and is matched exactly
 * by both reschedule routes.
 */
export function parseOrderEventTag(
  tag: string | null | undefined,
): ParsedOrderEventTag | null {
  const value = typeof tag === "string" ? tag.trim().toLowerCase() : "";
  if (!value || value === RESCHEDULED_ORDER_TAG) return null;

  const match = EVENT_TAG_PATTERN.exec(value);
  if (!match) return null;

  const event = PREFIX_TO_EVENT.get(match[1]);
  if (!event) return null;

  return { event, date: match[2] };
}

export function isOrderEventTag(tag: string | null | undefined): boolean {
  return parseOrderEventTag(tag) !== null;
}

/**
 * Merchant-readable label for an event tag, e.g. "Rescheduled · Aug 14".
 * Returns null when the tag is not one of ours, so callers can fall through to
 * their existing display logic.
 */
export function orderEventTagLabel(tag: string | null | undefined): string | null {
  const parsed = parseOrderEventTag(tag);
  if (!parsed) return null;

  const [year, month, day] = parsed.date.split("-").map(Number);
  // Built in UTC purely to format the calendar date already resolved above —
  // no timezone conversion happens here, so the day cannot shift.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return EVENT_LABELS[parsed.event];

  const label = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${EVENT_LABELS[parsed.event]} · ${label}`;
}

const ISO_DATE_TAG_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Orders-search term selecting orders whose bare delivery-date tag
 * (`YYYY-MM-DD`) is one of `dates`. Tag search is exact-match, which is why
 * this works where metafield terms are ignored (the dated Orders Ops views
 * used to rely on a 250-newest window and lost old pre-orders, 2026-09-04).
 * Returns "" when nothing is usable so the caller sends no date term; an OR
 * of several days is parenthesised so it ANDs cleanly with status terms.
 */
export function buildDeliveryDateTagQuery(dates: ReadonlyArray<string>): string {
  const terms = Array.from(
    new Set(dates.filter((d) => ISO_DATE_TAG_RE.test(d))),
  ).map((d) => `tag:${d}`);
  if (terms.length === 0) return "";
  return terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`;
}
