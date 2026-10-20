import { describe, expect, it } from "vitest";

import {
  parseRescheduleHistory,
  rescheduleOrderDelivery,
  type RescheduleOrderDeliveryOptions,
} from "../app/services/reschedule-order-delivery.server";

// The service defines the ONE reschedule write sequence both the customer
// route and the merchant op share (REC-1). These tests pin that sequence and
// the payload shapes; the customer route's behavior parity follows from them.

type Call = { query: string; variables?: Record<string, unknown> };

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin(
  respond?: (query: string, index: number) => unknown | undefined,
) {
  const calls: Call[] = [];
  const admin = {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ): Promise<Response> => {
      const index = calls.length;
      calls.push({ query, variables: options?.variables });
      const overridden = respond?.(query, index);
      if (overridden !== undefined) return jsonResponse(overridden);
      if (query.includes("metafieldsSet")) {
        return jsonResponse({
          data: { metafieldsSet: { metafields: [], userErrors: [] } },
        });
      }
      if (query.includes("orderUpdate")) {
        return jsonResponse({
          data: { orderUpdate: { order: { id: "x" }, userErrors: [] } },
        });
      }
      if (query.includes("tagsRemove")) {
        return jsonResponse({
          data: { tagsRemove: { node: { id: "x" }, userErrors: [] } },
        });
      }
      if (query.includes("tagsAdd")) {
        return jsonResponse({
          data: { tagsAdd: { node: { id: "x" }, userErrors: [] } },
        });
      }
      return jsonResponse({ data: {} });
    },
  };
  return { admin, calls };
}

const baseOptions: RescheduleOrderDeliveryOptions = {
  orderId: "gid://shopify/Order/123",
  date: "2026-07-20",
  timeSlot: "3PM-6PM",
  source: "customer",
  currentDeliveryDate: "2026-07-15",
  currentDeliveryTimeSlot: "9AM-12PM",
  currentTags: ["2026-07-15", "9AM-12PM", "vip"],
  currentCustomAttributes: [
    { key: "Delivery Date", value: "2026-07-15" },
    { key: "Delivery Time", value: "9AM-12PM" },
    { key: "Sender Phone", value: "0917 000 0000" },
  ],
  existingRescheduleHistoryValue: null,
  requestedAt: "2026-07-11T12:00:00.000Z",
};

function metafieldsOf(call: Call): Array<Record<string, string>> {
  return (call.variables?.metafields ?? []) as Array<Record<string, string>>;
}

describe("rescheduleOrderDelivery — canonical write (REC-2)", () => {
  it("writes custom.*, the legacy mirrors, and the $app markers in ONE metafieldsSet", async () => {
    const { admin, calls } = makeAdmin();
    const result = await rescheduleOrderDelivery(admin, baseOptions);

    expect(result.ok).toBe(true);
    const canonical = metafieldsOf(calls[0]).map(
      (m) => `${m.namespace}.${m.key}=${m.value}`,
    );
    expect(canonical).toEqual(
      expect.arrayContaining([
        "custom.date=2026-07-20",
        "delivery.date=2026-07-20",
        "sidekick.delivery_date=2026-07-20",
        "custom.time_slot=3PM-6PM",
        "delivery.time_slot=3PM-6PM",
        "$app.reschedule_status=confirmed",
        "$app.reschedule_requested_at=2026-07-11T12:00:00.000Z",
      ]),
    );
    expect(canonical).toHaveLength(7);
  });

  it("rejects an invalid date without touching the API", async () => {
    const { admin, calls } = makeAdmin();
    const result = await rescheduleOrderDelivery(admin, {
      ...baseOptions,
      date: "07/20/2026",
    });

    expect(result.ok).toBe(false);
    expect(result.canonicalErrors.user).toContain(
      "date must be a valid YYYY-MM-DD string",
    );
    expect(calls).toHaveLength(0);
  });

  it("aborts every mirror step when the canonical write fails", async () => {
    const { admin, calls } = makeAdmin((query, index) =>
      index === 0
        ? {
            data: {
              metafieldsSet: {
                metafields: [],
                userErrors: [{ field: ["value"], message: "boom" }],
              },
            },
          }
        : undefined,
    );
    const result = await rescheduleOrderDelivery(admin, baseOptions);

    expect(result.ok).toBe(false);
    expect(result.canonicalErrors.user).toEqual(["boom"]);
    expect(result.historySync).toBe("skipped");
    expect(result.attributeSync).toBe("skipped");
    expect(result.tagSync).toBe("skipped");
    expect(calls).toHaveLength(1);
  });
});

describe("rescheduleOrderDelivery — write sequence & mirrors", () => {
  it("runs metafields → history → attributes → tags in order (customer source)", async () => {
    const { admin, calls } = makeAdmin();
    const result = await rescheduleOrderDelivery(admin, baseOptions);

    expect(result).toMatchObject({
      ok: true,
      historySync: "updated",
      attributeSync: "updated",
      tagSync: "updated",
    });
    expect(calls.map((c) => c.query.includes("metafieldsSet"))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(calls[2].query).toContain("orderUpdate");
    expect(calls[3].query).toContain("tagsRemove");
    expect(calls[4].query).toContain("tagsAdd");

    // History event: from = pre-overwrite selection, source recorded.
    const historyValue = JSON.parse(metafieldsOf(calls[1])[0].value);
    expect(historyValue).toEqual([
      {
        fromDate: "2026-07-15",
        fromTimeSlot: "9AM-12PM",
        toDate: "2026-07-20",
        toTimeSlot: "3PM-6PM",
        requestedAt: "2026-07-11T12:00:00.000Z",
        status: "confirmed",
        source: "customer",
      },
    ]);

    // Attributes: delivery keys rewritten, unrelated attributes preserved.
    const input = calls[2].variables?.input as {
      customAttributes: Array<{ key: string; value: string }>;
    };
    expect(input.customAttributes).toEqual([
      { key: "Delivery Date", value: "2026-07-20" },
      { key: "Delivery Time", value: "3PM-6PM" },
      { key: "Sender Phone", value: "0917 000 0000" },
    ]);

    // Tags: only the schedule tags are removed; the customer source adds the
    // resched self-service LOCK alongside the new date + slot, plus the
    // `resched-<date>` timeline event tag. The event date is stamped from
    // requestedAt in the shop's zone (2026-07-11T12:00Z is 8 PM in Manila),
    // so it cannot drift from the reschedule_history timestamp.
    expect(calls[3].variables?.tags).toEqual(["2026-07-15", "9AM-12PM"]);
    expect(calls[4].variables?.tags).toEqual([
      "2026-07-20",
      "3PM-6PM",
      "resched",
      "resched-2026-07-11",
    ]);
  });

  it("does NOT add the resched lock tag for a merchant-sourced reschedule", async () => {
    const { admin, calls } = makeAdmin();
    await rescheduleOrderDelivery(admin, {
      ...baseOptions,
      source: "merchant",
    });

    // The LOCK is customer-only; the timeline event tag is written on both
    // paths, so a merchant override still shows up on the merchant's timeline.
    const addCall = calls.find((c) => c.query.includes("tagsAdd"));
    expect(addCall?.variables?.tags).toEqual([
      "2026-07-20",
      "3PM-6PM",
      "resched-2026-07-11",
    ]);
    const historyValue = JSON.parse(metafieldsOf(calls[1])[0].value);
    expect(historyValue[0].source).toBe("merchant");
  });

  it("appends to the existing history instead of replacing it", async () => {
    const existing = [
      {
        fromDate: "2026-07-10",
        fromTimeSlot: "12PM-3PM",
        toDate: "2026-07-15",
        toTimeSlot: "9AM-12PM",
        requestedAt: "2026-07-01T00:00:00.000Z",
        status: "confirmed",
        source: "customer",
      },
    ];
    const { admin, calls } = makeAdmin();
    await rescheduleOrderDelivery(admin, {
      ...baseOptions,
      existingRescheduleHistoryValue: JSON.stringify(existing),
    });

    const historyValue = JSON.parse(metafieldsOf(calls[1])[0].value);
    expect(historyValue).toHaveLength(2);
    expect(historyValue[0]).toEqual(existing[0]);
    expect(historyValue[1].toDate).toBe("2026-07-20");
  });

  it("continues with attributes + tags when the history write fails", async () => {
    const { admin, calls } = makeAdmin((query, index) =>
      index === 1
        ? { errors: [{ message: "history unavailable" }] }
        : undefined,
    );
    const result = await rescheduleOrderDelivery(admin, baseOptions);

    expect(result.ok).toBe(true);
    expect(result.historySync).toBe("failed");
    expect(result.attributeSync).toBe("updated");
    expect(result.tagSync).toBe("updated");
    expect(calls.some((c) => c.query.includes("orderUpdate"))).toBe(true);
    expect(calls.some((c) => c.query.includes("tagsAdd"))).toBe(true);
  });

  it("skips tagsRemove when the order has no existing schedule tags", async () => {
    const { admin, calls } = makeAdmin();
    await rescheduleOrderDelivery(admin, {
      ...baseOptions,
      currentTags: ["vip"],
    });

    expect(calls.some((c) => c.query.includes("tagsRemove"))).toBe(false);
    const addCall = calls.find((c) => c.query.includes("tagsAdd"));
    expect(addCall?.variables?.tags).toEqual([
      "2026-07-20",
      "3PM-6PM",
      "resched",
      "resched-2026-07-11",
    ]);
  });

  it("stamps the event tag on the SHOP's day, not the server's or UTC's", async () => {
    // 2026-07-11T20:07Z is 4:07 AM on the 12th in Manila. Stamping UTC here is
    // the same off-by-one-day class of bug that made the admin order page show
    // a reschedule as happening before the order was placed (prod #4068).
    const { admin, calls } = makeAdmin();
    await rescheduleOrderDelivery(admin, {
      ...baseOptions,
      source: "merchant",
      requestedAt: "2026-07-11T20:07:25.285Z",
      shopTimezone: "Asia/Manila",
    });

    const addCall = calls.find((c) => c.query.includes("tagsAdd"));
    expect(addCall?.variables?.tags).toContain("resched-2026-07-12");
    expect(addCall?.variables?.tags).not.toContain("resched-2026-07-11");
  });

  it("still writes the schedule tags when the event tag cannot be built", async () => {
    // An unusable requestedAt must not cost the order its date/slot tags.
    const { admin, calls } = makeAdmin();
    const result = await rescheduleOrderDelivery(admin, {
      ...baseOptions,
      source: "merchant",
      requestedAt: "not a timestamp",
    });

    const addCall = calls.find((c) => c.query.includes("tagsAdd"));
    expect(addCall?.variables?.tags).toEqual(["2026-07-20", "3PM-6PM"]);
    expect(result.tagSync).toBe("updated");
  });
});

describe("parseRescheduleHistory", () => {
  it("tolerates null, junk, and non-array JSON", () => {
    expect(parseRescheduleHistory(null)).toEqual([]);
    expect(parseRescheduleHistory("not json")).toEqual([]);
    expect(parseRescheduleHistory('{"events":[]}')).toEqual([]);
    expect(parseRescheduleHistory("[]")).toEqual([]);
  });
});
