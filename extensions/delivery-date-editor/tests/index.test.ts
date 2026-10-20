/// <reference types="@shopify/ui-extensions/customer-account.order-status.block.render" />
// delivery-date-editor — the read-only Delivery Schedule block on the
// customer-account order-status page (docs/api.md §2: reads block state and
// calls read endpoints only).
//
// It merges two sources of truth, in this precedence order: the direct
// /public/customer-account/order-delivery read, then the host's own metafields
// and legacy checkout attributes. The direct read exists because Shopify's
// order payload can lag right after a reschedule. (The former cross-extension
// storage "handoff" was dead code — extension storage is per-extension, so this
// block could never see the modal's marker — and was removed 2026-08-25
// together with the 1s poll loop.)
import { getExtension } from "@shopify/ui-extensions-tester";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extension = getExtension("customer-account.order-status.block.render");

function metafield(namespace: string, key: string, value: string) {
  return { target: { type: "order" as const }, metafield: { namespace, key, value } };
}

// The mock subscribables expose BOTH `value` and `current`, and the extension
// reads `current ?? value` — so an override has to set both to take effect.
function setSubscribable(subscribable: { value?: unknown; current?: unknown }, next: unknown) {
  subscribable.value = next;
  subscribable.current = next;
}

// A controllable stand-in for the order subscribable: tests emit new order
// values through it to exercise the fetch dedupe and the auth-failure stop.
function createEmittableOrder(initial: unknown) {
  let subscriber: ((value: unknown) => void) | null = null;
  const subscribable = {
    value: initial,
    current: initial,
    subscribe(fn: (value: unknown) => void) {
      subscriber = fn;
    },
    emit(next: unknown) {
      subscribable.value = next;
      subscribable.current = next;
      subscriber?.(next);
    },
  };
  return subscribable;
}

function fetchCallCount() {
  return (extension.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
}

function texts() {
  return [...document.body.querySelectorAll("s-text")].map(
    (node) => node.textContent ?? "",
  );
}

beforeEach(() => {
  extension.setUp();
  // Quiet 200 with no `delivery` key: the direct read reports "nothing fresher
  // than what the host already gave us".
  extension.fetch = vi.fn(
    async () => new Response(JSON.stringify({})),
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  extension.tearDown();
  vi.restoreAllMocks();
});

describe("delivery-date-editor order-status block", () => {
  it("renders the delivery values from the custom.* metafields", async () => {
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
    ]);

    await extension.render();

    const section = document.body.querySelector("s-section");
    expect(section?.getAttribute("heading")).toBe("Delivery Schedule · #1000");
    expect(texts()).toEqual([
      "Date",
      "2026-09-02",
      "Time slot",
      "9AM-12PM",
    ]);
  });

  it("renders nothing when the order carries no delivery state at all", async () => {
    setSubscribable(extension.shopify.appMetafields, []);
    setSubscribable(extension.shopify.attributes, undefined);
    setSubscribable(extension.shopify.order, undefined);

    await extension.render();

    expect(document.body.querySelector("s-section")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("falls back to the legacy Delivery Date/Time attributes", async () => {
    setSubscribable(extension.shopify.appMetafields, []);
    setSubscribable(extension.shopify.attributes, [
      { key: "Delivery Date", value: "2026-09-05" },
      { key: "Delivery Time", value: "6PM-11PM" },
      { key: "Card Message", value: "Happy birthday" },
    ]);

    await extension.render();

    expect(texts()).toEqual([
      "Date",
      "2026-09-05",
      "Time slot",
      "6PM-11PM",
      "Card message",
      "Happy birthday",
    ]);
  });

  it("adds a Rescheduled badge when the reschedule status metafield is confirmed", async () => {
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
      metafield("$app", "reschedule_status", "confirmed"),
    ]);

    await extension.render();

    const badge = document.body.querySelector("s-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("Rescheduled to ");
    // The badge spells the date out; the raw ISO stays out of the customer's view.
    expect(badge?.textContent).not.toContain("2026-09-02");
  });

  it("prefers the direct server read over the stale host metafields", async () => {
    // The backend answers with the just-saved reschedule values while the host
    // payload still shows the pre-reschedule ones.
    extension.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            delivery: {
              date: "2026-09-09",
              timeSlot: "3PM-6PM",
              status: "confirmed",
            },
          }),
        ),
    ) as unknown as typeof globalThis.fetch;
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
    ]);

    await extension.render();

    expect(texts()).toEqual([
      "Date",
      "2026-09-09",
      "Time slot",
      "3PM-6PM",
    ]);
    // The server read also carries the confirmed status, so the badge appears.
    expect(document.body.querySelector("s-badge")).not.toBeNull();
  });

  it("fetches once per order id — re-emitting the same order costs no request", async () => {
    const order = createEmittableOrder({ id: "gid://shopify/Order/1", name: "#1000" });
    extension.shopify.order = order as unknown as typeof extension.shopify.order;
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
    ]);

    await extension.render();

    const callsAfterActivation = fetchCallCount();
    expect(callsAfterActivation).toBe(1);

    // The host re-emitting the identical order (hydration echoes, unrelated
    // updates) must not turn into extra network traffic.
    order.emit({ id: "gid://shopify/Order/1", name: "#1000" });
    order.emit({ id: "gid://shopify/Order/1", name: "#1000" });
    await Promise.resolve();

    expect(fetchCallCount()).toBe(callsAfterActivation);
  });

  it("stops calling the backend after three consecutive auth failures", async () => {
    // 2026-08-25 incident pin: stale tabs streamed 1 req/s of 401s with no stop
    // condition. Auth failures never heal within a page's lifetime, so after
    // three in a row the backend must be left alone for the rest of the
    // activation.
    extension.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
        }),
    ) as unknown as typeof globalThis.fetch;
    const order = createEmittableOrder(undefined);
    extension.shopify.order = order as unknown as typeof extension.shopify.order;
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
    ]);

    await extension.render();
    expect(fetchCallCount()).toBe(0);

    // Three different orders → three attempts, all 401.
    for (const id of ["1", "2", "3"]) {
      order.emit({ id: `gid://shopify/Order/${id}`, name: `#${id}` });
      // Let the async fetch settle before the next emission so the failures
      // count as consecutive attempts rather than being skipped by the
      // in-flight guard.
      await vi.waitFor(() => {
        expect(fetchCallCount()).toBe(Number(id));
      });
    }

    // The stop is now armed — a fourth order must not produce a request.
    order.emit({ id: "gid://shopify/Order/4", name: "#4" });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchCallCount()).toBe(3);
  });

  it("refuses to send a non-string session token", async () => {
    // A dying sandbox bridge can make sessionToken.get() resolve undefined; the
    // old code serialized that into the literal string "undefined" and shipped
    // it as a doomed 401 (seen in prod 2026-08-25). It must never reach fetch.
    extension.shopify.sessionToken.get = vi.fn(
      async () => undefined,
    ) as unknown as typeof extension.shopify.sessionToken.get;
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
    ]);

    await extension.render();

    expect(fetchCallCount()).toBe(0);
    // The host metafields still render — the guard degrades, never blanks.
    expect(texts()).toEqual(["Date", "2026-09-02", "Time slot", "9AM-12PM"]);
  });
});
