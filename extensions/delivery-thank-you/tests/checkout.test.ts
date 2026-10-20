/// <reference types="@shopify/ui-extensions/purchase.thank-you.block.render" />
// Delivery Schedule card (delivery-thank-you) — render-level.
//
// The card shows the delivery date and slot the customer picked at checkout.
// When there is no date and no slot, it must render nothing at all rather than
// an empty bordered box.
import { getExtension } from "@shopify/ui-extensions-tester";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const extension = getExtension("purchase.thank-you.block.render");

function cartMetafield(key: string, value: string) {
  return {
    target: { type: "cart" as const, id: "gid://shopify/Cart/1" },
    metafield: {
      namespace: "custom",
      key,
      value,
      valueType: "string" as const,
      type: "single_line_text_field",
    },
  };
}

function headings() {
  return [...document.body.querySelectorAll("s-heading")].map(
    (node) => node.textContent ?? "",
  );
}

beforeEach(() => {
  extension.setUp();
});

afterEach(() => {
  extension.tearDown();
});

describe("delivery-thank-you card", () => {
  it("renders the schedule from the cart metafields, with the date formatted", async () => {
    extension.shopify.appMetafields.value = [
      cartMetafield("date", "2026-09-02"),
      cartMetafield("time_slot", "9AM-12PM"),
    ];

    await extension.render();

    expect(headings()).toEqual(["Delivery Schedule"]);

    const body = document.body.textContent ?? "";
    // The customer-facing date is pinned to English (brand English-first
    // voice, merchant decision 2026-08-25) regardless of the browser locale.
    expect(body).toContain("Date: Wednesday, September 2, 2026");
    // The raw ISO value never reaches the customer.
    expect(body).not.toContain("2026-09-02");
    expect(body).toContain("Time slot: 9AM-12PM");
  });

  it("falls back to the legacy checkout attributes when no cart metafields exist", async () => {
    // Older orders never received the metafields; the attributes are the backup.
    extension.shopify.attributes.value = [
      { key: "Delivery Date", value: "2026-09-04" },
      { key: "Delivery Time", value: "3PM-6PM" },
    ];

    await extension.render();

    expect(headings()).toEqual(["Delivery Schedule"]);
    expect(document.body.textContent).toContain("Time slot: 3PM-6PM");
  });

  it("renders nothing when there is no schedule", async () => {
    await extension.render();

    expect(document.body.querySelector("s-box")).toBeNull();
    expect(document.body.textContent).toBe("");
  });
});
