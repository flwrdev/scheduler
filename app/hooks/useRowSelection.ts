// Hook that keeps track of which rows are selected on the Orders table. It gives back the
// selected ids, the select-all state for the visible rows and functions to change them.
// All functions keep the same identity between renders.

import { useCallback, useMemo, useState } from "react";
import {
  getSelectAllState,
  removeIds,
  setAllSelected,
  setRowSelected,
} from "../lib/row-selection";

// `items` are the rows on screen and `getId` reads the id of one row.
export function useRowSelection<T>(items: T[], getId: (item: T) => string) {
  const [selectedResources, setSelectedResources] = useState<string[]>([]);

  const visibleIds = useMemo(() => items.map(getId), [items, getId]);

  const selectAllState = useMemo(
    () => getSelectAllState(selectedResources, visibleIds),
    [selectedResources, visibleIds],
  );

  // Selects or deselects one row.
  const selectRow = useCallback((id: string, isSelected: boolean) => {
    setSelectedResources((current) => setRowSelected(current, id, isSelected));
  }, []);

  // Selects or deselects every visible row.
  const selectAll = useCallback(
    (isSelected: boolean) => {
      setSelectedResources(setAllSelected(visibleIds, isSelected));
    },
    [visibleIds],
  );

  // Clears the whole selection.
  const clearSelection = useCallback(() => {
    setSelectedResources([]);
  }, []);

  // Removes some ids from the selection and keeps the rest.
  const removeSelectedResources = useCallback((ids: string[]) => {
    setSelectedResources((current) => removeIds(current, ids));
  }, []);

  return {
    selectedResources,
    selectAllState,
    allResourcesSelected: selectAllState === "all",
    selectRow,
    selectAll,
    clearSelection,
    removeSelectedResources,
  };
}
