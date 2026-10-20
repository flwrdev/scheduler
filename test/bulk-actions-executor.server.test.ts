import { beforeEach, describe, expect, it, vi } from "vitest";

// The executor's retry-idempotency behaviors (the
// pre-existing op behaviors stay pinned by the route-level tests, e.g.
// orders-reschedule-capacity.test.ts):
// - cancel: "already cancelled" on a re-run reports success;
// - markFulfilled: nothing fulfillable + displayFulfillmentStatus FULFILLED
//   reports success ("Already fulfilled"), while a genuinely unfulfillable
//   order still reports the failure;
// - reschedule: metafields EXACTLY at the target skip the write (no duplicate
//   history), while a drifted spelling still gets the repair write.

const { rescheduleMock, rulesMock, noticeMock } = vi.hoisted(() => ({
  rescheduleMock: vi.fn(),
  rulesMock: vi.fn(),
  noticeMock: vi.fn(),
}));

vi.mock("../app/services/reschedule-order-delivery.server", () => ({
  rescheduleOrderDelivery: rescheduleMock,
}));

vi.mock("../app/services/reschedule-notice.server", () => ({
  sendRescheduleNotice: noticeMock,
}));

vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRules: rulesMock,
}));

import { executeBulkAction } from "../app/services/bulk-actions.server";

const SHOP = "flowercart-dev.myshopify.com";
const ORDER_1 = "gid://shopify/Order/1001";

function gqlResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin(responder: (query: string, variables?: Record<string, unknown>) => unknown) {
  return {
    graphql: vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) =>
      gqlResponse(responder(query, options?.variables)),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rulesMock.mockResolvedValue({ timezone: "Asia/Manila" });
  rescheduleMock.mockResolvedValue({
    ok: true,
    historySync: "ok",
    attributeSync: "ok",
    tagSync: "ok",
    canonicalErrors: { graphql: [], user: [] },
  });
  noticeMock.mockResolvedValue({ status: "sent", to: "buyer@example.com" });
});

describe("executeBulkAction — cancel retry idempotency", () => {
  it("reports an already-cancelled order as success on a re-run", async () => {
    const admin = makeAdmin(() => ({
      data: {
        orderCancel: {
          job: null,
          orderCancelUserErrors: [{ message: "Order has already been canceled." }],
        },
      },
    }));
    const results = await executeBulkAction(
      admin,
      SHOP,
      { op: "cancel", reason: "CUSTOMER", restock: false, notifyCustomer: false, staffNote: null },
      [ORDER_1],
    );
    expect(results).toEqual([
      { orderId: ORDER_1, success: true, message: "Already cancelled." },
    ]);
  });

  it("still reports a genuine cancel failure as failure", async () => {
    const admin = makeAdmin(() => ({
      data: {
        orderCancel: {
          job: null,
          orderCancelUserErrors: [{ message: "Payment cannot be refunded." }],
        },
      },
    }));
    const results = await executeBulkAction(
      admin,
      SHOP,
      { op: "cancel", reason: "CUSTOMER", restock: false, notifyCustomer: false, staffNote: null },
      [ORDER_1],
    );
    expect(results[0].success).toBe(false);
  });
});

describe("executeBulkAction — markFulfilled retry idempotency", () => {
  function fulfillmentAdmin(displayStatus: string) {
    return makeAdmin((query) => {
      if (query.includes("BatchFulfillmentOrders")) {
        return {
          data: {
            o0: {
              id: ORDER_1,
              displayFulfillmentStatus: displayStatus,
              fulfillmentOrders: { nodes: [] },
            },
          },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
  }

  it("nothing fulfillable + FULFILLED → success (a crash-retry re-run)", async () => {
    const results = await executeBulkAction(
      fulfillmentAdmin("FULFILLED"),
      SHOP,
      { op: "markFulfilled", trackingUrl: "", notifyCustomer: false },
      [ORDER_1],
    );
    expect(results).toEqual([
      { orderId: ORDER_1, success: true, message: "Already fulfilled." },
    ]);
  });

  it("nothing fulfillable + NOT fulfilled → still the original failure", async () => {
    const results = await executeBulkAction(
      fulfillmentAdmin("UNFULFILLED"),
      SHOP,
      { op: "markFulfilled", trackingUrl: "", notifyCustomer: false },
      [ORDER_1],
    );
    expect(results).toEqual([
      { orderId: ORDER_1, success: false, message: "No fulfillable items remaining." },
    ]);
  });
});

describe("executeBulkAction — reschedule skip guard", () => {
  function stateAdmin(metaDate: string | null, metaSlot: string | null) {
    return makeAdmin((query) => {
      if (query.includes("RescheduleOrderStates")) {
        return {
          data: {
            nodes: [
              {
                id: ORDER_1,
                name: "#1001",
                email: "buyer@example.com",
                customer: {
                  firstName: "Ana",
                  defaultEmailAddress: { emailAddress: "buyer@example.com" },
                },
                tags: [],
                customAttributes: [],
                currentDeliveryDate: metaDate == null ? null : { value: metaDate },
                currentDeliveryTimeSlot: metaSlot == null ? null : { value: metaSlot },
                rescheduleHistory: null,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
  }

  const params = {
    op: "reschedule" as const,
    date: "2026-08-30",
    timeSlot: "9AM-12PM",
    requestedAt: "2026-08-27T00:00:00.000Z",
    shopTimezone: "Asia/Manila",
  };

  it("metafields EXACTLY at the target → skip, success, no write", async () => {
    const results = await executeBulkAction(
      stateAdmin("2026-08-30", "9AM-12PM"),
      SHOP,
      params,
      [ORDER_1],
    );
    expect(results).toEqual([
      { orderId: ORDER_1, success: true, message: "Already at the selected date and slot." },
    ]);
    expect(rescheduleMock).not.toHaveBeenCalled();
  });

  it("a DRIFTED spelling still gets the repair write (pinned §5 behavior)", async () => {
    const results = await executeBulkAction(
      stateAdmin("2026-08-30", "9:00AM - 12:00PM"),
      SHOP,
      params,
      [ORDER_1],
    );
    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toBeUndefined();
  });

  it("the requestedAt snapshot flows into the write (stable across chunks/retries)", async () => {
    await executeBulkAction(stateAdmin("2026-08-20", "3PM-6PM"), SHOP, params, [ORDER_1]);
    expect(rescheduleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestedAt: "2026-08-27T00:00:00.000Z",
        source: "merchant",
        shopTimezone: "Asia/Manila",
      }),
    );
  });
});

// 2026-09-04: customer notice after a merchant reschedule — sent only after a
// successful write, reported in the item message, never a failure.
describe("executeBulkAction — reschedule customer notice", () => {
  function stateAdmin(metaDate: string | null, metaSlot: string | null) {
    return makeAdmin((query) => {
      if (query.includes("RescheduleOrderStates")) {
        return {
          data: {
            nodes: [
              {
                id: ORDER_1,
                name: "#1001",
                email: "fallback@example.com",
                customer: {
                  firstName: "Ana",
                  defaultEmailAddress: { emailAddress: "buyer@example.com" },
                },
                tags: [],
                customAttributes: [],
                currentDeliveryDate: metaDate == null ? null : { value: metaDate },
                currentDeliveryTimeSlot: metaSlot == null ? null : { value: metaSlot },
                rescheduleHistory: null,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
  }

  const base = {
    op: "reschedule" as const,
    date: "2026-09-28",
    timeSlot: "9AM-12PM",
    requestedAt: "2026-09-04T00:00:00.000Z",
    shopTimezone: "Asia/Manila",
  };

  it("emails the customer (from the order's own address) after a successful write", async () => {
    const results = await executeBulkAction(
      stateAdmin("2026-09-04", "9AM-12PM"),
      SHOP,
      { ...base, notifyCustomer: true },
      [ORDER_1],
    );
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock).toHaveBeenCalledWith(SHOP, {
      orderId: ORDER_1,
      orderName: "#1001",
      to: "buyer@example.com",
      firstName: "Ana",
      fromDate: "2026-09-04",
      fromTimeSlot: "9AM-12PM",
      toDate: "2026-09-28",
      toTimeSlot: "9AM-12PM",
    });
    expect(results).toEqual([
      { orderId: ORDER_1, success: true, message: "Customer emailed at buyer@example.com." },
    ]);
  });

  it("does not email when the checkbox is off, when the field is absent (older jobs), or when nothing changed", async () => {
    await executeBulkAction(stateAdmin("2026-09-04", "9AM-12PM"), SHOP, { ...base, notifyCustomer: false }, [ORDER_1]);
    await executeBulkAction(stateAdmin("2026-09-04", "9AM-12PM"), SHOP, base, [ORDER_1]);
    await executeBulkAction(stateAdmin("2026-09-28", "9AM-12PM"), SHOP, { ...base, notifyCustomer: true }, [ORDER_1]);
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("does not email when the canonical write failed", async () => {
    rescheduleMock.mockResolvedValueOnce({
      ok: false,
      historySync: "skipped",
      attributeSync: "skipped",
      tagSync: "skipped",
      canonicalErrors: { graphql: [], user: ["boom"] },
    });
    const results = await executeBulkAction(
      stateAdmin("2026-09-04", "9AM-12PM"),
      SHOP,
      { ...base, notifyCustomer: true },
      [ORDER_1],
    );
    expect(results[0].success).toBe(false);
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("reports a failed or skipped notice inside a still-successful item", async () => {
    noticeMock.mockResolvedValueOnce({ status: "failed", error: "Mailbox rejected the message." });
    const failed = await executeBulkAction(
      stateAdmin("2026-09-04", "9AM-12PM"),
      SHOP,
      { ...base, notifyCustomer: true },
      [ORDER_1],
    );
    expect(failed).toEqual([
      { orderId: ORDER_1, success: true, message: "Customer email failed: Mailbox rejected the message." },
    ]);

    noticeMock.mockResolvedValueOnce({ status: "skipped_no_email" });
    const skipped = await executeBulkAction(
      stateAdmin("2026-09-04", "9AM-12PM"),
      SHOP,
      { ...base, notifyCustomer: true },
      [ORDER_1],
    );
    expect(skipped[0].message).toBe("No customer email on file, so no email was sent.");
  });

  it("keeps the mirror-sync note ahead of the notice note", async () => {
    rescheduleMock.mockResolvedValueOnce({
      ok: true,
      historySync: "ok",
      attributeSync: "ok",
      tagSync: "failed",
      canonicalErrors: { graphql: [], user: [] },
    });
    const results = await executeBulkAction(
      stateAdmin("2026-09-04", "9AM-12PM"),
      SHOP,
      { ...base, notifyCustomer: true },
      [ORDER_1],
    );
    expect(results[0].message).toBe(
      "Rescheduled, but the tags sync failed. Customer emailed at buyer@example.com.",
    );
  });
});
