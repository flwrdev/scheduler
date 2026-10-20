/// <reference types="@shopify/ui-extensions/admin.order-details.block.render" />
// order-delivery-block — the read-only Delivery Schedule card on the Shopify
// admin order page (docs/api.md §2: reads only, never writes).
//
// Its whole job is one Admin GraphQL read plus a legacy fallback: orders
// written before the metafield contract carry the date/slot as customAttributes
// ("Delivery Date" / "Delivery Time"), and those must still render.
//
// It also renders the reschedule timestamp, and carries the same 2026-08-14 fix
// as the sibling action extension: `$app:reschedule_requested_at` holds UTC, so
// printing it raw made a 4:07 AM Manila reschedule read as the PREVIOUS day
// (prod #4068). That wrap is pinned under TWO shop timezones — with only one, a
// runner whose own zone matched it would still pass if the extension stopped
// passing `shopTimezone`, because the fallback formats in the VIEWER's zone.
import { getExtension } from "@shopify/ui-extensions-tester";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatRescheduledAt } from "../src/format-timestamp.js";

const extension = getExtension("admin.order-details.block.render");

// 06:23 UTC = 2:23 PM in Manila, 2:23 AM in New York.
const REQUESTED_AT = "2026-08-14T06:23:11Z";
const SHOP_TIMEZONES = ["Asia/Manila", "America/New_York"] as const;

type OrderNode = {
  customAttributes?: Array<{ key: string; value: string }>;
  deliveryDate?: { value: string } | null;
  timeSlot?: { value: string } | null;
  rescheduleRequestedAt?: { value: string } | null;
  rescheduleStatus?: { value: string } | null;
};

// The exact GraphQL response shape `fetchOrderDelivery` destructures.
function stubGraphql(order: OrderNode | null, ianaTimezone = "Asia/Manila") {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { shop: { ianaTimezone }, order } }),
      ),
  );
  extension.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

function texts() {
  return [...document.body.querySelectorAll("s-text")].map(
    (node) => node.textContent ?? "",
  );
}

beforeEach(() => {
  extension.setUp();
});

afterEach(() => {
  extension.tearDown();
  vi.restoreAllMocks();
});

describe("order-delivery-block admin block", () => {
  it("renders the date and slot from the custom.* metafields", async () => {
    const fetchMock = stubGraphql({
      customAttributes: [],
      deliveryDate: { value: "2026-09-02" },
      timeSlot: { value: "9AM-12PM" },
      rescheduleRequestedAt: null,
      rescheduleStatus: null,
    });

    await extension.render();

    // The read goes to the Admin GraphQL API through the direct-access URL.
    expect(fetchMock).toHaveBeenCalledWith(
      "shopify:admin/api/graphql.json",
      expect.objectContaining({ method: "POST" }),
    );

    const block = document.body.querySelector("s-admin-block");
    expect(block?.getAttribute("heading")).toBe("Delivery Schedule");
    expect(texts()).toEqual([
      "Delivery date",
      "2026-09-02",
      "Time slot",
      "9AM-12PM",
    ]);
  });

  it("renders the no-order empty state without querying Admin", async () => {
    const fetchMock = stubGraphql(null);
    extension.shopify.data.selected = [];

    await extension.render();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      document.body.querySelector("s-admin-block")?.getAttribute("heading"),
    ).toBe("Delivery Schedule");
    expect(texts()).toEqual(["No order selected."]);
  });

  it("renders this instant differently in the two shop timezones under test", () => {
    // The premise the pin below rests on.
    const [manila, newYork] = SHOP_TIMEZONES.map((timezone) =>
      formatRescheduledAt(REQUESTED_AT, timezone),
    );
    expect(manila).not.toBe(newYork);
    expect(manila).not.toBe(REQUESTED_AT);
    expect(newYork).not.toBe(REQUESTED_AT);
  });

  it.each(SHOP_TIMEZONES)(
    "renders the reschedule timestamp in the shop timezone %s, never the raw ISO",
    async (timezone) => {
      stubGraphql(
        {
          customAttributes: [],
          deliveryDate: { value: "2026-08-20" },
          timeSlot: { value: "9AM-12PM" },
          rescheduleRequestedAt: { value: REQUESTED_AT },
          rescheduleStatus: { value: "confirmed" },
        },
        timezone,
      );

      await extension.render();

      expect(texts()).toContain("Rescheduled at");
      expect(texts()).toContain(formatRescheduledAt(REQUESTED_AT, timezone));
      expect(document.body.textContent).not.toContain(REQUESTED_AT);
    },
  );

  it("falls back to the legacy customAttributes when the metafields are null", async () => {
    stubGraphql({
      customAttributes: [
        { key: "Delivery Date", value: "2026-09-05" },
        { key: "Delivery Time", value: "6PM-11PM" },
      ],
      deliveryDate: null,
      timeSlot: null,
      rescheduleRequestedAt: null,
      rescheduleStatus: null,
    });

    await extension.render();

    expect(texts()).toEqual([
      "Delivery date",
      "2026-09-05",
      "Time slot",
      "6PM-11PM",
    ]);
  });
});
