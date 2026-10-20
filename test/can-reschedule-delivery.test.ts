import { describe, expect, it } from "vitest";

import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  canRescheduleDelivery,
  cloneDeliveryScheduleRules,
} from "../app/lib/delivery-availability";

// Asia/Manila is UTC+8. cutoffHour on the default rules is 17 (5PM Manila).
const MANILA_BEFORE_CUTOFF = new Date("2026-07-31T02:00:00Z"); // 10:00 AM Manila, Jul 31
const MANILA_AFTER_CUTOFF = new Date("2026-07-31T10:00:00Z"); // 6:00 PM Manila, Jul 31

const rules = cloneDeliveryScheduleRules(DEFAULT_DELIVERY_SCHEDULE_RULES);

describe("canRescheduleDelivery (config-driven cutoff)", () => {
  it("allows rescheduling when the current delivery date is still bookable (same day, before cutoff)", () => {
    expect(canRescheduleDelivery("2026-07-31", MANILA_BEFORE_CUTOFF, rules)).toBe(
      true,
    );
  });

  it("blocks rescheduling a same-day delivery after the cutoff hour", () => {
    expect(canRescheduleDelivery("2026-07-31", MANILA_AFTER_CUTOFF, rules)).toBe(
      false,
    );
  });

  it("allows rescheduling a next-day delivery even after the cutoff hour", () => {
    expect(canRescheduleDelivery("2026-08-01", MANILA_AFTER_CUTOFF, rules)).toBe(
      true,
    );
  });

  it("blocks rescheduling when the delivery date has already passed", () => {
    expect(canRescheduleDelivery("2026-07-30", MANILA_BEFORE_CUTOFF, rules)).toBe(
      false,
    );
  });

  it("blocks rescheduling for a non-ISO delivery date", () => {
    expect(
      canRescheduleDelivery("July 31, 2026", MANILA_BEFORE_CUTOFF, rules),
    ).toBe(false);
  });

  it("respects a later cutoff hour from the shop's configured rules", () => {
    const lateCutoff = { ...rules, cutoffHour: 20 };
    expect(
      canRescheduleDelivery("2026-07-31", MANILA_AFTER_CUTOFF, lateCutoff),
    ).toBe(true);
  });
});

// 2026-09-04: the day-level cutoff alone let a 9AM-12PM booking be moved at
// 8:47 AM on delivery day (order #4292). With the current slot supplied, the
// gate also closes at slot start minus prepHours — the storefront's own
// "last order" instant for that slot.
describe("canRescheduleDelivery (slot-level allowance)", () => {
  const JUL31_0730_MANILA = new Date("2026-07-30T23:30:00Z");
  const JUL31_0847_MANILA = new Date("2026-07-31T00:47:00Z");
  const JUL31_1400_MANILA = new Date("2026-07-31T06:00:00Z");

  it("still allows a same-day 9AM-12PM booking before its prep window starts", () => {
    expect(
      canRescheduleDelivery("2026-07-31", JUL31_0730_MANILA, rules, "9AM-12PM"),
    ).toBe(true);
  });

  it("locks a same-day 9AM-12PM booking once slot start minus prepHours has passed", () => {
    expect(
      canRescheduleDelivery("2026-07-31", JUL31_0847_MANILA, rules, "9AM-12PM"),
    ).toBe(false);
  });

  it("keeps a later same-day slot movable until ITS prep window", () => {
    expect(
      canRescheduleDelivery("2026-07-31", JUL31_0847_MANILA, rules, "3PM-6PM"),
    ).toBe(true);
    expect(
      canRescheduleDelivery("2026-07-31", JUL31_1400_MANILA, rules, "3PM-6PM"),
    ).toBe(false);
  });

  it("does not touch next-day bookings", () => {
    expect(
      canRescheduleDelivery("2026-08-01", JUL31_0847_MANILA, rules, "9AM-12PM"),
    ).toBe(true);
  });

  it("falls back to the day-level answer for an unparseable slot", () => {
    expect(
      canRescheduleDelivery("2026-07-31", JUL31_0847_MANILA, rules, "Anytime"),
    ).toBe(true);
    expect(
      canRescheduleDelivery("2026-07-31", MANILA_AFTER_CUTOFF, rules, "Anytime"),
    ).toBe(false);
  });

  it("scales the allowance with the shop's prepHours", () => {
    const longerPrep = { ...rules, prepHours: 2 };
    expect(
      canRescheduleDelivery("2026-07-31", JUL31_0730_MANILA, longerPrep, "9AM-12PM"),
    ).toBe(false);
  });

  it("behaves exactly as before when no slot is supplied", () => {
    expect(canRescheduleDelivery("2026-07-31", JUL31_0847_MANILA, rules)).toBe(true);
  });
});
