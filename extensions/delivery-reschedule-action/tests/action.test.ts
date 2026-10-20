/// <reference types="@shopify/ui-extensions/admin.order-details.action.render" />
// delivery-reschedule-action — the read-only "Reschedule Status" admin action
// (docs/api.md §2: a single `query GetReschedule`, no mutations).
//
// The suite covers each status branch, and pins the 2026-08-14 timestamp fix:
// `$app:reschedule_requested_at` holds UTC, and printing it raw is how a 4:07 AM
// Manila reschedule displayed as the PREVIOUS day — reading as if the customer
// had rescheduled before they ordered (prod #4068). Every branch that shows a
// timestamp must run it through formatRescheduledAt with the SHOP's timezone,
// so the expected string is computed from that helper rather than hardcoded.
//
// The timestamp pin runs each branch under TWO shop timezones on purpose. With
// only one, a machine whose own TZ happens to equal it would pass even if the
// extension stopped passing `shopTimezone` at all — the fallback formats in the
// VIEWER's zone, which would coincidentally match. Two zones that render the
// same instant differently cannot both match the viewer's zone, so a dropped
// timezone argument fails at least one case on any runner.
import { getExtension } from "@shopify/ui-extensions-tester";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatRescheduledAt } from "../src/format-timestamp.js";

const extension = getExtension("admin.order-details.action.render");

// 06:23 UTC = 2:23 PM in Manila and 2:23 AM in New York, so the raw ISO string
// and the two shop-local renderings are all different — what makes this a usable
// regression pin regardless of where the test runner sits.
const REQUESTED_AT = "2026-08-14T06:23:11Z";
const SHOP_TIMEZONES = ["Asia/Manila", "America/New_York"] as const;
const DEFAULT_SHOP_TIMEZONE = SHOP_TIMEZONES[0];

type OrderNode = {
  rescheduleStatus?: { value: string } | null;
  rescheduleDate?: { value: string } | null;
  rescheduleTimeSlot?: { value: string } | null;
  requestedAt?: { value: string } | null;
};

function stubGraphql(
  order: OrderNode | null,
  ianaTimezone: string = DEFAULT_SHOP_TIMEZONE,
) {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { shop: { ianaTimezone }, order } }),
      ),
  );
  extension.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

function orderWithStatus(status: string): OrderNode {
  return {
    rescheduleStatus: { value: status },
    rescheduleDate: { value: "2026-08-20" },
    rescheduleTimeSlot: { value: "9AM-12PM" },
    requestedAt: { value: REQUESTED_AT },
  };
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

describe("delivery-reschedule-action admin action", () => {
  it("renders the confirmed branch with a success banner", async () => {
    stubGraphql(orderWithStatus("confirmed"));

    await extension.render();

    expect(
      document.body.querySelector("s-admin-action")?.getAttribute("heading"),
    ).toBe("Reschedule Status");
    expect(document.body.querySelector("s-banner")?.getAttribute("tone")).toBe(
      "success",
    );
    expect(texts()).toContain("Delivery date");
    expect(texts()).toContain("2026-08-20");
  });

  it("renders the rejected branch with a critical banner", async () => {
    stubGraphql(orderWithStatus("rejected"));

    await extension.render();

    expect(document.body.querySelector("s-banner")?.getAttribute("tone")).toBe(
      "critical",
    );
    expect(texts()).toContain("Requested date");
  });

  it("renders the legacy pending branch", async () => {
    stubGraphql(orderWithStatus("pending"));

    await extension.render();

    // Pending approval is no longer supported — the branch only explains itself.
    expect(document.body.querySelector("s-banner")).toBeNull();
    expect(document.body.textContent).toContain(
      "legacy pending reschedule status",
    );
  });

  it("renders this instant differently in the two shop timezones under test", () => {
    // The premise the pin below rests on: if these ever collapsed to the same
    // string, a dropped-timezone regression could slip through both cases.
    const [manila, newYork] = SHOP_TIMEZONES.map((timezone) =>
      formatRescheduledAt(REQUESTED_AT, timezone),
    );
    expect(manila).not.toBe(newYork);
    expect(manila).not.toBe(REQUESTED_AT);
    expect(newYork).not.toBe(REQUESTED_AT);
  });

  it.each(
    ["confirmed", "rejected", "pending"].flatMap((status) =>
      SHOP_TIMEZONES.map((timezone) => [status, timezone] as const),
    ),
  )(
    "renders the %s timestamp in the shop timezone %s, never the raw ISO",
    async (status, timezone) => {
      stubGraphql(orderWithStatus(status), timezone);

      await extension.render();

      expect(texts()).toContain(formatRescheduledAt(REQUESTED_AT, timezone));
      expect(document.body.textContent).not.toContain(REQUESTED_AT);
    },
  );

  it("renders the no-reschedule branch when the status metafield is unset", async () => {
    stubGraphql({
      rescheduleStatus: null,
      rescheduleDate: null,
      rescheduleTimeSlot: null,
      requestedAt: null,
    });

    await extension.render();

    expect(texts()).toEqual([
      "No reschedule has been recorded for this order.",
    ]);
  });
});
