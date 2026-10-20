// Reschedule timestamp formatting for the two read-only admin order-page
// extensions (`src/format-timestamp.js`).
//
// Why this exists: the `$app:reschedule_requested_at` metafield stores UTC, and
// both extensions used to print it raw. On a +08 shop that turned a 4:07 AM
// Manila reschedule into "2026-08-11T20:07:25Z" — the day BEFORE the order was
// placed, reading as if the customer rescheduled before they ordered. Found on
// prod order #4068, 2026-08-14.
//
// The module is DUPLICATED into each extension folder (Shopify bundles every
// extension separately, so neither can import out of the other's directory).
// This suite runs against BOTH copies and pins them byte-identical: an edit
// applied to only one fails here.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Plain-JS extension modules; resolved via the config's `allowJs`.
import * as blockCopy from "../extensions/order-delivery-block/src/format-timestamp.js";
import * as actionCopy from "../extensions/delivery-reschedule-action/src/format-timestamp.js";

const COPIES = [
  {
    name: "order-delivery-block",
    mod: blockCopy,
    path: "../extensions/order-delivery-block/src/format-timestamp.js",
  },
  {
    name: "delivery-reschedule-action",
    mod: actionCopy,
    path: "../extensions/delivery-reschedule-action/src/format-timestamp.js",
  },
];

const MANILA = "Asia/Manila";

describe("format-timestamp.js is byte-identical across both extensions", () => {
  it("keeps the two copies in sync", () => {
    const [a, b] = COPIES.map((c) =>
      readFileSync(new URL(c.path, import.meta.url), "utf8"),
    );
    expect(a).toBe(b);
  });
});

describe.each(COPIES)("formatRescheduledAt ($name)", ({ mod }) => {
  const { formatRescheduledAt } = mod as {
    formatRescheduledAt: (v: unknown, tz?: unknown) => string;
  };

  // The exact value that exposed the bug, from prod order #4068.
  const HASH_4068 = "2026-08-11T20:07:25.285Z";

  it("renders the #4068 timestamp on the shop's day, not UTC's", () => {
    const out = formatRescheduledAt(HASH_4068, MANILA);
    // 20:07 UTC on Aug 11 is 04:07 on Aug 12 in Manila — the same morning the
    // order was placed, which is what made the raw UTC string look impossible.
    expect(out).toContain("Aug 12, 2026");
    expect(out).toContain("4:07");
    expect(out).not.toContain("Aug 11");
  });

  it("no longer emits a raw ISO string", () => {
    const out = formatRescheduledAt(HASH_4068, MANILA);
    expect(out).not.toContain("T20:07");
    expect(out).not.toContain("Z");
  });

  it("shifts the day for any pre-8AM shop-time reschedule", () => {
    // Midnight-to-8AM Manila is the whole window that displayed a day early.
    expect(formatRescheduledAt("2026-08-11T16:00:00Z", MANILA)).toContain(
      "Aug 12, 2026",
    );
    expect(formatRescheduledAt("2026-08-11T23:59:00Z", MANILA)).toContain(
      "Aug 12, 2026",
    );
  });

  it("leaves an afternoon reschedule on the same day", () => {
    // 10:00 UTC = 6:00 PM Manila, same date either way.
    expect(formatRescheduledAt("2026-08-12T10:00:00Z", MANILA)).toContain(
      "Aug 12, 2026",
    );
  });

  it("falls back to the viewer's zone when the shop timezone is missing", () => {
    for (const tz of [null, undefined, ""]) {
      const out = formatRescheduledAt(HASH_4068, tz);
      expect(out).not.toBe("");
      expect(out).toContain("2026");
    }
  });

  it("survives an unusable timezone instead of blanking the field", () => {
    const out = formatRescheduledAt(HASH_4068, "Not/AZone");
    expect(out).not.toBe("");
    expect(out).toContain("2026");
  });

  it("returns an unparseable value verbatim rather than hiding it", () => {
    expect(formatRescheduledAt("not a timestamp", MANILA)).toBe("not a timestamp");
  });

  it("renders nothing when there is nothing to show", () => {
    for (const empty of [null, undefined, "", "   ", 42, {}]) {
      expect(formatRescheduledAt(empty, MANILA)).toBe("");
    }
  });
});
