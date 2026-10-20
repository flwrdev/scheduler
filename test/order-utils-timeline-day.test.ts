import { describe, expect, it } from "vitest";

import { formatTimelineDay } from "../app/lib/order-utils";

describe("formatTimelineDay", () => {
  const now = new Date(2026, 8, 30, 10, 0);

  it("labels today and yesterday by the local calendar day", () => {
    expect(formatTimelineDay(new Date(2026, 8, 30, 0, 5).toISOString(), now)).toBe("Today");
    expect(formatTimelineDay(new Date(2026, 8, 29, 23, 59).toISOString(), now)).toBe(
      "Yesterday",
    );
  });

  it("shows the date for older days, with the year only when it differs", () => {
    expect(formatTimelineDay(new Date(2026, 8, 27, 12).toISOString(), now)).toBe(
      "Sun, Sep 27",
    );
    expect(formatTimelineDay(new Date(2025, 11, 23, 12).toISOString(), now)).toBe(
      "Tue, Dec 23, 2025",
    );
  });

  it("groups a missing timestamp separately", () => {
    expect(formatTimelineDay("—", now)).toBe("Date not recorded");
  });
});
