// Compares each background refresh of the Orders page with the previous one and reports orders
// that are new or whose delivery date or slot changed, so the table can highlight them.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Order,
  getDeliveryDateValue,
  getDeliveryTimeValue,
} from "../lib/order-utils";

// Background-refresh diff for /app/orders (Orders Ops V2 §6): compares each
// loader settle against the previous snapshot OF THE SAME VIEW and surfaces
// "new order" / "schedule updated" ids, so a background revalidation doesn't
// just silently reflow the table. `snapshotKey` identifies the view (every
// URL param except ?order) — when it changes the merchant navigated, so the
// baseline resets and nothing is flagged. Flagged ids accumulate across
// successive refreshes until dismissed. The diff runs client-side over
// already-loaded data — no extra query.

/** id → "deliveryDate|timeSlot" fingerprint for the loaded orders. */
export function buildScheduleSnapshot(
  orders: readonly Order[],
): Map<string, string> {
  const byId = new Map<string, string>();
  for (const o of orders) {
    byId.set(o.id, `${getDeliveryDateValue(o)}|${getDeliveryTimeValue(o)}`);
  }
  return byId;
}

export interface OrdersDiffDelta {
  newIds: string[];
  changedIds: string[];
}

/**
 * Pure diff: ids present in `next` but not `prev` are new; ids in both whose
 * schedule fingerprint differs are changed. Ids that disappeared are ignored
 * (a filtered-out or fulfilled order is not "news").
 */
export function diffOrderSnapshots(
  prev: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): OrdersDiffDelta {
  const newIds: string[] = [];
  const changedIds: string[] = [];
  for (const [id, schedule] of next) {
    const before = prev.get(id);
    if (before === undefined) {
      newIds.push(id);
    } else if (before !== schedule) {
      changedIds.push(id);
    }
  }
  return { newIds, changedIds };
}

export function useOrdersDiff(orders: Order[], snapshotKey: string) {
  const prevRef = useRef<{ key: string; byId: Map<string, string> } | null>(
    null,
  );
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());
  const [changedIds, setChangedIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const byId = buildScheduleSnapshot(orders);
    const prev = prevRef.current;
    prevRef.current = { key: snapshotKey, byId };

    if (!prev || prev.key !== snapshotKey) {
      // First load, or the merchant changed the view — reset the baseline.
      setNewIds((s) => (s.size ? new Set() : s));
      setChangedIds((s) => (s.size ? new Set() : s));
      return;
    }

    const delta = diffOrderSnapshots(prev.byId, byId);
    if (delta.newIds.length > 0) {
      setNewIds((s) => new Set([...s, ...delta.newIds]));
    }
    if (delta.changedIds.length > 0) {
      setChangedIds((s) => new Set([...s, ...delta.changedIds]));
    }
  }, [orders, snapshotKey]);

  const dismiss = useCallback(() => {
    setNewIds(new Set());
    setChangedIds(new Set());
  }, []);

  return { newIds, changedIds, dismiss };
}
