import { describe, expect, it } from "vitest";

import type { Order } from "../app/lib/order-utils";
import {
  buildRecentRescheduleSearchQuery,
  buildRecentRescheduleTagQuery,
  formatShopLocalTime,
  latestRescheduleEvent,
  rescheduleBadgeLabel,
  selectRecentReschedules,
  shiftISODate,
} from "../app/lib/recent-reschedules";

// Shop-local context the loader passes: Manila, "today" = Sep 4 2026, and a
// fixed "now" of 12:00 PM Manila (04:00Z) so the 48-hour window is exact.
const MANILA = "Asia/Manila";
const TODAY = "2026-09-04";
const NOW = new Date("2026-09-04T04:00:00Z");

interface HistoryEvent {
  fromDate: string;
  fromTimeSlot: string;
  toDate: string;
  toTimeSlot: string;
  requestedAt: string;
  status: string;
  source: string;
}

const event = (over: Partial<HistoryEvent> = {}): HistoryEvent => ({
  fromDate: "2026-09-04",
  fromTimeSlot: "9AM-12PM",
  toDate: "2026-09-28",
  toTimeSlot: "9AM-12PM",
  requestedAt: "2026-09-04T00:47:01.792Z",
  status: "confirmed",
  source: "customer",
  ...over,
});

const order = (
  history: HistoryEvent[],
  overrides: Partial<Order> = {},
): Order =>
  ({
    id: "gid://shopify/Order/7201903673531",
    legacyResourceId: "7201903673531",
    name: "#4292",
    createdAt: "2026-09-01T12:51:55Z",
    cancelledAt: null,
    displayFulfillmentStatus: "UNFULFILLED",
    displayFinancialStatus: "PAID",
    tags: ["2026-09-28", "9AM-12PM", "resched", "resched-2026-09-04"],
    customer: {
      id: "gid://shopify/Customer/1",
      firstName: "DAVID",
      lastName: "Miranda",
      defaultEmailAddress: null,
      defaultPhoneNumber: null,
    },
    deliveryDate: null,
    deliveryTimeSlot: null,
    customDate: { value: "2026-09-28" },
    customTimeSlot: { value: "9AM-12PM" },
    rescheduleHistory: { value: JSON.stringify(history) },
    customAttributes: [],
    ...overrides,
  }) as Order;

describe("shiftISODate / formatShopLocalTime", () => {
  it("shifts calendar days without zone drift", () => {
    expect(shiftISODate("2026-09-04", -1)).toBe("2026-09-03");
    expect(shiftISODate("2026-09-01", -2)).toBe("2026-08-30");
    expect(shiftISODate("not-a-date", -1)).toBe("not-a-date");
  });

  it("formats the clock time in the shop's zone", () => {
    expect(formatShopLocalTime("2026-09-04T00:47:01.792Z", MANILA)).toBe("8:47 AM");
    expect(formatShopLocalTime("garbage", MANILA)).toBe("");
  });
});

describe("selectRecentReschedules", () => {
  it("surfaces a customer reschedule from today with shop-local labels", () => {
    const items = selectRecentReschedules([order([event()])], {
      now: NOW,
      todayISO: TODAY,
      timezone: MANILA,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      orderId: "gid://shopify/Order/7201903673531",
      legacyId: "7201903673531",
      name: "#4292",
      customerName: "DAVID Miranda",
      from: "Fri, Sep 4 9AM-12PM",
      to: "Mon, Sep 28 9AM-12PM",
      requestedAt: "2026-09-04T00:47:01.792Z",
      source: "customer",
      dayLabel: "Today",
      timeLabel: "8:47 AM",
    });
  });

  it("includes merchant reschedules by default and can be narrowed to customers", () => {
    const merchant = order([event({ source: "merchant" })]);
    const items = selectRecentReschedules([merchant], {
      now: NOW,
      todayISO: TODAY,
      timezone: MANILA,
    });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("merchant");
    expect(
      selectRecentReschedules([merchant], {
        now: NOW,
        todayISO: TODAY,
        timezone: MANILA,
        sources: ["customer"],
      }),
    ).toHaveLength(0);
  });

  it("drops events older than the 48-hour window and labels yesterday's", () => {
    const thirtyHoursAgo = new Date(NOW.getTime() - 30 * 3600 * 1000).toISOString();
    const fortyNineHoursAgo = new Date(NOW.getTime() - 49 * 3600 * 1000).toISOString();
    const items = selectRecentReschedules(
      [
        order([event({ requestedAt: thirtyHoursAgo })], { id: "gid://shopify/Order/1", name: "#1" }),
        order([event({ requestedAt: fortyNineHoursAgo })], { id: "gid://shopify/Order/2", name: "#2" }),
      ],
      { now: NOW, todayISO: TODAY, timezone: MANILA },
    );
    expect(items.map((i) => i.name)).toEqual(["#1"]);
    expect(items[0].dayLabel).toBe("Yesterday");
  });

  it("hides an event the merchant already marked seen, but not a newer one", () => {
    const seenSame = order([event()], {
      rescheduleSeenAt: { value: "2026-09-04T00:47:01.792Z" },
    });
    expect(
      selectRecentReschedules([seenSame], { now: NOW, todayISO: TODAY, timezone: MANILA }),
    ).toHaveLength(0);

    // Re-rescheduled after the acknowledgement → the newer event resurfaces.
    const rescheduledAgain = order(
      [
        event(),
        event({
          fromDate: "2026-09-28",
          toDate: "2026-09-30",
          requestedAt: "2026-09-04T02:00:00Z",
        }),
      ],
      { rescheduleSeenAt: { value: "2026-09-04T00:47:01.792Z" } },
    );
    const items = selectRecentReschedules([rescheduledAgain], {
      now: NOW,
      todayISO: TODAY,
      timezone: MANILA,
    });
    expect(items).toHaveLength(1);
    expect(items[0].to).toBe("Wed, Sep 30 9AM-12PM");
  });

  it("only counts confirmed events and sorts newest first", () => {
    const pending = order([event({ status: "pending" })], {
      id: "gid://shopify/Order/9",
      name: "#9",
    });
    const older = order([event({ requestedAt: "2026-09-04T00:10:00Z" })], {
      id: "gid://shopify/Order/8",
      name: "#8",
    });
    const items = selectRecentReschedules([pending, older, order([event()])], {
      now: NOW,
      todayISO: TODAY,
      timezone: MANILA,
    });
    expect(items.map((i) => i.name)).toEqual(["#4292", "#8"]);
  });

  it("ignores orders with no reschedule history", () => {
    expect(latestRescheduleEvent(order([]))).toBeNull();
    expect(
      selectRecentReschedules([order([])], { now: NOW, todayISO: TODAY, timezone: MANILA }),
    ).toHaveLength(0);
  });
});

describe("rescheduleBadgeLabel", () => {
  it("shows only the time for a same-day reschedule", () => {
    expect(rescheduleBadgeLabel(order([event()]), { todayISO: TODAY, timezone: MANILA })).toBe(
      "Rescheduled · 8:47 AM",
    );
  });

  it("adds the shop-local date for an older reschedule", () => {
    const yesterday = order([
      event({ requestedAt: "2026-09-03T09:09:10.210Z", source: "merchant" }),
    ]);
    expect(rescheduleBadgeLabel(yesterday, { todayISO: TODAY, timezone: MANILA })).toBe(
      "Rescheduled · Sep 3, 5:09 PM",
    );
  });

  it("returns null without a timestamped reschedule", () => {
    expect(rescheduleBadgeLabel(order([]), { todayISO: TODAY, timezone: MANILA })).toBeNull();
  });
});

describe("buildRecentRescheduleTagQuery", () => {
  it("ORs the reschedule event tag for today and the two prior shop-local days", () => {
    expect(buildRecentRescheduleTagQuery("2026-09-04")).toBe(
      "tag:resched-2026-09-04 OR tag:resched-2026-09-03 OR tag:resched-2026-09-02",
    );
  });

  it("crosses month boundaries and yields nothing for an unusable date", () => {
    expect(buildRecentRescheduleTagQuery("2026-09-01", 2)).toBe(
      "tag:resched-2026-09-01 OR tag:resched-2026-08-31",
    );
    expect(buildRecentRescheduleTagQuery("garbage")).toBe("");
  });
});

describe("buildRecentRescheduleSearchQuery", () => {
  it("wraps the tag OR and excludes archived orders, like every main view", () => {
    expect(buildRecentRescheduleSearchQuery("2026-09-04")).toBe(
      "(tag:resched-2026-09-04 OR tag:resched-2026-09-03 OR tag:resched-2026-09-02) -status:closed",
    );
    expect(buildRecentRescheduleSearchQuery("garbage")).toBe("");
  });
});
