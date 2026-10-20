import { describe, it, expect } from "vitest";
import { diffOrderSnapshots } from "../app/hooks/useOrdersDiff";

// Pure diff behind the §6 background-refresh nudge: ids in `next` but not
// `prev` are new; ids in both with a different schedule fingerprint are
// changed; disappeared ids are ignored.

const snap = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

describe("diffOrderSnapshots", () => {
  it("flags nothing when the snapshots are identical", () => {
    const a = snap({ "gid/1": "2026-07-12|9AM-12PM", "gid/2": "—|—" });
    const { newIds, changedIds } = diffOrderSnapshots(a, snap(Object.fromEntries(a)));
    expect(newIds).toEqual([]);
    expect(changedIds).toEqual([]);
  });

  it("flags ids that appear as new", () => {
    const prev = snap({ "gid/1": "2026-07-12|9AM-12PM" });
    const next = snap({
      "gid/1": "2026-07-12|9AM-12PM",
      "gid/2": "2026-07-13|3PM-6PM",
    });
    const { newIds, changedIds } = diffOrderSnapshots(prev, next);
    expect(newIds).toEqual(["gid/2"]);
    expect(changedIds).toEqual([]);
  });

  it("flags a schedule change (date or slot) as changed, not new", () => {
    const prev = snap({
      "gid/1": "2026-07-12|9AM-12PM",
      "gid/2": "2026-07-13|3PM-6PM",
    });
    const next = snap({
      "gid/1": "2026-07-14|9AM-12PM", // date moved
      "gid/2": "2026-07-13|6PM-11PM", // slot moved
    });
    const { newIds, changedIds } = diffOrderSnapshots(prev, next);
    expect(newIds).toEqual([]);
    expect(changedIds).toEqual(["gid/1", "gid/2"]);
  });

  it("ignores ids that disappeared", () => {
    const prev = snap({
      "gid/1": "2026-07-12|9AM-12PM",
      "gid/2": "2026-07-13|3PM-6PM",
    });
    const next = snap({ "gid/2": "2026-07-13|3PM-6PM" });
    const { newIds, changedIds } = diffOrderSnapshots(prev, next);
    expect(newIds).toEqual([]);
    expect(changedIds).toEqual([]);
  });

  it("handles a mixed delta (new + changed + removed) in one pass", () => {
    const prev = snap({
      "gid/1": "2026-07-12|9AM-12PM",
      "gid/2": "2026-07-13|3PM-6PM",
      "gid/3": "—|—",
    });
    const next = snap({
      "gid/1": "2026-07-12|9AM-12PM", // unchanged
      "gid/3": "2026-07-15|9AM-12PM", // undated → scheduled = changed
      "gid/4": "2026-07-16|3PM-6PM", // new
    });
    const { newIds, changedIds } = diffOrderSnapshots(prev, next);
    expect(newIds).toEqual(["gid/4"]);
    expect(changedIds).toEqual(["gid/3"]);
  });

  it("treats an empty previous snapshot as everything-new", () => {
    const next = snap({ "gid/1": "2026-07-12|9AM-12PM" });
    const { newIds, changedIds } = diffOrderSnapshots(new Map(), next);
    expect(newIds).toEqual(["gid/1"]);
    expect(changedIds).toEqual([]);
    // (The hook never diffs a first load — its baseline reset covers that —
    // but the pure function must still behave sanely.)
  });
});
