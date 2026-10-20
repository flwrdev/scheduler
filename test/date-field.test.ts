import { describe, expect, it } from "vitest";
import { disallowDatesBefore, isCompleteIsoDate } from "../app/lib/date-field";

describe("isCompleteIsoDate", () => {
  it("accepts a full date", () => {
    expect(isCompleteIsoDate("2026-07-11")).toBe(true);
  });

  it("rejects half-typed text", () => {
    expect(isCompleteIsoDate("")).toBe(false);
    expect(isCompleteIsoDate("2026-07")).toBe(false);
    expect(isCompleteIsoDate("2026-7-1")).toBe(false);
  });

  it("rejects a year that is too early", () => {
    expect(isCompleteIsoDate("0002-07-11")).toBe(false);
  });
});

describe("disallowDatesBefore", () => {
  it("blocks everything up to the day before", () => {
    expect(disallowDatesBefore("2026-10-17")).toBe("--2026-10-16");
  });

  it("crosses a month and a year boundary", () => {
    expect(disallowDatesBefore("2026-11-01")).toBe("--2026-10-31");
    expect(disallowDatesBefore("2027-01-01")).toBe("--2026-12-31");
  });
});
