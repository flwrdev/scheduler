import { describe, expect, it } from "vitest";
import {
  getSelectAllState,
  removeIds,
  setAllSelected,
  setRowSelected,
} from "../app/lib/row-selection";
import { flag } from "../app/lib/web-component-props";

describe("setRowSelected", () => {
  it("adds an id once", () => {
    expect(setRowSelected(["a"], "b", true)).toEqual(["a", "b"]);
    expect(setRowSelected(["a", "b"], "b", true)).toEqual(["a", "b"]);
  });

  it("removes an id and keeps the order of the rest", () => {
    expect(setRowSelected(["a", "b", "c"], "b", false)).toEqual(["a", "c"]);
  });

  it("does nothing when removing an id that is not selected", () => {
    expect(setRowSelected(["a"], "z", false)).toEqual(["a"]);
  });
});

describe("setAllSelected", () => {
  it("selects every visible id without duplicates", () => {
    expect(setAllSelected(["a", "b", "a"], true)).toEqual(["a", "b"]);
  });

  it("clears the selection", () => {
    expect(setAllSelected(["a", "b"], false)).toEqual([]);
  });
});

describe("removeIds", () => {
  it("removes only the given ids", () => {
    expect(removeIds(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
  });

  it("returns the same ids when the list to remove is empty", () => {
    expect(removeIds(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("getSelectAllState", () => {
  it("is none when nothing visible is selected", () => {
    expect(getSelectAllState([], ["a", "b"])).toBe("none");
    expect(getSelectAllState(["x"], ["a", "b"])).toBe("none");
  });

  it("is some when part of the visible rows are selected", () => {
    expect(getSelectAllState(["a"], ["a", "b"])).toBe("some");
  });

  it("is all when every visible row is selected", () => {
    expect(getSelectAllState(["b", "a"], ["a", "b"])).toBe("all");
  });

  it("is none when there are no visible rows", () => {
    expect(getSelectAllState(["a"], [])).toBe("none");
  });
});

describe("flag", () => {
  it("returns true only for true", () => {
    expect(flag(true)).toBe(true);
  });

  it("returns undefined for false, null and undefined", () => {
    expect(flag(false)).toBeUndefined();
    expect(flag(null)).toBeUndefined();
    expect(flag(undefined)).toBeUndefined();
  });
});
