import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  type DeliveryScheduleRules,
} from "../app/lib/delivery-availability";
import {
  deriveBookedCounts,
  getDeliveryBookingsSnapshot,
  invalidateDeliveryBookingsCache,
  type AdminGraphQLClient,
  type DeliveryBooking,
} from "../app/services/delivery-bookings.server";

// Booked-counts engine V2 (design §5 / ADR-12): metafield-date-scoped query,
// metafields-only matching through the canonical comparator, 60s cache,
// exclude-self derivation.

const SHOP = "test-shop.myshopify.com";

// System time 2026-07-15T02:00:00Z = 10:00 Asia/Manila → "today" is 2026-07-15.
const NOW = new Date("2026-07-15T02:00:00Z");

function makeRules(
  slotCapacity: DeliveryScheduleRules["slotCapacity"],
): DeliveryScheduleRules {
  return {
    ...DEFAULT_DELIVERY_SCHEDULE_RULES,
    slots: [
      { display: "Morning", value: "9AM-12PM" },
      { display: "Afternoon", value: "3PM-6PM" },
    ],
    disabledDates: [],
    disabledSlots: {},
    slotCapacity,
  };
}

interface OrderNodeShape {
  id: string;
  cancelledAt?: string | null;
  date?: string | null;
  slot?: string | null;
}

function ordersPage(
  nodes: OrderNodeShape[],
  pageInfo = { hasNextPage: false, endCursor: null as string | null },
) {
  return {
    ok: true,
    json: async () => ({
      data: {
        orders: {
          edges: nodes.map((node) => ({
            node: {
              id: node.id,
              cancelledAt: node.cancelledAt ?? null,
              deliveryDateMetafield:
                node.date === undefined ? null : { value: node.date },
              timeSlotMetafield:
                node.slot === undefined ? null : { value: node.slot },
            },
          })),
          pageInfo,
        },
      },
    }),
  } as unknown as Response;
}

function makeAdmin(responses: Response[]): AdminGraphQLClient & {
  graphql: ReturnType<typeof vi.fn>;
} {
  const graphql = vi.fn();
  for (const response of responses) {
    graphql.mockResolvedValueOnce(response);
  }
  return { graphql };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  invalidateDeliveryBookingsCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getDeliveryBookingsSnapshot — metafield-date-scoped query", () => {
  it("queries only FUTURE tracked dates, OR-joined, and skips past capacity dates", async () => {
    const rules = makeRules({
      "2026-07-01": { "9AM-12PM": { capacity: 5, booked: 0 } }, // past — pruned from the query
      "2026-07-20": { "9AM-12PM": { capacity: 5, booked: 0 } },
      "2026-07-18": { "3PM-6PM": { capacity: 2, booked: 0 } },
    });
    const admin = makeAdmin([ordersPage([])]);

    await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(admin.graphql).toHaveBeenCalledTimes(1);
    const variables = admin.graphql.mock.calls[0][1].variables;
    expect(variables.query).toBe(
      "metafields.custom.date:2026-07-18 OR metafields.custom.date:2026-07-20",
    );
  });

  it("returns no bookings (and no Admin call) when no future capacity dates exist", async () => {
    const rules = makeRules({
      "2026-07-01": { "9AM-12PM": { capacity: 5, booked: 0 } },
    });
    const admin = makeAdmin([]);

    const snapshot = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(snapshot.bookings).toEqual([]);
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("matches METAFIELDS ONLY via the canonical comparator; skips cancelled/unknown/untracked", async () => {
    const rules = makeRules({
      "2026-07-18": {
        "9AM-12PM": { capacity: 5, booked: 0 },
        "3PM-6PM": { capacity: 2, booked: 0 },
      },
    });
    const admin = makeAdmin([
      ordersPage([
        { id: "gid://shopify/Order/1", date: "2026-07-18", slot: "9AM-12PM" },
        // tolerant variant still counts against the configured capacity key
        { id: "gid://shopify/Order/2", date: "2026-07-18", slot: "9:00am - 12:00pm" },
        // cancelled orders never count
        {
          id: "gid://shopify/Order/3",
          date: "2026-07-18",
          slot: "9AM-12PM",
          cancelledAt: "2026-07-14T00:00:00Z",
        },
        // date without configured capacity is ignored
        { id: "gid://shopify/Order/4", date: "2026-07-19", slot: "9AM-12PM" },
        // slot naming no configured slot is ignored
        { id: "gid://shopify/Order/5", date: "2026-07-18", slot: "morning" },
        // missing metafields (legacy tag/attribute-only order) is NOT counted
        { id: "gid://shopify/Order/6", date: null, slot: null },
      ]),
    ]);

    const snapshot = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(snapshot.bookings).toEqual([
      { orderId: "gid://shopify/Order/1", date: "2026-07-18", slotValue: "9AM-12PM" },
      { orderId: "gid://shopify/Order/2", date: "2026-07-18", slotValue: "9AM-12PM" },
    ]);
  });

  it("resolves counts onto pre-V2 capacity keys with case/spacing drift", async () => {
    const rules = makeRules({
      // stored before the strict write gate: key drifted from the slot value
      "2026-07-18": { "9am - 12pm": { capacity: 5, booked: 0 } },
    });
    const admin = makeAdmin([
      ordersPage([
        { id: "gid://shopify/Order/1", date: "2026-07-18", slot: "9AM-12PM" },
      ]),
    ]);

    const snapshot = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    // The booking lands on the CAPACITY KEY so applyAutomaticBookedCounts can
    // overlay it onto the stored map.
    expect(snapshot.bookings).toEqual([
      { orderId: "gid://shopify/Order/1", date: "2026-07-18", slotValue: "9am - 12pm" },
    ]);
  });

  it("paginates within a chunk until hasNextPage is false", async () => {
    const rules = makeRules({
      "2026-07-18": { "9AM-12PM": { capacity: 50, booked: 0 } },
    });
    const admin = makeAdmin([
      ordersPage(
        [{ id: "gid://shopify/Order/1", date: "2026-07-18", slot: "9AM-12PM" }],
        { hasNextPage: true, endCursor: "cursor-1" },
      ),
      ordersPage([
        { id: "gid://shopify/Order/2", date: "2026-07-18", slot: "9AM-12PM" },
      ]),
    ]);

    const snapshot = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(admin.graphql).toHaveBeenCalledTimes(2);
    expect(admin.graphql.mock.calls[1][1].variables.after).toBe("cursor-1");
    expect(snapshot.bookings).toHaveLength(2);
  });

  it("throws on GraphQL errors (caller fails open, visibly)", async () => {
    const rules = makeRules({
      "2026-07-18": { "9AM-12PM": { capacity: 5, booked: 0 } },
    });
    const admin = makeAdmin([
      {
        ok: true,
        json: async () => ({ errors: [{ message: "THROTTLED" }] }),
      } as unknown as Response,
    ]);

    await expect(getDeliveryBookingsSnapshot(SHOP, admin, rules)).rejects.toThrow(
      "THROTTLED",
    );
  });

  it("throws the real message when Shopify returns errors as a plain string (auth failures)", async () => {
    const rules = makeRules({
      "2026-07-18": { "9AM-12PM": { capacity: 5, booked: 0 } },
    });
    const admin = makeAdmin([
      {
        ok: false,
        json: async () => ({
          errors: "[API] Invalid API key or access token",
        }),
      } as unknown as Response,
    ]);

    await expect(getDeliveryBookingsSnapshot(SHOP, admin, rules)).rejects.toThrow(
      "[API] Invalid API key or access token",
    );
  });
});

describe("getDeliveryBookingsSnapshot — truncation is reported, not just logged", () => {
  function futureDates(count: number): string[] {
    const dates: string[] = [];
    for (let offset = 1; offset <= count; offset += 1) {
      const date = new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);
      dates.push(date.toISOString().slice(0, 10));
    }
    return dates;
  }

  function capacityFor(dates: string[]): DeliveryScheduleRules["slotCapacity"] {
    return Object.fromEntries(
      dates.map((date) => [date, { "9AM-12PM": { capacity: 5, booked: 0 } }]),
    );
  }

  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarn.mockRestore();
  });

  it("reports no truncation when the whole tracked set is scanned", async () => {
    const rules = makeRules({
      "2026-07-18": { "9AM-12PM": { capacity: 5, booked: 0 } },
    });
    const admin = makeAdmin([
      ordersPage([
        { id: "gid://shopify/Order/1", date: "2026-07-18", slot: "9AM-12PM" },
      ]),
    ]);

    const snapshot = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(snapshot.truncation).toBeNull();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("reports the chunk's dates when the page cap stops pagination mid-chunk", async () => {
    const dates = futureDates(2);
    const rules = makeRules(capacityFor(dates));
    // Every page claims another page: the scan stops at MAX_PAGES_PER_CHUNK (5).
    const admin = makeAdmin(
      Array.from({ length: 5 }, (_unused, page) =>
        ordersPage(
          [
            {
              id: `gid://shopify/Order/${page}`,
              date: dates[0],
              slot: "9AM-12PM",
            },
          ],
          { hasNextPage: true, endCursor: `cursor-${page}` },
        ),
      ),
    );

    const snapshot = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(admin.graphql).toHaveBeenCalledTimes(5);
    expect(snapshot.bookings).toHaveLength(5);
    expect(snapshot.truncation).toEqual({
      droppedDates: [],
      pagedOutDates: dates,
    });
    expect(consoleWarn).toHaveBeenCalled();
  });

  it("reports the dates dropped past the tracked-date cap (they would count 0)", async () => {
    const dates = futureDates(123);
    const rules = makeRules(capacityFor(dates));
    // 120 tracked dates / 30 per chunk = 4 queries, all complete.
    const admin = makeAdmin([
      ordersPage([]),
      ordersPage([]),
      ordersPage([]),
      ordersPage([]),
    ]);

    const snapshot = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(admin.graphql).toHaveBeenCalledTimes(4);
    expect(snapshot.truncation).toEqual({
      droppedDates: dates.slice(120),
      pagedOutDates: [],
    });
    expect(consoleWarn).toHaveBeenCalled();
  });

  it("keeps a cached partial set partial (never re-reads as complete)", async () => {
    const dates = futureDates(1);
    const rules = makeRules(capacityFor(dates));
    const admin = makeAdmin(
      Array.from({ length: 5 }, (_unused, page) =>
        ordersPage([], { hasNextPage: true, endCursor: `cursor-${page}` }),
      ),
    );

    await getDeliveryBookingsSnapshot(SHOP, admin, rules);
    const cachedRead = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(admin.graphql).toHaveBeenCalledTimes(5);
    expect(cachedRead.fromCache).toBe(true);
    expect(cachedRead.truncation).toEqual({
      droppedDates: [],
      pagedOutDates: dates,
    });
  });
});

describe("getDeliveryBookingsSnapshot — 60s in-process cache", () => {
  const rules = makeRules({
    "2026-07-18": { "9AM-12PM": { capacity: 5, booked: 0 } },
  });
  const page = () =>
    ordersPage([
      { id: "gid://shopify/Order/1", date: "2026-07-18", slot: "9AM-12PM" },
    ]);

  it("serves the second read within TTL from cache (one Admin call)", async () => {
    const admin = makeAdmin([page()]);

    const first = await getDeliveryBookingsSnapshot(SHOP, admin, rules);
    const second = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(admin.graphql).toHaveBeenCalledTimes(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.bookings).toEqual(first.bookings);
  });

  it("refetches after the TTL expires", async () => {
    const admin = makeAdmin([page(), page()]);

    await getDeliveryBookingsSnapshot(SHOP, admin, rules);
    vi.advanceTimersByTime(61_000);
    const later = await getDeliveryBookingsSnapshot(SHOP, admin, rules);

    expect(admin.graphql).toHaveBeenCalledTimes(2);
    expect(later.fromCache).toBe(false);
  });

  it("refetches when the tracked-date set changes (signature mismatch)", async () => {
    const admin = makeAdmin([page(), page()]);

    await getDeliveryBookingsSnapshot(SHOP, admin, rules);
    const widerRules = makeRules({
      "2026-07-18": { "9AM-12PM": { capacity: 5, booked: 0 } },
      "2026-07-19": { "9AM-12PM": { capacity: 5, booked: 0 } },
    });
    const refreshed = await getDeliveryBookingsSnapshot(SHOP, admin, widerRules);

    expect(admin.graphql).toHaveBeenCalledTimes(2);
    expect(refreshed.fromCache).toBe(false);
  });

  it("refetches after explicit invalidation and on bypassCache", async () => {
    const admin = makeAdmin([page(), page(), page()]);

    await getDeliveryBookingsSnapshot(SHOP, admin, rules);
    invalidateDeliveryBookingsCache(SHOP);
    const afterInvalidate = await getDeliveryBookingsSnapshot(SHOP, admin, rules);
    const bypassed = await getDeliveryBookingsSnapshot(SHOP, admin, rules, {
      bypassCache: true,
    });

    expect(admin.graphql).toHaveBeenCalledTimes(3);
    expect(afterInvalidate.fromCache).toBe(false);
    expect(bypassed.fromCache).toBe(false);
  });
});

describe("deriveBookedCounts", () => {
  const bookings: DeliveryBooking[] = [
    { orderId: "gid://shopify/Order/11", date: "2026-07-18", slotValue: "9AM-12PM" },
    { orderId: "gid://shopify/Order/12", date: "2026-07-18", slotValue: "9AM-12PM" },
    { orderId: "gid://shopify/Order/13", date: "2026-07-18", slotValue: "3PM-6PM" },
  ];

  it("counts per date+slot capacity key", () => {
    expect(deriveBookedCounts(bookings)).toEqual({
      "2026-07-18": { "9AM-12PM": 2, "3PM-6PM": 1 },
    });
  });

  it("excludes the rescheduling order — GID or bare numeric id (DEF-14)", () => {
    expect(deriveBookedCounts(bookings, "gid://shopify/Order/11")).toEqual({
      "2026-07-18": { "9AM-12PM": 1, "3PM-6PM": 1 },
    });
    expect(deriveBookedCounts(bookings, "12")).toEqual({
      "2026-07-18": { "9AM-12PM": 1, "3PM-6PM": 1 },
    });
  });
});
