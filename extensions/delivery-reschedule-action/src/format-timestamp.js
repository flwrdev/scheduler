// Shared timestamp formatting for the two read-only admin order-page
// extensions. This file is a BYTE-IDENTICAL copy of
// extensions/delivery-reschedule-action/src/format-timestamp.js — the two are
// pinned together by test/extension-format-timestamp.test.ts. Extensions are
// separate bundles and cannot import from app/lib, hence the duplication.

/**
 * Render a stored reschedule timestamp for a merchant reading the Shopify
 * order page.
 *
 * The `$app:reschedule_requested_at` metafield holds UTC — e.g.
 * "2026-08-11T20:07:25.285Z". Printing that string raw is how a reschedule
 * made at 4:07 AM Manila came to display as 2026-08-11, i.e. the day BEFORE
 * the order was placed, reading as if the customer had rescheduled before they
 * ordered (prod #4068, found 2026-08-14). Every reschedule between midnight
 * and 8 AM shop time has the same problem.
 *
 * Formatting uses the SHOP's timezone rather than the viewer's: delivery dates
 * and slots are all shop-local, so the timestamp beside them has to be too, and
 * it must not shift for staff working from another country.
 *
 * @param {string | null | undefined} value ISO timestamp from the metafield.
 * @param {string | null | undefined} ianaTimezone e.g. "Asia/Manila".
 * @returns {string} A merchant-readable timestamp, or "" when there is nothing
 *   to show. An unparseable value is returned verbatim rather than hidden.
 */
export function formatRescheduledAt(value, ianaTimezone) {
  if (typeof value !== "string" || !value.trim()) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const base = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };

  try {
    return date.toLocaleString("en-US", ianaTimezone ? { ...base, timeZone: ianaTimezone } : base);
  } catch {
    // An unusable timeZone throws a RangeError. A wrong-zone timestamp still
    // beats a blank field, so fall back to the viewer's own zone.
    return date.toLocaleString("en-US", base);
  }
}
