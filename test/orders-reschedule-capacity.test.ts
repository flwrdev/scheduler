import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliveryScheduleRules } from "../app/lib/delivery-availability";

// The merchant bulk-reschedule capacity projection (§5, REC-4): `booked` comes
// from the canonical booked-count matcher, so the "is this order actually
// moving into the target slot?" test has to be canonical on the slot half too.
// A raw string compare counted orders already sitting in the target slot under
// a drifted stored spelling as movers and fired a 409 for a limit that was
// never going to be exceeded.

const { rulesMock, rescheduleMock, stateNodes } = vi.hoisted(() => ({
  rulesMock: vi.fn(),
  rescheduleMock: vi.fn(),
  stateNodes: { value: [] as unknown[] },
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      admin: {
        graphql: async () =>
          new Response(JSON.stringify({ data: { nodes: stateNodes.value } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      session: { shop: "test-shop.myshopify.com" },
    }),
  },
}));

vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRulesWithBookedCounts: rulesMock,
}));

vi.mock("../app/services/reschedule-order-delivery.server", () => ({
  rescheduleOrderDelivery: rescheduleMock,
}));

import { action, type BulkActionResponse } from "../app/routes/app.orders";

const TARGET_DATE = "2026-08-15";
const TARGET_SLOT = "9AM-12PM";

function makeRules(booked: number, capacity: number): DeliveryScheduleRules {
  return {
    timezone: "Asia/Manila",
    cutoffHour: 17,
    prepHours: 1,
    maxDays: 25,
    slots: [
      { display: "9AM-12PM", value: "9AM-12PM" },
      { display: "3PM-6PM", value: "3PM-6PM" },
    ],
    disabledDates: [],
    disabledSlots: {},
    slotCapacity: { [TARGET_DATE]: { [TARGET_SLOT]: { capacity, booked } } },
  };
}

function orderState(
  index: number,
  date: string | null,
  timeSlot: string | null,
) {
  return {
    id: `gid://shopify/Order/${1000 + index}`,
    tags: [],
    customAttributes: [],
    currentDeliveryDate: date == null ? null : { value: date },
    currentDeliveryTimeSlot: timeSlot == null ? null : { value: timeSlot },
    rescheduleHistory: null,
  };
}

async function runReschedule(): Promise<{
  status: number;
  body: BulkActionResponse;
}> {
  const fd = new FormData();
  fd.set("_action", "reschedule");
  fd.set("date", TARGET_DATE);
  fd.set("timeSlot", TARGET_SLOT);
  for (const node of stateNodes.value as Array<{ id: string }>) {
    fd.append("orderId", node.id);
  }
  const response = await action({
    request: new Request("https://app.example.com/app/orders", {
      method: "POST",
      body: fd,
    }),
  });
  return { status: response.status, body: await response.json() };
}

describe("merchant bulk reschedule — capacity projection", () => {
  beforeEach(() => {
    rescheduleMock.mockReset();
    rescheduleMock.mockResolvedValue({
      ok: true,
      historySync: "ok",
      attributeSync: "ok",
      tagSync: "ok",
      canonicalErrors: { graphql: [], user: [] },
    });
    rulesMock.mockReset();
  });

  it("does not count orders already in the target date+slot under a drifted spelling", async () => {
    // booked (3) ALREADY counts these three canonically — projecting them as
    // movers would read 6/5 and block the merchant on a no-op reschedule.
    rulesMock.mockResolvedValue(makeRules(3, 5));
    stateNodes.value = [
      orderState(1, TARGET_DATE, "9:00AM - 12:00PM"),
      orderState(2, TARGET_DATE, "9:00am-12:00pm"),
      orderState(3, TARGET_DATE, " 9AM - 12PM "),
    ];

    const { status, body } = await runReschedule();

    expect(status).toBe(200);
    expect(body.code).toBeUndefined();
    expect(rescheduleMock).toHaveBeenCalledTimes(3);
  });

  it("counts an order on the same slot but a different date as moving", async () => {
    rulesMock.mockResolvedValue(makeRules(3, 5));
    stateNodes.value = [
      orderState(1, "2026-08-14", TARGET_SLOT),
      orderState(2, "2026-08-14", "9:00AM - 12:00PM"),
      orderState(3, "2026-08-16", TARGET_SLOT),
    ];

    const { status, body } = await runReschedule();

    expect(status).toBe(409);
    expect(body.code).toBe("capacity_override_required");
    expect(body.capacity).toEqual({
      capacity: 5,
      booked: 3,
      moving: 3,
      projected: 6,
    });
    expect(rescheduleMock).not.toHaveBeenCalled();
  });

  it("counts an unscheduled order as moving", async () => {
    rulesMock.mockResolvedValue(makeRules(3, 3));
    stateNodes.value = [orderState(1, null, null)];

    const { status, body } = await runReschedule();

    expect(status).toBe(409);
    expect(body.code).toBe("capacity_override_required");
    expect(body.capacity).toMatchObject({ moving: 1, projected: 4 });
    expect(rescheduleMock).not.toHaveBeenCalled();
  });

  it("still writes when the merchant confirms the override", async () => {
    rulesMock.mockResolvedValue(makeRules(3, 3));
    stateNodes.value = [orderState(1, null, null)];

    const fd = new FormData();
    fd.set("_action", "reschedule");
    fd.set("date", TARGET_DATE);
    fd.set("timeSlot", TARGET_SLOT);
    fd.set("capacityOverride", "1");
    fd.append("orderId", "gid://shopify/Order/1001");
    const response = await action({
      request: new Request("https://app.example.com/app/orders", {
        method: "POST",
        body: fd,
      }),
    });

    expect(response.status).toBe(200);
    expect(rescheduleMock).toHaveBeenCalledTimes(1);
  });
});
