import { describe, expect, it } from "vitest";

import { DEFAULT_DELIVERY_SCHEDULE_RULES } from "../app/lib/delivery-availability";
import {
  formatSlotTimePart,
  generateSlotValue,
  isSlotRangeOrdered,
  parseSlotValueToTimes,
  slotTimePartToMinutes,
} from "../app/lib/slot-times";

describe("parseSlotValueToTimes", () => {
  it("parses every frozen default slot value", () => {
    for (const slot of DEFAULT_DELIVERY_SCHEDULE_RULES.slots) {
      expect(parseSlotValueToTimes(slot.value)).not.toBeNull();
    }
  });

  it("parses minute-bearing and space/case variants", () => {
    expect(parseSlotValueToTimes("9:30AM-12PM")).toEqual({
      start: { hour: 9, minute: 30, meridiem: "AM" },
      end: { hour: 12, minute: 0, meridiem: "PM" },
    });
    expect(parseSlotValueToTimes("9am - 12pm")).toEqual({
      start: { hour: 9, minute: 0, meridiem: "AM" },
      end: { hour: 12, minute: 0, meridiem: "PM" },
    });
  });

  it("returns null for the DEF-1 victim shapes (unparseable legacy values)", () => {
    expect(parseSlotValueToTimes("Morning")).toBeNull();
    expect(parseSlotValueToTimes("9-12")).toBeNull();
    expect(parseSlotValueToTimes("9AM-12PM-3PM")).toBeNull();
    expect(parseSlotValueToTimes("13PM-2PM")).toBeNull();
    expect(parseSlotValueToTimes("9:75AM-12PM")).toBeNull();
    expect(parseSlotValueToTimes("")).toBeNull();
  });
});

describe("generateSlotValue", () => {
  it("round-trips every frozen default value byte-identically", () => {
    for (const slot of DEFAULT_DELIVERY_SCHEDULE_RULES.slots) {
      const parsed = parseSlotValueToTimes(slot.value);
      expect(parsed).not.toBeNull();
      expect(generateSlotValue(parsed!)).toBe(slot.value);
    }
  });

  it("canonicalizes tolerant input into the frozen wire format", () => {
    expect(generateSlotValue(parseSlotValueToTimes("9am - 12pm")!)).toBe(
      "9AM-12PM",
    );
  });

  it("keeps minutes with a two-digit pad", () => {
    expect(
      generateSlotValue({
        start: { hour: 9, minute: 5, meridiem: "AM" },
        end: { hour: 1, minute: 30, meridiem: "PM" },
      }),
    ).toBe("9:05AM-1:30PM");
  });

  it("its output survives its own parse (generator/parser agreement)", () => {
    const range = {
      start: { hour: 12, minute: 0, meridiem: "AM" as const },
      end: { hour: 12, minute: 45, meridiem: "PM" as const },
    };
    expect(parseSlotValueToTimes(generateSlotValue(range))).toEqual(range);
  });
});

describe("slotTimePartToMinutes / isSlotRangeOrdered", () => {
  it("maps the 12 o'clock edges correctly", () => {
    expect(
      slotTimePartToMinutes({ hour: 12, minute: 0, meridiem: "AM" }, "start"),
    ).toBe(0);
    expect(
      slotTimePartToMinutes({ hour: 12, minute: 0, meridiem: "AM" }, "end"),
    ).toBe(1440);
    expect(
      slotTimePartToMinutes({ hour: 12, minute: 0, meridiem: "PM" }, "start"),
    ).toBe(720);
    expect(
      slotTimePartToMinutes({ hour: 12, minute: 0, meridiem: "PM" }, "end"),
    ).toBe(720);
  });

  it("accepts windows that end at midnight", () => {
    const midnight = { hour: 12, minute: 0, meridiem: "AM" as const };
    expect(
      isSlotRangeOrdered({
        start: { hour: 8, minute: 0, meridiem: "PM" },
        end: midnight,
      }),
    ).toBe(true);
    expect(
      isSlotRangeOrdered({
        start: { hour: 11, minute: 30, meridiem: "PM" },
        end: midnight,
      }),
    ).toBe(true);
    expect(
      generateSlotValue({
        start: { hour: 8, minute: 0, meridiem: "PM" },
        end: midnight,
      }),
    ).toBe("8PM-12AM");
  });

  it("rejects zero-length and inverted ranges", () => {
    const nineAm = { hour: 9, minute: 0, meridiem: "AM" as const };
    expect(isSlotRangeOrdered({ start: nineAm, end: nineAm })).toBe(false);
    expect(
      isSlotRangeOrdered({
        start: { hour: 3, minute: 0, meridiem: "PM" },
        end: { hour: 9, minute: 0, meridiem: "AM" },
      }),
    ).toBe(false);
    expect(
      isSlotRangeOrdered({
        start: nineAm,
        end: { hour: 12, minute: 0, meridiem: "PM" },
      }),
    ).toBe(true);
  });

  it("formats parts without minutes when zero", () => {
    expect(formatSlotTimePart({ hour: 6, minute: 0, meridiem: "PM" })).toBe(
      "6PM",
    );
  });
});
