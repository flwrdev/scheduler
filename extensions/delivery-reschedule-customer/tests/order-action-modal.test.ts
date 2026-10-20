/// <reference types="@shopify/ui-extensions/customer-account.order.action.render" />
// delivery-reschedule-customer — the customer reschedule modal.
//
// This is the ONLY extension in the app that writes delivery state
// (; docs/api.md section 2, row 3): it posts to
// /public/customer-account/reschedule, the single live customer write path.
// Everything else in extensions/ is read-only, so this suite is the one that
// has to hold.
//
// The modal imports the real validation engine (app/lib/delivery-availability),
// so the rules fixture below is honest: dates are picked RELATIVE to the shop's
// own min-selectable date, which keeps the suite from rotting as the calendar
// moves past a hardcoded date.
import { getExtension } from "@shopify/ui-extensions-tester";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMinSelectableDate,
  type DeliveryScheduleRules,
} from "../../../app/lib/delivery-availability";

const extension = getExtension("customer-account.order.action.render");

const APP_BASE_URL =
  "https://delivery-scheduler-1030649952056.us-central1.run.app";
const SCHEDULE_RULES_URL = `${APP_BASE_URL}/public/customer-account/schedule-rules`;
const RESCHEDULE_URL = `${APP_BASE_URL}/public/customer-account/reschedule`;

// The default customer-account action mock hands the extension this order id
// and the session token below.
const ORDER_ID = "gid://shopify/Order/1";
const SESSION_TOKEN = "mock-session-token";

const RULES: DeliveryScheduleRules = {
  timezone: "Asia/Manila",
  cutoffHour: 17,
  prepHours: 1,
  maxDays: 25,
  slots: [
    { display: "9AM-12PM", value: "9AM-12PM" },
    { display: "12PM-3PM", value: "12PM-3PM" },
    { display: "3PM-6PM", value: "3PM-6PM" },
  ],
  disabledDates: [],
  disabledSlots: {},
  slotCapacity: {},
};

function addDays(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

const MIN_DATE = getMinSelectableDate(RULES);

// Three days past the earliest bookable date: comfortably inside the 25-day
// window and far enough out that the same-day cutoff and prep-hours gates never
// apply, so the selection validates on its own merits.
const TARGET_DATE = addDays(MIN_DATE, 3);
const TARGET_SLOT = "12PM-3PM";

// A merchant blackout inside the same window, deliberately NOT the target date.
// Added after construction because the window it sits in is derived from RULES
// itself; getMinSelectableDate does not read disabledDates, so the order is safe.
const BLOCKED_DATE = addDays(MIN_DATE, 5);
RULES.disabledDates.push(BLOCKED_DATE);

type StubbedCall = { url: string; body: URLSearchParams };

// The extension drives these host-rendered controls through their `value`
// property, exactly as the real customer-account runtime does.
type ValuedElement = HTMLElement & { value?: string };

let calls: StubbedCall[];

/**
 * Routes the two POSTs the modal makes. `reschedule` controls what the write
 * path answers; the rules read succeeds unless `rules` says otherwise.
 */
function stubFetch(options?: {
  rules?: { status: number; body: unknown };
  reschedule?: { status: number; body: unknown };
}) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });

    if (url === SCHEDULE_RULES_URL) {
      const rules = options?.rules ?? { status: 200, body: { rules: RULES } };
      return new Response(JSON.stringify(rules.body), { status: rules.status });
    }

    const reschedule = options?.reschedule ?? {
      status: 200,
      body: { ok: true },
    };
    return new Response(JSON.stringify(reschedule.body), {
      status: reschedule.status,
    });
  });

  extension.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

function callsTo(url: string) {
  return calls.filter((call) => call.url === url);
}

function actionShell() {
  return document.body.querySelector("s-customer-account-action");
}

function primaryButton() {
  return [...document.body.querySelectorAll("s-button")].find(
    (button) => button.getAttribute("slot") === "primary-action",
  );
}

function slotOptionValues() {
  return [...document.body.querySelectorAll("s-option")].map((option) =>
    option.getAttribute("value"),
  );
}

/** Waits until the rules fetch has settled and the form is interactive. */
async function waitForRulesLoaded() {
  await vi.waitFor(() => {
    const dateField = document.body.querySelector("s-date-field");
    expect(dateField).not.toBeNull();
    expect(dateField?.hasAttribute("disabled")).toBe(false);
  });
}

/**
 * Drives the two fields the way the customer does. The modal updates in place —
 * the same s-date-field / s-select nodes survive every state change, which is
 * what keeps focus in the field being typed in — so the select is re-queried
 * after the date change purely to read its refreshed options.
 */
function pickDateAndSlot(date: string, slot: string) {
  const dateField = document.body.querySelector(
    "s-date-field",
  ) as unknown as ValuedElement;
  dateField.value = date;
  dateField.dispatchEvent(new Event("change"));

  const select = document.body.querySelector(
    "s-select",
  ) as unknown as ValuedElement;
  select.value = slot;
  select.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  calls = [];
  extension.setUp();
});

afterEach(() => {
  extension.tearDown();
  vi.restoreAllMocks();
});

describe("delivery-reschedule-customer modal", () => {
  it("reads the schedule rules with this order's id so its own booking is excluded", async () => {
    stubFetch();

    await extension.render();
    await waitForRulesLoaded();

    // orderId rides along so the capacity counts exclude the slot this order
    // already occupies — otherwise picking it back would read as "full".
    const [rulesCall] = callsTo(SCHEDULE_RULES_URL);
    expect(rulesCall).toBeDefined();
    expect(rulesCall.body.get("orderId")).toBe(ORDER_ID);
    expect(rulesCall.body.get("sessionToken")).toBe(SESSION_TOKEN);
  });

  it("feeds the shop's blackout dates into the date field's disallow list", async () => {
    stubFetch();

    await extension.render();
    await waitForRulesLoaded();

    // The picker is not a pass-through of the payload: the disallow list is
    // computed by walking the whole window through the validation engine, so a
    // blocked date must land here while a bookable one must not.
    const disallow = (
      document.body.querySelector("s-date-field")?.getAttribute("disallow") ?? ""
    ).split(",");
    expect(disallow).toContain(BLOCKED_DATE);
    expect(disallow).not.toContain(TARGET_DATE);
  });

  it("populates the time-slot select from the rules payload once a date is picked", async () => {
    stubFetch();

    await extension.render();
    await waitForRulesLoaded();

    // Before a date exists there is only the placeholder option.
    expect(slotOptionValues()).toEqual([""]);

    pickDateAndSlot(TARGET_DATE, TARGET_SLOT);

    expect(slotOptionValues()).toEqual([
      "",
      "9AM-12PM",
      "12PM-3PM",
      "3PM-6PM",
    ]);
  });

  it("still renders a usable form on the default rules when the rules read fails", async () => {
    stubFetch({ rules: { status: 500, body: { error: "boom" } } });
    // The extension console.warns the failure on purpose; keep the run quiet.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await extension.render();
    await waitForRulesLoaded();

    expect(actionShell()?.getAttribute("heading")).toBe("Reschedule Delivery");
    expect(document.body.querySelector("s-date-field")).not.toBeNull();
    expect(warn).toHaveBeenCalled();

    // Loading finished and the fallback rules are in force: the select prompts
    // for a date rather than still saying "Loading time slots...".
    expect(document.body.querySelector("s-option")?.textContent).toBe(
      "Select a delivery date first",
    );
  });

  it("blocks an empty submit locally instead of spending a round trip on it", async () => {
    stubFetch();

    await extension.render();
    await waitForRulesLoaded();

    primaryButton()?.dispatchEvent(new Event("click"));

    expect(
      document.body.querySelector("s-date-field")?.getAttribute("error"),
    ).toBe("Please select a delivery date.");
    expect(document.body.querySelector("s-select")?.getAttribute("error")).toBe(
      "Please select a time slot.",
    );
    expect(callsTo(RESCHEDULE_URL)).toHaveLength(0);
  });

  it("posts the selection to the customer reschedule write path", async () => {
    stubFetch();

    await extension.render();
    await waitForRulesLoaded();
    pickDateAndSlot(TARGET_DATE, TARGET_SLOT);
    primaryButton()?.dispatchEvent(new Event("click"));

    await vi.waitFor(() => {
      expect(callsTo(RESCHEDULE_URL)).toHaveLength(1);
    });

    const [writeCall] = callsTo(RESCHEDULE_URL);
    expect(Object.fromEntries(writeCall.body)).toEqual({
      orderId: ORDER_ID,
      date: TARGET_DATE,
      timeSlot: TARGET_SLOT,
      sessionToken: SESSION_TOKEN,
    });
  });

  it("surfaces a 422 rule rejection and re-offers the slots the server returned", async () => {
    stubFetch({
      reschedule: {
        status: 422,
        body: {
          error:
            "Selected time slot is unavailable. Please choose another time slot.",
          code: "slot_unavailable",
          minDate: TARGET_DATE,
          maxDate: addDays(TARGET_DATE, 10),
          availableSlots: [{ display: "3PM-6PM", value: "3PM-6PM" }],
        },
      },
    });

    await extension.render();
    await waitForRulesLoaded();
    pickDateAndSlot(TARGET_DATE, TARGET_SLOT);
    primaryButton()?.dispatchEvent(new Event("click"));

    await vi.waitFor(() => {
      expect(document.body.querySelector("s-banner")).not.toBeNull();
    });

    const banner = document.body.querySelector("s-banner");
    expect(banner?.getAttribute("tone")).toBe("critical");
    expect(banner?.textContent).toBe(
      "Selected time slot is unavailable. Please choose another time slot.",
    );
    // slot_unavailable narrows the picker to what the server said is left.
    expect(slotOptionValues()).toEqual(["", "3PM-6PM"]);
    // The modal stays on the form — no success state.
    expect(actionShell()?.getAttribute("heading")).toBe("Reschedule Delivery");
  });

  it("shows the success state after a confirmed reschedule", async () => {
    stubFetch();

    await extension.render();
    await waitForRulesLoaded();
    pickDateAndSlot(TARGET_DATE, TARGET_SLOT);
    primaryButton()?.dispatchEvent(new Event("click"));

    await vi.waitFor(() => {
      expect(actionShell()?.getAttribute("heading")).toBe(
        "Delivery Rescheduled",
      );
    });

    const banner = document.body.querySelector("s-banner");
    expect(banner?.getAttribute("tone")).toBe("success");
    expect(banner?.textContent).toContain("Your delivery has been rescheduled");
    expect(banner?.textContent).toContain("(12PM-3PM)");
  });

  it("refuses to submit with a non-string session token instead of sending garbage", async () => {
    // A dying sandbox bridge can make sessionToken.get() resolve undefined; the
    // pre-fix code serialized that into the literal string "undefined" and the
    // backend logged it as an unexplained 401 (prod incident 2026-08-25).
    stubFetch();
    extension.shopify.sessionToken.get = vi.fn(
      async () => undefined,
    ) as unknown as typeof extension.shopify.sessionToken.get;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await extension.render();
    await waitForRulesLoaded();
    pickDateAndSlot(TARGET_DATE, TARGET_SLOT);
    primaryButton()?.dispatchEvent(new Event("click"));

    await vi.waitFor(() => {
      const banner = document.body.querySelector("s-banner");
      expect(banner?.textContent).toContain("Session token unavailable");
    });

    // Neither endpoint ever saw the garbage token: the rules fetch failed the
    // same guard (falling back to default rules — hence the warn), and the
    // write was blocked before fetch.
    expect(callsTo(RESCHEDULE_URL)).toHaveLength(0);
    expect(callsTo(SCHEDULE_RULES_URL)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
