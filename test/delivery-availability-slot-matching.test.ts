import { describe, expect, it } from "vitest";

import {
  validateDeliverySelection,
  validateMerchantRescheduleSelection,
  type DeliveryScheduleRules,
} from "../app/lib/delivery-availability";

// §4.2: slot matching is tolerant (one canonical comparator) while stored values
// and blocked/capacity lookups stay keyed by the CONFIGURED value. These tests
// pin the DEF-2/DEF-4 fix at the validator level.

const rules: DeliveryScheduleRules = {
  timezone: "Asia/Manila",
  cutoffHour: 17,
  prepHours: 1,
  maxDays: 25,
  slots: [
    { display: "Morning", value: "9AM-12PM" },
    { display: "Afternoon", value: "3PM-6PM" },
  ],
  disabledDates: [],
  disabledSlots: { "2026-07-18": ["9AM-12PM"] },
  slotCapacity: {
    "2026-07-19": { "9AM-12PM": { capacity: 1, booked: 1 } },
  },
};

// 10:00 AM Manila on 2026-07-15 — inside the window, before the 17:00 cutoff.
const NOW = new Date("2026-07-15T02:00:00Z");

describe("validateDeliverySelection — tolerant slot resolution", () => {
  it("accepts case/spacing variants of a configured slot", () => {
    for (const variant of ["9AM-12PM", "9am - 12pm", "9:00AM - 12:00PM"]) {
      const result = validateDeliverySelection(rules, "2026-07-20", variant, NOW);
      expect(result.ok).toBe(true);
    }
  });

  it("still rejects a value that names no configured slot", () => {
    const result = validateDeliverySelection(rules, "2026-07-20", "morning", NOW);
    expect(result).toMatchObject({ ok: false, code: "slot_unknown" });
  });

  it("applies blocked-slot rules to tolerant variants (configured-key lookup)", () => {
    const result = validateDeliverySelection(
      rules,
      "2026-07-18",
      "9:00am - 12:00pm",
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["slot_unavailable", "no_slots_available"]).toContain(result.code);
    }
  });

  it("applies capacity rules to tolerant variants", () => {
    const result = validateDeliverySelection(rules, "2026-07-19", "9am-12pm", NOW);
    expect(result.ok).toBe(false);

    // The other slot on the same date is unaffected.
    expect(validateDeliverySelection(rules, "2026-07-19", "3PM-6PM", NOW).ok).toBe(
      true,
    );
  });
});

describe("validateMerchantRescheduleSelection — same tolerant resolution", () => {
  it("accepts variants and reports capacity from the configured key", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-19",
      "9:00AM - 12:00PM",
    );
    expect(result).toEqual({ ok: true, capacity: { capacity: 1, booked: 1 } });
  });

  it("blocks tolerant variants on a blocked slot date", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-18",
      "9am - 12pm",
    );
    expect(result).toMatchObject({ ok: false, code: "slot_blocked" });
  });

  it("still rejects unknown slots", () => {
    const result = validateMerchantRescheduleSelection(rules, "2026-07-20", "morning");
    expect(result).toMatchObject({ ok: false, code: "slot_unknown" });
  });
});

// The mirror image of the cases above: there the INCOMING value drifted while the
// override key matched the configured slot. Here the stored OVERRIDE KEY is the
// drifted one — the pre-V2 spelling the booked-count matcher already resolves
// canonically. The lookups used to index these maps with `===`/`includes`, so the
// cap was counted (and rendered "Full" on the dashboard) but never enforced at
// checkout, and a blocked slot stayed bookable.
const driftedKeyRules: DeliveryScheduleRules = {
  ...rules,
  disabledSlots: { "2026-07-18": ["9am - 12pm"] },
  slotCapacity: {
    "2026-07-19": { "9:00AM - 12:00PM": { capacity: 1, booked: 1 } },
  },
};

describe("override keys that drift from the configured slot value", () => {
  it("enforces a capacity cap stored under a drifted key", () => {
    for (const variant of ["9AM-12PM", "9am - 12pm", "9:00AM - 12:00PM"]) {
      const result = validateDeliverySelection(
        driftedKeyRules,
        "2026-07-19",
        variant,
        NOW,
      );
      expect(result.ok).toBe(false);
    }

    // The other slot on the same date is still open.
    expect(
      validateDeliverySelection(driftedKeyRules, "2026-07-19", "3PM-6PM", NOW).ok,
    ).toBe(true);
  });

  it("enforces a blocked slot stored under a drifted key", () => {
    const result = validateDeliverySelection(
      driftedKeyRules,
      "2026-07-18",
      "9AM-12PM",
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("reports the drifted-key capacity to the merchant reschedule validator", () => {
    const result = validateMerchantRescheduleSelection(
      driftedKeyRules,
      "2026-07-19",
      "9AM-12PM",
    );
    expect(result).toEqual({ ok: true, capacity: { capacity: 1, booked: 1 } });
  });

  it("blocks the merchant path on a drifted blocked-slot key", () => {
    const result = validateMerchantRescheduleSelection(
      driftedKeyRules,
      "2026-07-18",
      "9AM-12PM",
    );
    expect(result).toMatchObject({ ok: false, code: "slot_blocked" });
  });

  it("prefers an exact key over a canonical match when both are stored", () => {
    const bothSpellings: DeliveryScheduleRules = {
      ...rules,
      slotCapacity: {
        "2026-07-19": {
          "9am - 12pm": { capacity: 9, booked: 0 },
          "9AM-12PM": { capacity: 1, booked: 1 },
        },
      },
    };

    expect(
      validateMerchantRescheduleSelection(bothSpellings, "2026-07-19", "9AM-12PM"),
    ).toEqual({ ok: true, capacity: { capacity: 1, booked: 1 } });
  });
});
