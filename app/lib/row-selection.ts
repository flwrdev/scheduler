// Pure helpers for the row selection on the Orders table. Each one takes the current list of
// selected order ids and returns a new list, so they are easy to test on their own.

// Whether none, some or all of the visible rows are selected.
export type SelectAllState = "none" | "some" | "all";

// Adds or removes one id. The order of the other ids is kept and an id never appears twice.
export function setRowSelected(
  selected: string[],
  id: string,
  isSelected: boolean,
): string[] {
  const without = selected.filter((existing) => existing !== id);
  return isSelected ? [...without, id] : without;
}

// Selects every visible row, or clears the selection.
export function setAllSelected(
  visibleIds: string[],
  isSelected: boolean,
): string[] {
  return isSelected ? [...new Set(visibleIds)] : [];
}

// Removes the given ids from the selection.
export function removeIds(selected: string[], idsToRemove: string[]): string[] {
  const remove = new Set(idsToRemove);
  return selected.filter((id) => !remove.has(id));
}

// Reports how many of the visible rows are selected.
export function getSelectAllState(
  selected: string[],
  visibleIds: string[],
): SelectAllState {
  if (visibleIds.length === 0) return "none";
  const selectedSet = new Set(selected);
  const count = visibleIds.filter((id) => selectedSet.has(id)).length;
  if (count === 0) return "none";
  return count === visibleIds.length ? "all" : "some";
}
