import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /apps/schedule-rules — the storefront App Proxy rules endpoint. Pins the
// additive `availabilityWindow` key (2026-09-02) on top of the frozen (D5)
// rules payload. Same mock idiom as test/api-agent-routes.test.ts:
// authenticate.public.appProxy and the rules service are mocked so this runs in
// plain node with no DB/Admin API; the availability engine itself
// (app/lib/delivery-availability.ts) is REAL so the assertions exercise the
// actual cutoff/prep/blocked/capacity math.

const { appProxyMock, getRulesMock } = vi.hoisted(() => ({
  appProxyMock: vi.fn(),
  getRulesMock: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { appProxy: appProxyMock } },
}));

vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRulesWithBookedCounts: getRulesMock,
}));

import type { DeliveryScheduleRules } from "../app/lib/delivery-availability";
import { loader } from "../app/routes/apps.schedule-rules";

const SHOP = "hsrwva-nr.myshopify.com";
const ADMIN = { graphql: vi.fn() };

// Asia/Manila is UTC+8 with no DST, so a fixed UTC instant maps to one shop-local
// wall-clock time. cutoffHour is 17 in the fixture below.
const MANILA_6PM_SEP_1 = new Date("2026-09-01T10:00:00Z"); // past cutoff
const MANILA_10AM_SEP_1 = new Date("2026-09-01T02:00:00Z"); // before cutoff
const SEP_1_CUTOFF_ISO = "2026-09-01T09:00:00.000Z"; // 5PM Manila, Sep 1

const SLOT_VALUES = ["9AM-12PM", "12PM-3PM", "3PM-6PM", "6PM-11PM"];

function baseRules(overrides: Partial<DeliveryScheduleRules> = {}): DeliveryScheduleRules {
  return {
    timezone: "Asia/Manila",
    cutoffHour: 17,
    prepHours: 1,
    maxDays: 25,
    slots: SLOT_VALUES.map((value) => ({ display: value, value })),
    disabledDates: [],
    disabledSlots: {},
    slotCapacity: {},
    ...overrides,
  };
}

async function callLoader() {
  const request = new Request(
    `https://app.example.com/apps/schedule-rules?shop=${SHOP}&signature=stub`,
  );
  const response = (await loader({ request, params: {}, context: {} } as never)) as Response;
  return { response, body: await response.json() };
}

// Every slot entry carries the two verdict flags plus a `lastOrderAt` instant;
// the flags are what each case is about, so assert them exactly and only
// type-check the instant here (its value is pinned separately below).
function expectSlot(slot: unknown, flags: { available: boolean; blocked: boolean }) {
  expect(slot).toMatchObject(flags);
  expect(typeof (slot as { lastOrderAt: unknown }).lastOrderAt).toBe("string");
}

beforeEach(() => {
  vi.useFakeTimers();
  appProxyMock.mockResolvedValue({ admin: ADMIN, session: { shop: SHOP } });
  getRulesMock.mockResolvedValue(baseRules());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("apps.schedule-rules loader — availabilityWindow", () => {
  it("past cutoff: today is still listed (all slots unavailable) while minDate is tomorrow", async () => {
    vi.setSystemTime(MANILA_6PM_SEP_1);

    const { body } = await callLoader();
    const window = body.availabilityWindow;

    expect(window.today).toBe("2026-09-01");
    expect(window.minDate).toBe("2026-09-02");
    expect(window.maxDate).toBe("2026-09-26");

    // The convention under test: the dates map starts at TODAY even though the
    // sellable window starts tomorrow, so the storefront can explain the cutoff.
    const dateKeys = Object.keys(window.dates);
    expect(dateKeys[0]).toBe("2026-09-01");
    expect(dateKeys).toHaveLength(26); // today + 25 sellable days
    expect(dateKeys[dateKeys.length - 1]).toBe("2026-09-26");

    const today = window.dates["2026-09-01"];
    expect(today.dateBlocked).toBe(false);
    for (const slot of SLOT_VALUES) {
      expectSlot(today.slots[slot], { available: false, blocked: false });
    }

    const tomorrow = window.dates["2026-09-02"];
    expect(tomorrow.dateBlocked).toBe(false);
    for (const slot of SLOT_VALUES) {
      expectSlot(tomorrow.slots[slot], { available: true, blocked: false });
    }
  });

  it("a slot in disabledSlots for a date is blocked and unavailable; its siblings are open", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);
    getRulesMock.mockResolvedValue(
      baseRules({ disabledSlots: { "2026-09-05": ["12PM-3PM"] } }),
    );

    const { body } = await callLoader();
    const day = body.availabilityWindow.dates["2026-09-05"];

    expect(day.dateBlocked).toBe(false);
    expectSlot(day.slots["12PM-3PM"], { available: false, blocked: true });
    expectSlot(day.slots["9AM-12PM"], { available: true, blocked: false });
    expectSlot(day.slots["3PM-6PM"], { available: true, blocked: false });
  });

  it("a disabledSlots entry with drifted spelling still blocks (canonical matching, not exact)", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);
    getRulesMock.mockResolvedValue(
      baseRules({ disabledSlots: { "2026-09-05": ["12pm - 3pm"] } }),
    );

    const { body } = await callLoader();
    const day = body.availabilityWindow.dates["2026-09-05"];

    expectSlot(day.slots["12PM-3PM"], { available: false, blocked: true });
    expectSlot(day.slots["9AM-12PM"], { available: true, blocked: false });
  });

  it("a slot at capacity (booked >= capacity) is blocked and unavailable; under capacity stays open", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);
    getRulesMock.mockResolvedValue(
      baseRules({
        slotCapacity: {
          "2026-09-05": {
            "3PM-6PM": { capacity: 5, booked: 5 },
            "6PM-11PM": { capacity: 5, booked: 4 },
          },
        },
      }),
    );

    const { body } = await callLoader();
    const day = body.availabilityWindow.dates["2026-09-05"];

    expect(day.dateBlocked).toBe(false);
    expectSlot(day.slots["3PM-6PM"], { available: false, blocked: true });
    expectSlot(day.slots["6PM-11PM"], { available: true, blocked: false });
    expectSlot(day.slots["9AM-12PM"], { available: true, blocked: false });
  });

  it("a date in disabledDates is dateBlocked with every slot unavailable — but slot.blocked stays false (renderer owns precedence)", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);
    getRulesMock.mockResolvedValue(baseRules({ disabledDates: ["2026-09-10"] }));

    const { body } = await callLoader();
    const day = body.availabilityWindow.dates["2026-09-10"];

    expect(day.dateBlocked).toBe(true);
    for (const slot of SLOT_VALUES) {
      expectSlot(day.slots[slot], { available: false, blocked: false });
    }

    // The date is still inside the window map (not dropped), and its neighbours are open.
    expect(body.availabilityWindow.dates["2026-09-09"].dateBlocked).toBe(false);
    expect(body.availabilityWindow.dates["2026-09-11"].dateBlocked).toBe(false);
  });

  it("before cutoff: today == minDate, a normal future date+slot is available and unblocked, and prepHours only affects `available`", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);

    const { body } = await callLoader();
    const window = body.availabilityWindow;

    expect(window.today).toBe("2026-09-01");
    expect(window.minDate).toBe("2026-09-01");
    expect(window.maxDate).toBe("2026-09-25");
    expect(Object.keys(window.dates)[0]).toBe("2026-09-01");
    expect(Object.keys(window.dates)).toHaveLength(25);

    const future = window.dates["2026-09-03"];
    expect(future.dateBlocked).toBe(false);
    expectSlot(future.slots["9AM-12PM"], { available: true, blocked: false });

    // Today at 10:00 with prepHours 1: the 9AM slot's start already passed, so it
    // is unavailable WITHOUT being blocked; 12PM (order by 11:00) is still open.
    const today = window.dates["2026-09-01"];
    expectSlot(today.slots["9AM-12PM"], { available: false, blocked: false });
    expectSlot(today.slots["12PM-3PM"], { available: true, blocked: false });
  });

  it("guards a blank getShopLocalDate: no dates[\"\"] key, today and the map start fall back to minDate", async () => {
    vi.setSystemTime(MANILA_6PM_SEP_1);

    // Swap ONLY getShopLocalDate for this test; the rest of the engine stays real.
    // The hoisted shopify/service mocks above survive resetModules.
    vi.resetModules();
    vi.doMock("../app/lib/delivery-availability", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../app/lib/delivery-availability")>()),
      getShopLocalDate: () => "",
    }));
    const { loader: guardedLoader } = await import("../app/routes/apps.schedule-rules");

    const request = new Request(`https://app.example.com/apps/schedule-rules?shop=${SHOP}`);
    const response = (await guardedLoader({ request, params: {}, context: {} } as never)) as Response;
    const body = await response.json();
    const window = body.availabilityWindow;

    expect(window.minDate).toBe("2026-09-02");
    expect(window.today).toBe("2026-09-02");
    // (toHaveProperty("") chokes on an empty path — check the key list directly.)
    expect(Object.keys(window.dates)).not.toContain("");
    expect(Object.keys(window.dates)[0]).toBe("2026-09-02");
    expect(Object.keys(window.dates)).toHaveLength(25);
    // cutoffAt follows whatever `today` resolved to — the fallback date's cutoff.
    expect(window.cutoffAt).toBe("2026-09-02T09:00:00.000Z");

    vi.doUnmock("../app/lib/delivery-availability");
    vi.resetModules();
  });
});

describe("apps.schedule-rules loader — cutoffAt + lastOrderAt (additive instants)", () => {
  it("past cutoff: cutoffAt is present and EARLIER than now, and the dates map still starts at today", async () => {
    vi.setSystemTime(MANILA_6PM_SEP_1);

    const { body } = await callLoader();
    const window = body.availabilityWindow;

    expect(window.cutoffAt).toBe(SEP_1_CUTOFF_ISO);
    expect(new Date(window.cutoffAt).getTime()).toBeLessThan(Date.now());
    expect(Object.keys(window.dates)[0]).toBe("2026-09-01");
    expect(window.today).toBe("2026-09-01");
  });

  it("before cutoff: cutoffAt is present and LATER than now", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);

    const { body } = await callLoader();
    const window = body.availabilityWindow;

    expect(window.cutoffAt).toBe(SEP_1_CUTOFF_ISO);
    expect(new Date(window.cutoffAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("every slot on every date carries lastOrderAt = slot start minus prepHours (uniform, no today special-casing)", async () => {
    vi.setSystemTime(MANILA_6PM_SEP_1);

    const { body } = await callLoader();
    const { dates } = body.availabilityWindow;

    const dateKeys = Object.keys(dates);
    expect(dateKeys).toHaveLength(26);
    for (const date of dateKeys) {
      for (const slot of SLOT_VALUES) {
        const value = dates[date].slots[slot].lastOrderAt;
        expect(typeof value).toBe("string");
        expect(Number.isNaN(new Date(value).getTime())).toBe(false);
        expect(value.endsWith("Z")).toBe(true);
      }
    }

    // Exact values: 12PM Manila = 04:00Z, minus prepHours 1 → 03:00Z on that date.
    expect(dates["2026-09-05"].slots["12PM-3PM"].lastOrderAt).toBe("2026-09-05T03:00:00.000Z");
    // Today (past cutoff) is NOT special-cased: same arithmetic, 9AM − 1h = 00:00Z.
    expect(dates["2026-09-01"].slots["9AM-12PM"].lastOrderAt).toBe("2026-09-01T00:00:00.000Z");
    expect(dates["2026-09-26"].slots["6PM-11PM"].lastOrderAt).toBe("2026-09-26T09:00:00.000Z");
  });

  it("lastOrderAt scales with prepHours", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);
    getRulesMock.mockResolvedValue(baseRules({ prepHours: 3 }));

    const { body } = await callLoader();
    expect(body.availabilityWindow.dates["2026-09-05"].slots["12PM-3PM"].lastOrderAt).toBe(
      "2026-09-05T01:00:00.000Z",
    );
  });
});

describe("apps.schedule-rules loader — byte-compatibility (D5)", () => {
  it("keeps every existing top-level key unchanged and in place, appends availabilityWindow last, and stays no-store", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);
    const fixture = baseRules({
      disabledDates: ["2026-09-10"],
      disabledSlots: { "2026-09-05": ["12PM-3PM"] },
      slotCapacity: { "2026-09-05": { "3PM-6PM": { capacity: 5, booked: 2 } } },
    });
    getRulesMock.mockResolvedValue(fixture);

    const { response, body } = await callLoader();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const { availabilityWindow, ...existing } = body;
    expect(existing).toEqual(JSON.parse(JSON.stringify(fixture)));
    expect(Object.keys(body)).toEqual([...Object.keys(fixture), "availabilityWindow"]);

    expect(availabilityWindow).toEqual(
      expect.objectContaining({
        today: expect.any(String),
        minDate: expect.any(String),
        maxDate: expect.any(String),
        dates: expect.any(Object),
      }),
    );

    expect(appProxyMock).toHaveBeenCalledTimes(1);
    expect(getRulesMock).toHaveBeenCalledWith(SHOP, ADMIN);
  });

  it("availabilityWindow itself only GAINED keys: the original window/slot keys are intact and the new ones are appended after them", async () => {
    vi.setSystemTime(MANILA_10AM_SEP_1);

    const { body } = await callLoader();
    const window = body.availabilityWindow;

    // Original 2026-09-02 window keys first, `cutoffAt` appended.
    expect(Object.keys(window)).toEqual(["today", "minDate", "maxDate", "dates", "cutoffAt"]);
    expect(window.today).toBe("2026-09-01");
    expect(window.minDate).toBe("2026-09-01");
    expect(window.maxDate).toBe("2026-09-25");

    // Original date + slot keys first, `lastOrderAt` appended — on every entry.
    for (const [date, entry] of Object.entries<{ dateBlocked: boolean; slots: Record<string, object> }>(window.dates)) {
      expect(Object.keys(entry)).toEqual(["dateBlocked", "slots"]);
      expect(Object.keys(entry.slots)).toEqual(SLOT_VALUES);
      for (const slot of SLOT_VALUES) {
        expect(Object.keys(entry.slots[slot]), `${date} ${slot}`).toEqual([
          "available",
          "blocked",
          "lastOrderAt",
        ]);
      }
    }
  });
});
