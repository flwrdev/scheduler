import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DELIVERY_SCHEDULE_RULES } from "../app/lib/delivery-availability";

const prismaMock = vi.hoisted(() => ({
  deliveryScheduleConfig: {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const bookingsMock = vi.hoisted(() => ({
  getDeliveryBookingsSnapshot: vi.fn(),
  deriveBookedCounts: vi.fn(),
  invalidateDeliveryBookingsCache: vi.fn(),
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));
vi.mock("../app/services/delivery-bookings.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../app/services/delivery-bookings.server")>();
  return {
    ...original,
    getDeliveryBookingsSnapshot: bookingsMock.getDeliveryBookingsSnapshot,
    deriveBookedCounts: bookingsMock.deriveBookedCounts,
    invalidateDeliveryBookingsCache: bookingsMock.invalidateDeliveryBookingsCache,
  };
});

import {
  getScheduleRules,
  getScheduleRulesDetailed,
  getScheduleRulesWithHealth,
  upsertScheduleRules,
} from "../app/services/schedule-rules.server";

const SHOP = "test-shop.myshopify.com";

function storedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cfg1",
    shop: SHOP,
    timezone: "Asia/Manila",
    cutoffHour: 17,
    prepHours: 1,
    maxDays: 25,
    slotsJson: JSON.stringify([{ display: "Morning", value: "9AM-12PM" }]),
    disabledDatesJson: "[]",
    disabledSlotsJson: "{}",
    slotCapacityJson: "{}",
    version: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getScheduleRules — pure read (PERF-2 fix)", () => {
  it("returns default rules without touching the database when shop is missing", async () => {
    const rules = await getScheduleRules(undefined);
    expect(rules).toEqual(DEFAULT_DELIVERY_SCHEDULE_RULES);
    expect(prismaMock.deliveryScheduleConfig.findUnique).not.toHaveBeenCalled();
  });

  it("reads with findUnique and NEVER writes a row as a read side effect", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(null);

    const rules = await getScheduleRules(SHOP);

    expect(rules).toEqual(DEFAULT_DELIVERY_SCHEDULE_RULES);
    expect(prismaMock.deliveryScheduleConfig.findUnique).toHaveBeenCalledWith({
      where: { shop: SHOP },
    });
    expect(prismaMock.deliveryScheduleConfig.create).not.toHaveBeenCalled();
    expect(prismaMock.deliveryScheduleConfig.updateMany).not.toHaveBeenCalled();
  });

  it("exposes config health and version through getScheduleRulesWithHealth", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(
      storedRow({ slotsJson: "{corrupt" }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getScheduleRulesWithHealth(SHOP);

    expect(result.version).toBe(3);
    expect(result.configHealth.length).toBeGreaterThan(0);
    expect(result.rules.slots).toEqual(DEFAULT_DELIVERY_SCHEDULE_RULES.slots);
    expect(consoleError).toHaveBeenCalled(); // loud, not silent

    consoleError.mockRestore();
  });
});

describe("upsertScheduleRules — strict validation + optimistic version guard", () => {
  it("rejects an invalid patch with field errors and writes nothing", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(storedRow());

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 99 });

    expect(result).toMatchObject({ ok: false, code: "validation" });
    if (!result.ok && result.code === "validation") {
      expect(result.fieldErrors.cutoffHour).toBeTruthy();
    }
    expect(prismaMock.deliveryScheduleConfig.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.deliveryScheduleConfig.create).not.toHaveBeenCalled();
  });

  it("updates with a version guard and increments the version", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(storedRow()) // read current
      .mockResolvedValueOnce(storedRow()) // existence check
      .mockResolvedValueOnce(storedRow({ cutoffHour: 12, version: 4 })); // fresh re-read
    prismaMock.deliveryScheduleConfig.updateMany.mockResolvedValue({ count: 1 });

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 12 });

    expect(prismaMock.deliveryScheduleConfig.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop: SHOP, version: 3 },
        data: expect.objectContaining({ cutoffHour: 12, version: 4 }),
      }),
    );
    expect(result).toMatchObject({ ok: true, version: 4 });
    if (result.ok) {
      expect(result.rules.cutoffHour).toBe(12);
    }
  });

  it("returns stale_config with fresh rules when another writer won the race", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(storedRow()) // read current (version 3)
      .mockResolvedValueOnce(storedRow({ version: 4 })) // existence check
      .mockResolvedValueOnce(storedRow({ cutoffHour: 9, version: 4 })); // fresh re-read
    prismaMock.deliveryScheduleConfig.updateMany.mockResolvedValue({ count: 0 });

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 12 }, { expectedVersion: 3 });

    expect(result).toMatchObject({ ok: false, code: "stale_config", version: 4 });
  });

  it("creates the row on first save (version 1) — reads never created it", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(null) // read current
      .mockResolvedValueOnce(null); // existence check
    prismaMock.deliveryScheduleConfig.create.mockResolvedValue(
      storedRow({ cutoffHour: 12, version: 1 }),
    );

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 12 });

    expect(prismaMock.deliveryScheduleConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shop: SHOP, cutoffHour: 12, version: 1 }),
      }),
    );
    expect(result).toMatchObject({ ok: true, version: 1 });
  });

  it("maps a create-race unique violation (P2002) to stale_config, not a 500", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(null) // read current
      .mockResolvedValueOnce(null) // existence check
      .mockResolvedValueOnce(storedRow({ version: 1 })); // fresh re-read
    prismaMock.deliveryScheduleConfig.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 12 });

    expect(result).toMatchObject({ ok: false, code: "stale_config", version: 1 });
  });

  it("invalidates the bookings cache on a successful save", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(storedRow())
      .mockResolvedValueOnce(storedRow())
      .mockResolvedValueOnce(storedRow({ version: 4 }));
    prismaMock.deliveryScheduleConfig.updateMany.mockResolvedValue({ count: 1 });

    await upsertScheduleRules(SHOP, { cutoffHour: 12 });

    expect(bookingsMock.invalidateDeliveryBookingsCache).toHaveBeenCalledWith(SHOP);
  });
});

describe("getScheduleRulesDetailed — booked counts overlay + countsMeta (design §5)", () => {
  const CAPACITY_ROW = () =>
    storedRow({
      slotCapacityJson: JSON.stringify({
        "2026-07-18": { "9AM-12PM": { capacity: 5, booked: 0 } },
      }),
    });
  const admin = { graphql: vi.fn() };

  it("reports 'untracked' without touching the Admin API when no capacity is configured", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(storedRow());

    const result = await getScheduleRulesDetailed(SHOP, admin);

    expect(result.countsMeta).toEqual({
      status: "untracked",
      fetchedAt: null,
      fromCache: false,
    });
    expect(bookingsMock.getDeliveryBookingsSnapshot).not.toHaveBeenCalled();
  });

  it("reports 'skipped' when no admin client is available", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(CAPACITY_ROW());

    const result = await getScheduleRulesDetailed(SHOP, undefined);

    expect(result.countsMeta.status).toBe("skipped");
    expect(bookingsMock.getDeliveryBookingsSnapshot).not.toHaveBeenCalled();
  });

  it("overlays derived counts and reports 'ok' with the snapshot timestamp", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(CAPACITY_ROW());
    bookingsMock.getDeliveryBookingsSnapshot.mockResolvedValue({
      bookings: [
        { orderId: "gid://shopify/Order/1", date: "2026-07-18", slotValue: "9AM-12PM" },
      ],
      fetchedAt: "2026-07-15T02:00:00.000Z",
      fromCache: true,
    });
    bookingsMock.deriveBookedCounts.mockReturnValue({
      "2026-07-18": { "9AM-12PM": 3 },
    });

    const result = await getScheduleRulesDetailed(SHOP, admin, {
      excludeOrderId: "gid://shopify/Order/9",
    });

    expect(result.rules.slotCapacity["2026-07-18"]["9AM-12PM"]).toEqual({
      capacity: 5,
      booked: 3,
    });
    expect(result.countsMeta).toEqual({
      status: "ok",
      fetchedAt: "2026-07-15T02:00:00.000Z",
      fromCache: true,
    });
    // exclude-self is threaded through to the derivation (DEF-14)
    expect(bookingsMock.deriveBookedCounts).toHaveBeenCalledWith(
      expect.any(Array),
      "gid://shopify/Order/9",
    );
  });

  it("reports 'partial' (never 'ok') when a scan cap clipped the counts", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(CAPACITY_ROW());
    bookingsMock.getDeliveryBookingsSnapshot.mockResolvedValue({
      bookings: [
        { orderId: "gid://shopify/Order/1", date: "2026-07-18", slotValue: "9AM-12PM" },
      ],
      fetchedAt: "2026-07-15T02:00:00.000Z",
      fromCache: false,
      truncation: {
        droppedDates: ["2026-11-20"],
        pagedOutDates: ["2026-07-18", "2026-07-19"],
      },
    });
    bookingsMock.deriveBookedCounts.mockReturnValue({
      "2026-07-18": { "9AM-12PM": 4 },
    });

    const result = await getScheduleRulesDetailed(SHOP, admin);

    expect(result.countsMeta).toEqual({
      status: "partial",
      fetchedAt: "2026-07-15T02:00:00.000Z",
      fromCache: false,
      truncation: {
        caps: ["dates", "pages"],
        affectedDates: ["2026-07-18", "2026-07-19", "2026-11-20"],
      },
    });
    // fail-open: the clipped counts are still applied, just not trusted as whole
    expect(result.rules.slotCapacity["2026-07-18"]["9AM-12PM"].booked).toBe(4);
  });

  it("names only the cap that actually tripped", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(CAPACITY_ROW());
    bookingsMock.getDeliveryBookingsSnapshot.mockResolvedValue({
      bookings: [],
      fetchedAt: "2026-07-15T02:00:00.000Z",
      fromCache: true,
      truncation: { droppedDates: [], pagedOutDates: ["2026-07-18"] },
    });
    bookingsMock.deriveBookedCounts.mockReturnValue({});

    const result = await getScheduleRulesDetailed(SHOP, admin);

    expect(result.countsMeta.status).toBe("partial");
    expect(result.countsMeta.truncation).toEqual({
      caps: ["pages"],
      affectedDates: ["2026-07-18"],
    });
  });

  it("stays 'ok' with no truncation field when the scan was complete", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(CAPACITY_ROW());
    bookingsMock.getDeliveryBookingsSnapshot.mockResolvedValue({
      bookings: [],
      fetchedAt: "2026-07-15T02:00:00.000Z",
      fromCache: false,
      truncation: null,
    });
    bookingsMock.deriveBookedCounts.mockReturnValue({});

    const result = await getScheduleRulesDetailed(SHOP, admin);

    expect(result.countsMeta.status).toBe("ok");
    expect(result.countsMeta.truncation).toBeUndefined();
  });

  it("fails open with status 'error' when the scan throws (visible, not silent)", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(CAPACITY_ROW());
    bookingsMock.getDeliveryBookingsSnapshot.mockRejectedValue(new Error("THROTTLED"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getScheduleRulesDetailed(SHOP, admin);

    expect(result.countsMeta.status).toBe("error");
    // fail-open: persisted (vestigial 0) booked values remain
    expect(result.rules.slotCapacity["2026-07-18"]["9AM-12PM"].booked).toBe(0);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
