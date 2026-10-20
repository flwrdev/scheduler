import { describe, expect, it } from "vitest";

import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  type DeliveryScheduleRules,
} from "../app/lib/delivery-availability";
import {
  normalizeSlotValueForMatch,
  resolveConfiguredSlotValue,
  slotValuesMatch,
} from "../app/lib/slot-value";

// §4.2 canonical comparator: comparison is tolerant, stored values stay verbatim.

describe("normalizeSlotValueForMatch", () => {
  it("collapses case, spacing, and :00 minutes for time-range values", () => {
    for (const variant of [
      "9AM-12PM",
      "9am-12pm",
      "9AM - 12PM",
      " 9:00AM -  12:00PM ",
      "9:00am-12:00pm",
    ]) {
      expect(normalizeSlotValueForMatch(variant)).toBe("9AM-12PM");
    }
  });

  it("keeps non-zero minutes distinct", () => {
    expect(normalizeSlotValueForMatch("9:30AM - 12PM")).toBe("9:30AM-12PM");
    expect(normalizeSlotValueForMatch("9:30AM-12PM")).not.toBe(
      normalizeSlotValueForMatch("9AM-12PM"),
    );
  });

  it("still folds case/whitespace for non-range legacy values", () => {
    expect(normalizeSlotValueForMatch(" morning rush ")).toBe("MORNINGRUSH");
  });

  it("returns empty string for null/undefined/blank", () => {
    expect(normalizeSlotValueForMatch(null)).toBe("");
    expect(normalizeSlotValueForMatch(undefined)).toBe("");
    expect(normalizeSlotValueForMatch("   ")).toBe("");
  });

  it("round-trips every default slot value to itself", () => {
    for (const slot of DEFAULT_DELIVERY_SCHEDULE_RULES.slots) {
      expect(normalizeSlotValueForMatch(slot.value)).toBe(slot.value);
    }
  });
});

describe("slotValuesMatch", () => {
  it("matches tolerant variants and rejects different slots", () => {
    expect(slotValuesMatch("9AM-12PM", "9:00am - 12:00pm")).toBe(true);
    expect(slotValuesMatch("9AM-12PM", "12PM-3PM")).toBe(false);
  });

  it("never matches on empty values", () => {
    expect(slotValuesMatch("", "")).toBe(false);
    expect(slotValuesMatch(null, null)).toBe(false);
  });
});

describe("resolveConfiguredSlotValue", () => {
  const rules: DeliveryScheduleRules = {
    ...DEFAULT_DELIVERY_SCHEDULE_RULES,
    slots: [
      { display: "Morning", value: "9AM-12PM" },
      { display: "Evening", value: "6pm - 11pm" },
    ],
  };

  it("returns the CONFIGURED value verbatim, not the raw input", () => {
    expect(resolveConfiguredSlotValue(rules, "9:00AM - 12:00PM")).toBe("9AM-12PM");
    // Configured value with its own quirky spelling is preserved as stored.
    expect(resolveConfiguredSlotValue(rules, "6PM-11PM")).toBe("6pm - 11pm");
  });

  it("returns null for unknown or blank values", () => {
    expect(resolveConfiguredSlotValue(rules, "morning")).toBeNull();
    expect(resolveConfiguredSlotValue(rules, "")).toBeNull();
    expect(resolveConfiguredSlotValue(rules, undefined)).toBeNull();
  });
});
