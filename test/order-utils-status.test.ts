import { describe, it, expect } from "vitest";
import {
  type Order,
  isCancelled,
  fulfillmentBadge,
  isOpenDeliverableOrder,
  getDeliveryStatus,
  getOrderPhone,
  getReceiverPhone,
  getFulfilledAt,
  getDeliveredAt,
  getEmailSentEvents,
} from "../app/lib/order-utils";

// S11: cancelled orders keep displayFulfillmentStatus === "UNFULFILLED", so
// every status surface must consult cancelledAt before the raw status.

const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-07-08T00:00:00Z",
    cancelledAt: null,
    displayFulfillmentStatus: "UNFULFILLED",
    displayFinancialStatus: "PAID",
    tags: [],
    customer: null,
    deliveryDate: null,
    deliveryTimeSlot: null,
    customDate: null,
    customTimeSlot: null,
    rescheduleHistory: null,
    ...overrides,
  }) as Order;

describe("isCancelled", () => {
  it("is false without cancelledAt and true with it", () => {
    expect(isCancelled(order())).toBe(false);
    expect(isCancelled(order({ cancelledAt: "2026-07-12T00:00:00Z" }))).toBe(
      true,
    );
  });
});

describe("fulfillmentBadge", () => {
  it("renders the formatted fulfillment status for a live order", () => {
    expect(fulfillmentBadge(order())).toEqual({
      label: "Unfulfilled",
      tone: "caution",
    });
  });

  it("overrides with a critical Cancelled badge for a cancelled order", () => {
    expect(
      fulfillmentBadge(order({ cancelledAt: "2026-07-12T00:00:00Z" })),
    ).toEqual({ label: "Cancelled", tone: "critical" });
  });
});

describe("isOpenDeliverableOrder", () => {
  it("treats an unfulfilled, uncancelled order as open", () => {
    expect(isOpenDeliverableOrder(order())).toBe(true);
  });

  it("closes the order when cancelled — no Today/Overdue chips", () => {
    expect(
      isOpenDeliverableOrder(order({ cancelledAt: "2026-07-12T00:00:00Z" })),
    ).toBe(false);
  });

  it("closes the order when fulfilled", () => {
    expect(
      isOpenDeliverableOrder(order({ displayFulfillmentStatus: "FULFILLED" })),
    ).toBe(false);
  });
});

describe("getDeliveryStatus", () => {
  it("puts Cancelled ahead of every other derived status", () => {
    const cancelled = order({
      cancelledAt: "2026-07-12T00:00:00Z",
      displayFulfillmentStatus: "FULFILLED",
      deliveryDate: { value: "2026-07-18" },
    });
    expect(getDeliveryStatus(cancelled)).toEqual({
      label: "Cancelled",
      tone: "critical",
    });
  });

  it("still derives Scheduled for a dated live order", () => {
    expect(
      getDeliveryStatus(order({ deliveryDate: { value: "2026-07-18" } })),
    ).toEqual({ label: "Scheduled", tone: "success" });
  });
});

describe("getReceiverPhone", () => {
  const shippingAddress = {
    address1: "255 Kawit St",
    address2: null,
    city: "Manila",
    province: "Metro Manila",
    zip: null,
    country: "PH",
    phone: "+63 917 000 0001",
  };

  it("reads ONLY the shipping-address phone — never the customer's", () => {
    const o = order({
      shippingAddress,
      customer: {
        id: "gid://shopify/Customer/1",
        firstName: "Sender",
        lastName: "Person",
        defaultEmailAddress: null,
        defaultPhoneNumber: { phoneNumber: "+63 917 999 9999" },
      },
    } as Partial<Order>);
    expect(getReceiverPhone(o)).toBe("+63 917 000 0001");
    expect(getOrderPhone(o)).toBe("+63 917 999 9999");
  });

  it("returns an em dash when the shipping address has no phone", () => {
    expect(
      getReceiverPhone(
        order({
          shippingAddress: { ...shippingAddress, phone: null },
        } as Partial<Order>),
      ),
    ).toBe("—");
  });
});

describe("getFulfilledAt", () => {
  it("returns null when there are no fulfillments", () => {
    expect(getFulfilledAt(order())).toBeNull();
    expect(getFulfilledAt(order({ fulfillments: [] }))).toBeNull();
  });

  it("returns the earliest fulfillment createdAt", () => {
    const o = order({
      fulfillments: [
        { createdAt: "2026-08-10T00:00:00Z", deliveredAt: null },
        { createdAt: "2026-08-05T00:00:00Z", deliveredAt: null },
      ],
    });
    expect(getFulfilledAt(o)).toBe("2026-08-05T00:00:00Z");
  });
});

describe("getDeliveredAt", () => {
  it("returns null when no fulfillment has a deliveredAt", () => {
    const o = order({
      fulfillments: [{ createdAt: "2026-08-10T00:00:00Z", deliveredAt: null }],
    });
    expect(getDeliveredAt(o)).toBeNull();
  });

  it("returns the earliest non-null deliveredAt", () => {
    const o = order({
      fulfillments: [
        { createdAt: "2026-08-05T00:00:00Z", deliveredAt: "2026-08-12T00:00:00Z" },
        { createdAt: "2026-08-01T00:00:00Z", deliveredAt: "2026-08-09T00:00:00Z" },
      ],
    });
    expect(getDeliveredAt(o)).toBe("2026-08-09T00:00:00Z");
  });
});

describe("getEmailSentEvents", () => {
  it("returns an empty array when there is no email log", () => {
    expect(getEmailSentEvents(order())).toEqual([]);
  });

  it("returns the order's email log as-is", () => {
    const emailLog = [{ sentAt: "2026-08-10T00:00:00Z", to: "a@b.com" }];
    expect(getEmailSentEvents(order({ emailLog }))).toEqual(emailLog);
  });
});
