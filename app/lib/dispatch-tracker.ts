// Pure logic for the dispatch tracker map on the Orders page: which stage each order is in,
// which orders can be pinned on the map, and the counts shown above the map.

import {
  type Order,
  getDeliveredAt,
  getFulfilledAt,
  isCancelled,
} from "./order-utils";

export type DispatchStage = "awaiting" | "on_the_way" | "delivered";

export interface DispatchPin {
  id: string;
  name: string;
  stage: DispatchStage;
  lat: number;
  lng: number;
  address: string;
}

export interface DispatchSummary {
  awaiting: number;
  on_the_way: number;
  delivered: number;
  // Open orders that have no map pin, so they cannot be drawn.
  unpinned: number;
}

// Says where an order is: delivered, out for delivery (fulfilled), or still waiting to go out.
// Returns null for cancelled orders, which are not part of dispatching.
export function getDispatchStage(order: Order): DispatchStage | null {
  if (isCancelled(order)) return null;
  if (getDeliveredAt(order)) return "delivered";
  const status = (order.displayFulfillmentStatus || "").toUpperCase();
  if (status === "FULFILLED" || getFulfilledAt(order)) return "on_the_way";
  return "awaiting";
}

// Accepts only real numbers inside the valid latitude and longitude range.
function validCoords(
  lat: unknown,
  lng: unknown,
): { lat: number; lng: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Builds the pins and the counts in one pass over the loaded orders.
export function buildDispatchTracker(orders: Order[]): {
  pins: DispatchPin[];
  summary: DispatchSummary;
} {
  const pins: DispatchPin[] = [];
  const summary: DispatchSummary = {
    awaiting: 0,
    on_the_way: 0,
    delivered: 0,
    unpinned: 0,
  };
  for (const order of orders) {
    const stage = getDispatchStage(order);
    if (!stage) continue;
    summary[stage] += 1;
    const addr = order.shippingAddress;
    const coords = validCoords(addr?.latitude, addr?.longitude);
    if (!coords) {
      summary.unpinned += 1;
      continue;
    }
    pins.push({
      id: order.id,
      name: order.name,
      stage,
      lat: coords.lat,
      lng: coords.lng,
      address: [addr?.address1, addr?.city].filter(Boolean).join(", "),
    });
  }
  return { pins, summary };
}
