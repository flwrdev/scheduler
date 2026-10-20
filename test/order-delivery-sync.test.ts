import { describe, expect, it } from "vitest";

import type { DeliveryScheduleRules } from "../app/lib/delivery-availability";
import {
  buildOrderDeliveryMetafields,
  evaluateDeliverySyncStatus,
  resolveOrderCheckoutTime,
} from "../app/services/order-delivery-metafields.server";

// Scheduler V2 D4 (docs/scheduler-v2-ux.md §6): the orders/create webhook
// always syncs parseable delivery data, validates with CHECKOUT-TIME
// semantics (order created_at, not webhook processing time — DEF-7), and
// records the outcome on the additive `delivery.sync_status` metafield.
// Capacity is advisory: over-capacity maps to "attention:capacity" (§6.4).

const rules: DeliveryScheduleRules = {
  timezone: "Asia/Manila",
  cutoffHour: 17,
  prepHours: 1,
  maxDays: 25,
  slots: [
    { display: "Morning", value: "9AM-12PM" },
    { display: "Afternoon", value: "3PM-6PM" },
  ],
  disabledDates: ["2026-07-21"],
  disabledSlots: { "2026-07-18": ["9AM-12PM"] },
  slotCapacity: {
    "2026-07-19": { "9AM-12PM": { capacity: 1, booked: 1 } },
  },
};

// 10:00 AM Manila on 2026-07-15 — inside the window, before the 17:00 cutoff.
const CHECKOUT = new Date("2026-07-15T02:00:00Z");

describe("resolveOrderCheckoutTime", () => {
  it("parses the webhook payload's created_at", () => {
    const resolved = resolveOrderCheckoutTime({
      created_at: "2026-07-15T10:00:00+08:00",
    });
    expect(resolved.toISOString()).toBe("2026-07-15T02:00:00.000Z");
  });

  it("accepts the camelCase variant", () => {
    const resolved = resolveOrderCheckoutTime({
      createdAt: "2026-07-15T02:00:00Z",
    });
    expect(resolved.toISOString()).toBe("2026-07-15T02:00:00.000Z");
  });

  it("falls back to processing time when created_at is missing or garbage", () => {
    const fallback = new Date("2026-07-16T00:00:00Z");
    expect(resolveOrderCheckoutTime({}, fallback)).toBe(fallback);
    expect(resolveOrderCheckoutTime({ created_at: "not-a-date" }, fallback)).toBe(
      fallback,
    );
    expect(resolveOrderCheckoutTime({ created_at: 12345 }, fallback)).toBe(
      fallback,
    );
  });
});

describe("evaluateDeliverySyncStatus — checkout-time semantics (DEF-7)", () => {
  it("returns ok for a selection that was legal at checkout", () => {
    expect(
      evaluateDeliverySyncStatus(rules, "2026-07-20", "9AM-12PM", CHECKOUT),
    ).toBe("ok");
  });

  it("a webhook retried past the cutoff stays ok when checkout was before it", () => {
    // Same-day delivery bought at 10:00 AM Manila (legal: before the 17:00
    // cutoff, before the 3PM slot's prep deadline). The webhook is processed
    // at 20:00 Manila — evaluating with PROCESSING time rejects it, but
    // checkout-time semantics keep it ok (DEF-7).
    const lateProcessing = new Date("2026-07-15T12:00:00Z");

    expect(
      evaluateDeliverySyncStatus(rules, "2026-07-15", "3PM-6PM", CHECKOUT),
    ).toBe("ok");

    expect(
      evaluateDeliverySyncStatus(rules, "2026-07-15", "3PM-6PM", lateProcessing),
    ).not.toBe("ok");
  });

  it("flags a blocked date as attention:date_blocked", () => {
    expect(
      evaluateDeliverySyncStatus(rules, "2026-07-21", "9AM-12PM", CHECKOUT),
    ).toBe("attention:date_blocked");
  });

  it("flags an unknown slot as attention:slot_unknown", () => {
    expect(
      evaluateDeliverySyncStatus(rules, "2026-07-20", "midnightish", CHECKOUT),
    ).toBe("attention:slot_unknown");
  });

  it("flags an over-capacity slot as attention:capacity (advisory, §6.4)", () => {
    expect(
      evaluateDeliverySyncStatus(rules, "2026-07-19", "9AM-12PM", CHECKOUT),
    ).toBe("attention:capacity");
  });

  it("resolves tolerant slot variants before the capacity lookup", () => {
    expect(
      evaluateDeliverySyncStatus(rules, "2026-07-19", "9am - 12pm", CHECKOUT),
    ).toBe("attention:capacity");
  });

  it("a blocked slot is NOT reported as capacity", () => {
    const status = evaluateDeliverySyncStatus(
      rules,
      "2026-07-18",
      "9AM-12PM",
      CHECKOUT,
    );
    expect(status.startsWith("attention:")).toBe(true);
    expect(status).not.toBe("attention:capacity");
  });

  it("flags a malformed date as attention:invalid_date", () => {
    expect(
      evaluateDeliverySyncStatus(rules, "07/20/2026", "9AM-12PM", CHECKOUT),
    ).toBe("attention:invalid_date");
  });
});

describe("buildOrderDeliveryMetafields — additive sync_status (D4)", () => {
  const base = {
    orderId: "gid://shopify/Order/1",
    deliveryDate: "2026-07-20",
    timeSlot: "9AM-12PM",
  };

  it("appends delivery.sync_status only when provided", () => {
    const withStatus = buildOrderDeliveryMetafields({
      ...base,
      syncStatus: "attention:capacity",
    });
    const statusEntry = withStatus.find(
      (metafield) =>
        metafield.namespace === "delivery" && metafield.key === "sync_status",
    );
    expect(statusEntry).toMatchObject({
      value: "attention:capacity",
      type: "single_line_text_field",
      ownerId: base.orderId,
    });
    expect(withStatus).toHaveLength(6);
  });

  it("keeps the existing 5-metafield shape untouched when omitted", () => {
    const withoutStatus = buildOrderDeliveryMetafields(base);
    expect(withoutStatus).toHaveLength(5);
    expect(
      withoutStatus.some((metafield) => metafield.key === "sync_status"),
    ).toBe(false);
  });

  it("writes nothing (sync_status included) for an unparseable date", () => {
    expect(
      buildOrderDeliveryMetafields({
        ...base,
        deliveryDate: "July 20",
        syncStatus: "ok",
      }),
    ).toHaveLength(0);
  });
});
