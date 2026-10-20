// The order-tag vocabulary (`app/lib/order-tags.ts`).
//
// Two of these suites guard failures that produce NO error at all, which is
// why they are pinned here rather than left to review:
//
//   · An event tag shaped like a delivery schedule tag is silently deleted by
//     the next reschedule (syncOrderDeliveryScheduleTag removes them).
//   · A tag over 40 characters fails the whole tagsAdd batch with the opaque
//     message "Order tags is invalid", taking every other tag with it.
//
// Both behaviours were measured live against the dev store on 2026-08-14.

import { describe, expect, it } from "vitest";

import {
  getShopLocalDate,
  isDeliveryScheduleTag,
} from "../app/lib/delivery-availability";
import { RESCHEDULED_ORDER_TAG } from "../app/lib/constants";
import {
  buildDeliveryDateTagQuery,
  buildOrderEventTag,
  isOrderEventTag,
  orderEventTagLabel,
  parseOrderEventTag,
  MAX_ORDER_TAG_LENGTH,
  ORDER_EVENT_TAGS,
  type OrderEventName,
} from "../app/lib/order-tags";
import { getMeaningfulTags, isHiddenTag, tagDisplayLabel } from "../app/lib/order-utils";

const EVENTS = Object.keys(ORDER_EVENT_TAGS) as OrderEventName[];
const DATE = "2026-08-14";

describe("buildOrderEventTag", () => {
  it("builds one tag per event", () => {
    expect(buildOrderEventTag("reschedule", DATE)).toBe("resched-2026-08-14");
    expect(buildOrderEventTag("addressEdited", DATE)).toBe("addr-2026-08-14");
    expect(buildOrderEventTag("trackingAdded", DATE)).toBe("tracked-2026-08-14");
  });

  it("keeps every tag inside Shopify's 40-character cap", () => {
    // 41 characters is rejected outright AND fails the whole tagsAdd batch.
    for (const event of EVENTS) {
      const tag = buildOrderEventTag(event, DATE);
      expect(tag.length).toBeLessThanOrEqual(MAX_ORDER_TAG_LENGTH);
      expect(tag.length).toBeGreaterThan(0);
    }
  });

  it("refuses to build from a non-ISO date instead of writing a malformed tag", () => {
    for (const bad of ["", "14-08-2026", "2026-8-4", "today", "2026-08-14T00:00:00Z"]) {
      expect(buildOrderEventTag("reschedule", bad)).toBe("");
    }
  });
});

// The trap this whole module is shaped around.
describe("event tags survive the reschedule sync's removal pass", () => {
  it.each(EVENTS)("%s tag is not seen as a delivery schedule tag", (event) => {
    const tag = buildOrderEventTag(event, DATE);
    // isDeliveryScheduleTag matches bare ISO dates, bare slots, and the
    // delivery:/delivery date:/delivery time: prefixes. Anything it matches is
    // deleted on the next reschedule, with no error.
    expect(isDeliveryScheduleTag(tag)).toBe(false);
  });

  it("proves the matcher it must dodge is actually live", () => {
    // Guard against this suite passing because isDeliveryScheduleTag stopped
    // matching anything at all.
    expect(isDeliveryScheduleTag("2026-08-14")).toBe(true);
    expect(isDeliveryScheduleTag("9AM-12PM")).toBe(true);
  });
});

describe("event tags stay visible in the app UI", () => {
  it.each(EVENTS)("%s tag is not hidden from the table or panel", (event) => {
    const tag = buildOrderEventTag(event, DATE);
    expect(isHiddenTag(tag)).toBe(false);
    expect(getMeaningfulTags([tag])).toEqual([tag]);
  });
});

describe("parseOrderEventTag", () => {
  it.each(EVENTS)("round-trips a %s tag", (event) => {
    expect(parseOrderEventTag(buildOrderEventTag(event, DATE))).toEqual({
      event,
      date: DATE,
    });
  });

  it("does NOT treat the bare reschedule lock as an event tag", () => {
    // `resched` shares the prefix but is the self-service lock, matched
    // exactly by both reschedule routes. Confusing the two would let a
    // timeline tag close the customer's one online reschedule.
    expect(parseOrderEventTag(RESCHEDULED_ORDER_TAG)).toBeNull();
    expect(isOrderEventTag(RESCHEDULED_ORDER_TAG)).toBe(false);
  });

  it("ignores tags from other apps and our own legacy shapes", () => {
    for (const other of [
      "editmyorder:shipping_address_updated",
      "2026-08-14",
      "9AM-12PM",
      "ops_md_checked",
      "resched-not-a-date",
      "unknownprefix-2026-08-14",
      "",
      null,
      undefined,
    ]) {
      expect(parseOrderEventTag(other)).toBeNull();
    }
  });

  it("tolerates surrounding whitespace and casing", () => {
    expect(parseOrderEventTag("  ADDR-2026-08-14 ")).toEqual({
      event: "addressEdited",
      date: DATE,
    });
  });
});

describe("orderEventTagLabel", () => {
  it("reads as a timeline entry rather than a slug", () => {
    expect(orderEventTagLabel("resched-2026-08-14")).toBe("Rescheduled · Aug 14");
    expect(orderEventTagLabel("addr-2026-08-14")).toBe("Address edited · Aug 14");
    expect(orderEventTagLabel("tracked-2026-08-14")).toBe("Tracking added · Aug 14");
  });

  it("does not shift the day when formatting", () => {
    // The label formats an already-resolved calendar date; a timezone
    // conversion here would reintroduce the off-by-one-day class of bug.
    expect(orderEventTagLabel("addr-2026-01-01")).toBe("Address edited · Jan 1");
    expect(orderEventTagLabel("addr-2026-12-31")).toBe("Address edited · Dec 31");
  });

  it("returns null for tags that are not ours", () => {
    expect(orderEventTagLabel("editmyorder:customer_info_updated")).toBeNull();
    expect(orderEventTagLabel(RESCHEDULED_ORDER_TAG)).toBeNull();
  });
});

describe("tagDisplayLabel integration", () => {
  it("labels event tags while leaving the lock and foreign tags alone", () => {
    expect(tagDisplayLabel("resched-2026-08-14")).toBe("Rescheduled · Aug 14");
    expect(tagDisplayLabel("resched")).toBe("Rescheduled");
    expect(tagDisplayLabel("ops_md_checked")).toBe("Checked");
    expect(tagDisplayLabel("editmyorder:customer_info_updated")).toBe(
      "editmyorder:customer_info_updated",
    );
  });
});

describe("getShopLocalDate", () => {
  // Stamping UTC is what put a 4:07 AM Manila reschedule on the previous day.
  const EARLY_MORNING_MANILA = new Date("2026-08-11T20:07:25.285Z");

  it("returns the shop's day, not UTC's, for a pre-8AM event", () => {
    expect(getShopLocalDate("Asia/Manila", EARLY_MORNING_MANILA)).toBe("2026-08-12");
    // The same instant in UTC is still the 11th — the bug this avoids.
    expect(EARLY_MORNING_MANILA.toISOString().slice(0, 10)).toBe("2026-08-11");
  });

  it("agrees across the two +08 zones this shop has been configured with", () => {
    expect(getShopLocalDate("Asia/Kuala_Lumpur", EARLY_MORNING_MANILA)).toBe(
      getShopLocalDate("Asia/Manila", EARLY_MORNING_MANILA),
    );
  });

  it("falls back to the shop default instead of the server zone", () => {
    expect(getShopLocalDate("Not/AZone", EARLY_MORNING_MANILA)).toBe("2026-08-12");
    expect(getShopLocalDate(undefined, EARLY_MORNING_MANILA)).toBe("2026-08-12");
  });

  it("returns '' rather than throwing on an unusable instant", () => {
    // This is load-bearing: the caller stamps an OPTIONAL tag onto a write that
    // already succeeded. An earlier version threw here, and the RangeError took
    // the order's date and slot tags down with it.
    expect(getShopLocalDate("Asia/Manila", new Date("not a timestamp"))).toBe("");
    expect(buildOrderEventTag("reschedule", "")).toBe("");
  });

  it("produces a date buildOrderEventTag accepts", () => {
    const tag = buildOrderEventTag(
      "reschedule",
      getShopLocalDate("Asia/Manila", EARLY_MORNING_MANILA),
    );
    expect(tag).toBe("resched-2026-08-12");
  });
});

// 2026-09-04: the dated Orders Ops views now send the delivery-date tag as a
// server-side term (exact-match tag search), replacing the 250-newest window
// that dropped old pre-orders and far-forward reschedules.
describe("buildDeliveryDateTagQuery", () => {
  it("emits a bare term for one day and a parenthesised OR for several", () => {
    expect(buildDeliveryDateTagQuery(["2026-09-05"])).toBe("tag:2026-09-05");
    expect(buildDeliveryDateTagQuery(["2026-08-30", "2026-08-31", "2026-09-01"])).toBe(
      "(tag:2026-08-30 OR tag:2026-08-31 OR tag:2026-09-01)",
    );
  });

  it("dedupes, drops anything that is not a bare ISO date, and returns '' when nothing is left", () => {
    expect(buildDeliveryDateTagQuery(["2026-09-05", "2026-09-05", "9AM-12PM", "resched-2026-09-05", ""])).toBe(
      "tag:2026-09-05",
    );
    expect(buildDeliveryDateTagQuery([])).toBe("");
    expect(buildDeliveryDateTagQuery(["garbage"])).toBe("");
  });
});
