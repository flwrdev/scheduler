import { describe, expect, it } from "vitest";

import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  cloneDeliveryScheduleRules,
  getCutoffInstant,
  getSlotLastOrderInstant,
  type DeliveryScheduleRules,
} from "../app/lib/delivery-availability";

// Shop-local wall clock → absolute instant, the inverse of the engine's zoned
// "now" parsing. Feeds `availabilityWindow.cutoffAt` / `slots[*].lastOrderAt`
// on GET /apps/schedule-rules (2026-09-02).

function rules(overrides: Partial<DeliveryScheduleRules> = {}): DeliveryScheduleRules {
  return { ...cloneDeliveryScheduleRules(DEFAULT_DELIVERY_SCHEDULE_RULES), ...overrides };
}

describe("getCutoffInstant", () => {
  it("maps cutoffHour on a shop-local date to the UTC instant (Asia/Manila = UTC+8, no DST)", () => {
    // 17:00 Manila on 2026-09-01 is 09:00Z the same day.
    expect(getCutoffInstant(rules(), "2026-09-01").toISOString()).toBe(
      "2026-09-01T09:00:00.000Z",
    );
    expect(getCutoffInstant(rules({ cutoffHour: 12 }), "2026-12-25").toISOString()).toBe(
      "2026-12-25T04:00:00.000Z",
    );
  });

  it("honours a DST-observing timezone on both sides of the transition", () => {
    const newYork = rules({ timezone: "America/New_York", cutoffHour: 17 });
    // EDT (UTC−4) in July, EST (UTC−5) in January.
    expect(getCutoffInstant(newYork, "2026-07-15").toISOString()).toBe(
      "2026-07-15T21:00:00.000Z",
    );
    expect(getCutoffInstant(newYork, "2026-01-15").toISOString()).toBe(
      "2026-01-15T22:00:00.000Z",
    );
  });
});

describe("getSlotLastOrderInstant", () => {
  it("is slot start minus prepHours, shop-local, as a UTC instant", () => {
    // 12PM Manila = 04:00Z; minus prepHours 1 → 03:00Z.
    expect(
      getSlotLastOrderInstant(rules(), "2026-09-05", "12PM-3PM")?.toISOString(),
    ).toBe("2026-09-05T03:00:00.000Z");
    // 9AM Manila = 01:00Z; minus 1h → 00:00Z.
    expect(
      getSlotLastOrderInstant(rules(), "2026-09-01", "9AM-12PM")?.toISOString(),
    ).toBe("2026-09-01T00:00:00.000Z");
  });

  it("scales with prepHours and crosses midnight backwards when prep exceeds the slot start", () => {
    expect(
      getSlotLastOrderInstant(rules({ prepHours: 3 }), "2026-09-05", "12PM-3PM")?.toISOString(),
    ).toBe("2026-09-05T01:00:00.000Z");
    // 9AM Manila minus 10h = 11PM Manila the previous day = 15:00Z on the 4th.
    expect(
      getSlotLastOrderInstant(rules({ prepHours: 10 }), "2026-09-05", "9AM-12PM")?.toISOString(),
    ).toBe("2026-09-04T15:00:00.000Z");
  });

  it("tolerates minute-bearing and spaced slot values, and returns null for an unparseable start", () => {
    expect(
      getSlotLastOrderInstant(rules(), "2026-09-05", "9:30AM - 12PM")?.toISOString(),
    ).toBe("2026-09-05T00:30:00.000Z");
    expect(getSlotLastOrderInstant(rules(), "2026-09-05", "Morning")).toBeNull();
    expect(getSlotLastOrderInstant(rules(), "2026-09-05", "")).toBeNull();
  });
});
