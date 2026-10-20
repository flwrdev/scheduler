import { describe, expect, it } from "vitest";

import {
  validateMerchantRescheduleSelection,
  type DeliveryScheduleRules,
} from "../app/lib/delivery-availability";

// §5 validation matrix (locked 2026-07-11): merchant reschedule is an
// administrative override — only data-integrity checks bind it. These tests
// pin both halves: the hard checks AND the deliberate absence of the
// customer-facing date-window / capacity gates.

const rules: DeliveryScheduleRules = {
  timezone: "Asia/Manila",
  cutoffHour: 17,
  prepHours: 1,
  maxDays: 25,
  slots: [
    { display: "9AM-12PM", value: "9AM-12PM" },
    { display: "3PM-6PM", value: "3PM-6PM" },
  ],
  disabledDates: ["2026-07-21"],
  disabledSlots: { "2026-07-22": ["3PM-6PM"] },
  slotCapacity: {
    "2026-07-20": { "3PM-6PM": { capacity: 5, booked: 5 } },
  },
};

describe("validateMerchantRescheduleSelection — hard data-integrity checks", () => {
  it("rejects a malformed date", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "07/20/2026",
      "3PM-6PM",
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_date" });
  });

  it("rejects a slot that is not configured", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-20",
      "6PM-11PM",
    );
    expect(result).toMatchObject({ ok: false, code: "slot_unknown" });
  });

  it("rejects a blocked date", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-21",
      "3PM-6PM",
    );
    expect(result).toMatchObject({ ok: false, code: "date_blocked" });
  });

  it("rejects a blocked slot on its blocked date only", () => {
    expect(
      validateMerchantRescheduleSelection(rules, "2026-07-22", "3PM-6PM"),
    ).toMatchObject({ ok: false, code: "slot_blocked" });
    expect(
      validateMerchantRescheduleSelection(rules, "2026-07-22", "9AM-12PM").ok,
    ).toBe(true);
  });
});

describe("validateMerchantRescheduleSelection — administrative override", () => {
  it("passes a full slot and reports its capacity (warn+override, not a gate)", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-20",
      "3PM-6PM",
    );
    expect(result).toEqual({ ok: true, capacity: { capacity: 5, booked: 5 } });
  });

  it("returns null capacity when none is configured for the date+slot", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-23",
      "9AM-12PM",
    );
    expect(result).toEqual({ ok: true, capacity: null });
  });

  it("skips the customer date window entirely: past dates and dates beyond maxDays pass", () => {
    expect(
      validateMerchantRescheduleSelection(rules, "2020-01-01", "9AM-12PM").ok,
    ).toBe(true);
    expect(
      validateMerchantRescheduleSelection(rules, "2030-12-31", "9AM-12PM").ok,
    ).toBe(true);
  });
});
