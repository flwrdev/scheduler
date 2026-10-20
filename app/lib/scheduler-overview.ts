// Overview aggregations for the merged /app/scheduler page (Scheduler V2 §3).
// Pure reimplementation of the old app/modules/scheduler.server.js dashboard
// math — same statuses and ordering, no data fetching here.

import type { DeliveryScheduleRules } from "./delivery-availability";

export interface CapacityStatus {
  label: "Full" | "Filling fast" | "Tracking" | "Closed" | "Open";
  tone: "critical" | "warning" | "success" | "info";
  rank: number;
}

export interface CapacityEntry {
  date: string;
  slotValue: string;
  capacity: number;
  booked: number;
  remaining: number;
  utilizationPercent: number;
  status: CapacityStatus;
}

export interface SchedulerOverview {
  slotCount: number;
  upcomingBlockedDates: string[];
  blockedDateCount: number;
  blockedSlotCount: number;
  trackedCapacityDayCount: number;
  fullCount: number;
  nearLimitCount: number;
  watchlist: CapacityEntry[];
}

export function getCapacityStatus(
  capacity: number,
  booked: number,
): CapacityStatus {
  if (capacity <= 0) {
    return { label: "Closed", tone: "info", rank: 3 };
  }
  if (booked >= capacity) {
    return { label: "Full", tone: "critical", rank: 0 };
  }
  if (booked / capacity >= 0.8) {
    return { label: "Filling fast", tone: "warning", rank: 1 };
  }
  if (booked > 0) {
    return { label: "Tracking", tone: "success", rank: 2 };
  }
  return { label: "Open", tone: "success", rank: 4 };
}

export function buildCapacityEntries(
  rules: DeliveryScheduleRules,
  today: string,
): CapacityEntry[] {
  const entries: CapacityEntry[] = [];
  for (const [date, capacities] of Object.entries(rules.slotCapacity)) {
    if (date < today) {
      continue;
    }
    for (const [slotValue, { capacity, booked }] of Object.entries(
      capacities,
    )) {
      entries.push({
        date,
        slotValue,
        capacity,
        booked,
        remaining: Math.max(capacity - booked, 0),
        utilizationPercent:
          capacity > 0
            ? Math.min(100, Math.round((booked / capacity) * 100))
            : 100,
        status: getCapacityStatus(capacity, booked),
      });
    }
  }

  entries.sort(
    (a, b) =>
      a.status.rank - b.status.rank ||
      a.date.localeCompare(b.date) ||
      b.utilizationPercent - a.utilizationPercent ||
      a.slotValue.localeCompare(b.slotValue),
  );
  return entries;
}

export function buildSchedulerOverview(
  rules: DeliveryScheduleRules,
  today: string,
): SchedulerOverview {
  const capacityEntries = buildCapacityEntries(rules, today);
  const upcomingBlockedDates = rules.disabledDates
    .filter((date) => date >= today)
    .sort();
  const blockedSlotCount = Object.entries(rules.disabledSlots)
    .filter(([date]) => date >= today)
    .reduce((total, [, slots]) => total + slots.length, 0);

  return {
    slotCount: rules.slots.length,
    upcomingBlockedDates,
    blockedDateCount: upcomingBlockedDates.length,
    blockedSlotCount,
    trackedCapacityDayCount: new Set(capacityEntries.map((e) => e.date)).size,
    fullCount: capacityEntries.filter((e) => e.status.label === "Full").length,
    nearLimitCount: capacityEntries.filter(
      (e) => e.status.label === "Filling fast",
    ).length,
    watchlist: capacityEntries.slice(0, 6),
  };
}

/** Dates (>= today) that carry any override, for the "Upcoming overrides" list. */
export interface DayOverrideSummary {
  date: string;
  blocked: boolean;
  blockedSlots: string[];
  capacities: Array<{ slotValue: string; capacity: number; booked: number }>;
}

export function buildUpcomingOverrides(
  rules: DeliveryScheduleRules,
  today: string,
  limit = 10,
): DayOverrideSummary[] {
  const dates = new Set<string>();
  for (const date of rules.disabledDates) dates.add(date);
  for (const date of Object.keys(rules.disabledSlots)) dates.add(date);
  for (const date of Object.keys(rules.slotCapacity)) dates.add(date);

  return [...dates]
    .filter((date) => date >= today)
    .sort()
    .slice(0, limit)
    .map((date) => ({
      date,
      blocked: rules.disabledDates.includes(date),
      blockedSlots: rules.disabledSlots[date] ?? [],
      capacities: Object.entries(rules.slotCapacity[date] ?? {}).map(
        ([slotValue, { capacity, booked }]) => ({ slotValue, capacity, booked }),
      ),
    }));
}
