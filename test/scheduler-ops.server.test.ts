import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  deliveryScheduleConfig: {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const bookingsMock = vi.hoisted(() => ({
  invalidateDeliveryBookingsCache: vi.fn(),
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));
vi.mock("../app/services/delivery-bookings.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../app/services/delivery-bookings.server")>();
  return {
    ...original,
    invalidateDeliveryBookingsCache: bookingsMock.invalidateDeliveryBookingsCache,
  };
});

import {
  getTodayInTimezone,
  runSchedulerOp,
} from "../app/services/scheduler-ops.server";

const SHOP = "test-shop.myshopify.com";
// 2026-07-16 12:00 Asia/Manila (04:00 UTC) — "today" for pruning assertions.
const NOW = new Date("2026-07-16T04:00:00Z");
const PAST_DATE = "2026-07-10";
const FUTURE_DATE = "2026-07-20";

function storedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cfg1",
    shop: SHOP,
    timezone: "Asia/Manila",
    cutoffHour: 17,
    prepHours: 1,
    maxDays: 25,
    slotsJson: JSON.stringify([
      { display: "Morning", value: "9AM-12PM" },
      { display: "Midday", value: "12PM-3PM" },
    ]),
    disabledDatesJson: JSON.stringify([PAST_DATE, FUTURE_DATE]),
    disabledSlotsJson: JSON.stringify({
      [PAST_DATE]: ["9AM-12PM"],
      [FUTURE_DATE]: ["12PM-3PM"],
    }),
    slotCapacityJson: JSON.stringify({
      [PAST_DATE]: { "9AM-12PM": { capacity: 5, booked: 0 } },
      [FUTURE_DATE]: { "9AM-12PM": { capacity: 2, booked: 0 } },
    }),
    version: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function lastPatchWrite() {
  const calls = prismaMock.deliveryScheduleConfig.updateMany.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const { where, data } = calls[calls.length - 1][0];
  return { where, data };
}

// Stateful row so the service's post-write re-read observes the write, the
// same way Postgres would.
let row: Record<string, unknown>;

function useRow(overrides: Partial<Record<string, unknown>> = {}) {
  row = storedRow(overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
  useRow();
  prismaMock.deliveryScheduleConfig.findUnique.mockImplementation(async () => ({
    ...row,
  }));
  prismaMock.deliveryScheduleConfig.updateMany.mockImplementation(
    async ({ where, data }: { where: { version: number }; data: Record<string, unknown> }) => {
      if (where.version !== row.version) {
        return { count: 0 };
      }
      row = { ...row, ...data };
      return { count: 1 };
    },
  );
});

describe("getTodayInTimezone", () => {
  it("resolves the shop-local calendar date", () => {
    expect(getTodayInTimezone("Asia/Manila", NOW)).toBe("2026-07-16");
    // 04:00Z is still 2026-07-15 in Los Angeles.
    expect(getTodayInTimezone("America/Los_Angeles", NOW)).toBe("2026-07-15");
  });
});

describe("runSchedulerOp — envelope and guards", () => {
  it("rejects an unknown op without touching the database", async () => {
    const result = await runSchedulerOp(SHOP, "dropTables", {}, 3, NOW);
    expect(result).toEqual({ ok: false, code: "unknown_op" });
    expect(prismaMock.deliveryScheduleConfig.updateMany).not.toHaveBeenCalled();
  });

  it("returns stale_config with fresh state when the client version is behind", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "saveSettings",
      { timezone: "Asia/Manila", cutoffHour: 12, prepHours: 1, maxDays: 25 },
      2, // loaded before another session bumped to 3
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("stale_config");
      expect(result.version).toBe(3);
      expect(result.rules?.cutoffHour).toBe(17);
    }
    expect(prismaMock.deliveryScheduleConfig.updateMany).not.toHaveBeenCalled();
  });
});

describe("saveSettings", () => {
  it("writes the settings under the version guard and bumps the version", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "saveSettings",
      { timezone: "Asia/Manila", cutoffHour: 12, prepHours: 2, maxDays: 30 },
      3,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe(4);
      expect(result.rules.cutoffHour).toBe(12);
    }
    const { where } = lastPatchWrite();
    expect(where).toEqual({ shop: SHOP, version: 3 });
  });

  it("surfaces the schema's field errors for invalid settings", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "saveSettings",
      { timezone: "Asia/Manilaa", cutoffHour: 12, prepHours: 2, maxDays: 30 },
      3,
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation");
      expect(Object.keys(result.fieldErrors ?? {})).toContain("timezone");
    }
    expect(prismaMock.deliveryScheduleConfig.updateMany).not.toHaveBeenCalled();
  });
});

describe("createSlot", () => {
  const validInput = {
    start: { hour: 3, minute: 0, meridiem: "PM" },
    end: { hour: 6, minute: 0, meridiem: "PM" },
    display: "Afternoon",
  };

  it("appends a slot with a generated canonical value", async () => {
    const result = await runSchedulerOp(SHOP, "createSlot", validInput, 3, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.slots.map((slot) => slot.value)).toEqual([
        "9AM-12PM",
        "12PM-3PM",
        "3PM-6PM",
      ]);
      expect(result.rules.slots[2]).toEqual({
        display: "Afternoon",
        value: "3PM-6PM",
      });
    }
  });

  it("rejects duplicate times even in a different case/spacing form", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "createSlot",
      {
        start: { hour: 9, minute: 0, meridiem: "AM" },
        end: { hour: 12, minute: 0, meridiem: "PM" },
        display: "Another morning",
      },
      3,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("validation");
  });

  it("rejects an inverted range and a duplicate display label", async () => {
    const inverted = await runSchedulerOp(
      SHOP,
      "createSlot",
      { ...validInput, start: { hour: 7, minute: 0, meridiem: "PM" } },
      3,
      NOW,
    );
    expect(inverted.ok).toBe(false);

    const dupDisplay = await runSchedulerOp(
      SHOP,
      "createSlot",
      { ...validInput, display: "morning" },
      3,
      NOW,
    );
    expect(dupDisplay.ok).toBe(false);
    if (!dupDisplay.ok) {
      expect(Object.keys(dupDisplay.fieldErrors ?? {})).toContain("display");
    }
  });
});

describe("updateSlotDisplay / reorderSlots", () => {
  it("renames only the display, never the value", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "updateSlotDisplay",
      { value: "9AM-12PM", display: "Early morning" },
      3,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.slots[0]).toEqual({
        display: "Early morning",
        value: "9AM-12PM",
      });
    }
  });

  it("rejects an unknown slot value", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "updateSlotDisplay",
      { value: "5AM-6AM", display: "Ghost" },
      3,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("reorders with a valid permutation and rejects a stale one", async () => {
    const ok = await runSchedulerOp(
      SHOP,
      "reorderSlots",
      { order: ["12PM-3PM", "9AM-12PM"] },
      3,
      NOW,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.rules.slots.map((slot) => slot.value)).toEqual([
        "12PM-3PM",
        "9AM-12PM",
      ]);
    }

    const stale = await runSchedulerOp(
      SHOP,
      "reorderSlots",
      { order: ["12PM-3PM"] },
      3,
      NOW,
    );
    expect(stale.ok).toBe(false);
  });
});

describe("deleteSlot", () => {
  it("cascades the slot out of overrides and prunes past-dated entries", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "deleteSlot",
      { value: "9AM-12PM" },
      3,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.slots.map((slot) => slot.value)).toEqual([
        "12PM-3PM",
      ]);
      // FUTURE_DATE's blocked 12PM-3PM survives; 9AM-12PM capacity entry gone;
      // all PAST_DATE entries pruned.
      expect(result.rules.disabledSlots).toEqual({
        [FUTURE_DATE]: ["12PM-3PM"],
      });
      expect(result.rules.slotCapacity).toEqual({});
    }
  });

  it("refuses to delete the last remaining slot", async () => {
    useRow({
      slotsJson: JSON.stringify([{ display: "Only", value: "9AM-12PM" }]),
      disabledSlotsJson: "{}",
      slotCapacityJson: "{}",
    });
    const result = await runSchedulerOp(
      SHOP,
      "deleteSlot",
      { value: "9AM-12PM" },
      3,
      NOW,
    );
    expect(result.ok).toBe(false);
  });
});

describe("saveDayOverride / clearDayOverride", () => {
  it("saves a full-day block and drops that day's slot-level overrides", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "saveDayOverride",
      { date: FUTURE_DATE, blocked: true, blockedSlots: [], capacities: {} },
      3,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.disabledDates).toEqual([FUTURE_DATE]); // past pruned
      expect(result.rules.disabledSlots).toEqual({});
      expect(result.rules.slotCapacity).toEqual({});
    }
  });

  it("saves per-slot blocks and capacities for a day", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "saveDayOverride",
      {
        date: "2026-07-25",
        blocked: false,
        blockedSlots: ["12PM-3PM"],
        capacities: { "9AM-12PM": 4 },
      },
      3,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.disabledSlots["2026-07-25"]).toEqual(["12PM-3PM"]);
      expect(result.rules.slotCapacity["2026-07-25"]).toEqual({
        "9AM-12PM": { capacity: 4, booked: 0 },
      });
      // Untouched future override survives, past pruned.
      expect(result.rules.disabledSlots[FUTURE_DATE]).toEqual(["12PM-3PM"]);
      expect(result.rules.disabledSlots[PAST_DATE]).toBeUndefined();
    }
  });

  it("keeps a day's per-slot blocks and caps when the whole day is blocked", async () => {
    // Blocking a day is a day-level flag, not an edit of that date's per-slot
    // config. The op used to drop both, so block → unblock silently lost the
    // merchant's caps and window blocks with a "Day saved" success toast.
    const result = await runSchedulerOp(
      SHOP,
      "saveDayOverride",
      {
        date: "2026-07-25",
        blocked: true,
        blockedSlots: ["12PM-3PM"],
        capacities: { "9AM-12PM": 4 },
      },
      3,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.disabledDates).toContain("2026-07-25");
      expect(result.rules.disabledSlots["2026-07-25"]).toEqual(["12PM-3PM"]);
      expect(result.rules.slotCapacity["2026-07-25"]).toEqual({
        "9AM-12PM": { capacity: 4, booked: 0 },
      });
    }
  });

  it("rejects unknown slots and negative capacities", async () => {
    const unknown = await runSchedulerOp(
      SHOP,
      "saveDayOverride",
      { date: "2026-07-25", blocked: false, blockedSlots: ["5AM-6AM"], capacities: {} },
      3,
      NOW,
    );
    expect(unknown.ok).toBe(false);

    const negative = await runSchedulerOp(
      SHOP,
      "saveDayOverride",
      { date: "2026-07-25", blocked: false, blockedSlots: [], capacities: { "9AM-12PM": -1 } },
      3,
      NOW,
    );
    expect(negative.ok).toBe(false);
  });

  it("clears every override for one date", async () => {
    const result = await runSchedulerOp(
      SHOP,
      "clearDayOverride",
      { date: FUTURE_DATE },
      3,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.disabledDates).toEqual([]);
      expect(result.rules.disabledSlots).toEqual({});
      expect(result.rules.slotCapacity).toEqual({});
    }
  });
});
