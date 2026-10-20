// Shop-local calendar references for the Orders Ops dated views. ONE
// implementation shared by the loader (which turns them into server-side
// delivery-date tag terms) and the client (which re-filters the page) so the
// two can never disagree about what "tomorrow" or "this week" means.
//
// All arithmetic is UTC over the ISO string: `todayISO` is already the shop's
// calendar day (getShopLocalDate), so no timezone conversion may touch it.

export interface DateRefs {
  todayISO: string;
  yesterdayISO: string;
  tomorrowISO: string;
  /** Sunday of the current calendar week. */
  startWeekISO: string;
  /** Saturday of the current calendar week. */
  endWeekISO: string;
  /** Sunday of the previous calendar week. */
  lastWeekStartISO: string;
  /** Saturday of the previous calendar week (always the day before `startWeekISO`). */
  lastWeekEndISO: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toISO(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function computeDateRefs(todayISO: string): DateRefs {
  if (!ISO_DATE_RE.test(todayISO)) {
    // Never produce "NaN-NaN-NaN" terms: an unusable today collapses every
    // reference onto itself, which filters to nothing instead of everything.
    return {
      todayISO,
      yesterdayISO: todayISO,
      tomorrowISO: todayISO,
      startWeekISO: todayISO,
      endWeekISO: todayISO,
      lastWeekStartISO: todayISO,
      lastWeekEndISO: todayISO,
    };
  }
  const [y, m, d] = todayISO.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const tom = new Date(base);
  tom.setUTCDate(base.getUTCDate() + 1);
  const yest = new Date(base);
  yest.setUTCDate(base.getUTCDate() - 1);
  // "This week" = the current CALENDAR week, Sunday through Saturday. The
  // previous Monday-start window made the tab empty on Sundays for every
  // upcoming delivery (2026-07-12 smoke test: today Sun Jul 12, delivery
  // Sat Jul 18 → excluded from the Mon Jul 6 – Sun Jul 12 window).
  const dow = base.getUTCDay();
  const weekStart = new Date(base);
  weekStart.setUTCDate(base.getUTCDate() - dow);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  // "Last week" is the same Sunday–Saturday shape shifted back seven days, so
  // the two week views tile the calendar with no gap and no overlap.
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setUTCDate(weekStart.getUTCDate() - 7);
  const lastWeekEnd = new Date(weekStart);
  lastWeekEnd.setUTCDate(weekStart.getUTCDate() - 1);
  return {
    todayISO,
    yesterdayISO: toISO(yest),
    tomorrowISO: toISO(tom),
    startWeekISO: toISO(weekStart),
    endWeekISO: toISO(weekEnd),
    lastWeekStartISO: toISO(lastWeekStart),
    lastWeekEndISO: toISO(lastWeekEnd),
  };
}

// A dated view is at most a week; the cap only guards against a malformed
// range turning into a runaway query.
const MAX_ENUMERATED_DAYS = 31;

/** Every `YYYY-MM-DD` from `startISO` to `endISO` inclusive (empty when unusable or reversed). */
export function enumerateISODates(startISO: string, endISO: string): string[] {
  if (!ISO_DATE_RE.test(startISO) || !ISO_DATE_RE.test(endISO)) return [];
  const [sy, sm, sd] = startISO.split("-").map(Number);
  const [ey, em, ed] = endISO.split("-").map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  if (end < start) return [];
  const out: string[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end && out.length < MAX_ENUMERATED_DAYS) {
    out.push(toISO(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
