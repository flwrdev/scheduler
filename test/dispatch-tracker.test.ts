import { describe, it, expect } from "vitest";
import {
  buildDispatchTracker,
  getDispatchStage,
} from "../app/lib/dispatch-tracker";
import type { Order } from "../app/lib/order-utils";

// Builds a small order; tests override only what they need.
const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-10-20T00:00:00Z",
    cancelledAt: null,
    displayFulfillmentStatus: "UNFULFILLED",
    displayFinancialStatus: "PAID",
    tags: [],
    customer: null,
    fulfillments: [],
    shippingAddress: {
      address1: "1 Rizal St",
      city: "Makati",
      latitude: 14.55,
      longitude: 121.02,
    },
    ...overrides,
  }) as unknown as Order;

describe("getDispatchStage", () => {
  it("is awaiting for an unfulfilled order", () => {
    expect(getDispatchStage(order())).toBe("awaiting");
  });

  it("is on_the_way for a fulfilled order", () => {
    expect(
      getDispatchStage(order({ displayFulfillmentStatus: "FULFILLED" })),
    ).toBe("on_the_way");
  });

  it("is delivered when a fulfillment has deliveredAt", () => {
    expect(
      getDispatchStage(
        order({
          displayFulfillmentStatus: "FULFILLED",
          fulfillments: [
            {
              createdAt: "2026-10-20T01:00:00Z",
              deliveredAt: "2026-10-20T03:00:00Z",
            },
          ],
        }),
      ),
    ).toBe("delivered");
  });

  it("is null for a cancelled order", () => {
    expect(
      getDispatchStage(order({ cancelledAt: "2026-10-20T00:00:00Z" })),
    ).toBeNull();
  });
});

describe("buildDispatchTracker", () => {
  it("pins orders with coordinates and counts the stages", () => {
    const { pins, summary } = buildDispatchTracker([
      order(),
      order({ id: "2", name: "#1002", displayFulfillmentStatus: "FULFILLED" }),
      order({ id: "3", cancelledAt: "2026-10-20T00:00:00Z" }),
    ]);
    expect(pins.map((p) => p.name)).toEqual(["#1001", "#1002"]);
    expect(pins[0].address).toBe("1 Rizal St, Makati");
    expect(summary).toEqual({
      awaiting: 1,
      on_the_way: 1,
      delivered: 0,
      unpinned: 0,
    });
  });

  it("counts orders without valid coordinates as unpinned", () => {
    const { pins, summary } = buildDispatchTracker([
      order({ shippingAddress: null }),
      order({
        id: "2",
        shippingAddress: {
          address1: "x",
          city: "y",
          latitude: 999,
          longitude: 1,
        },
      } as Partial<Order>),
    ]);
    expect(pins).toHaveLength(0);
    expect(summary.awaiting).toBe(2);
    expect(summary.unpinned).toBe(2);
  });
});
