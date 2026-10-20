// Dispatch tracker: a Google map above the order table. Each pin is one order on the loaded
// page, coloured by stage (waiting to go out, on the way, delivered). Clicking a pin opens
// the order panel. The map only reads data; it never changes an order.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type DispatchStage,
  buildDispatchTracker,
} from "../../lib/dispatch-tracker";
import { loadMapsNamespace } from "../../lib/google-places.client";
import type { Order } from "../../lib/order-utils";

export interface DispatchTrackerProps {
  orders: Order[];
  mapsApiKey: string;
  onOpenOrder: (orderId: string) => void;
}

const STAGE_META: Record<DispatchStage, { label: string; color: string }> = {
  awaiting: { label: "Waiting to dispatch", color: "#d97706" },
  on_the_way: { label: "On the way", color: "#2563eb" },
  delivered: { label: "Delivered", color: "#16a34a" },
};

const STAGES: DispatchStage[] = ["awaiting", "on_the_way", "delivered"];

// Shows the stage counts and the map. If the map cannot load, the counts still show.
export function DispatchTracker({
  orders,
  mapsApiKey,
  onOpenOrder,
}: DispatchTrackerProps) {
  const { pins, summary } = useMemo(
    () => buildDispatchTracker(orders),
    [orders],
  );
  const mapEl = useRef<HTMLDivElement | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  // Keep the latest click handler without redrawing the map every render.
  const openRef = useRef(onOpenOrder);
  useEffect(() => {
    openRef.current = onOpenOrder;
  }, [onOpenOrder]);

  // Draws the pins and zooms the map to fit them all. Clears the old pins on change.
  useEffect(() => {
    if (!mapsApiKey || pins.length === 0 || !mapEl.current) return;
    let cancelled = false;
    const markers: { setMap: (m: null) => void }[] = [];
    loadMapsNamespace(mapsApiKey)
      .then((maps) => {
        if (cancelled || !mapEl.current) return;
        const map = new maps.Map(mapEl.current, {
          center: { lat: pins[0].lat, lng: pins[0].lng },
          zoom: 11,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
        });
        const bounds = new maps.LatLngBounds();
        for (const pin of pins) {
          const marker = new maps.Marker({
            map,
            position: { lat: pin.lat, lng: pin.lng },
            title: `${pin.name} · ${STAGE_META[pin.stage].label}${
              pin.address ? ` · ${pin.address}` : ""
            }`,
            icon: {
              path: maps.SymbolPath.CIRCLE,
              scale: 9,
              fillColor: STAGE_META[pin.stage].color,
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
            },
          });
          marker.addListener("click", () => openRef.current(pin.id));
          markers.push(marker);
          bounds.extend({ lat: pin.lat, lng: pin.lng });
        }
        if (pins.length === 1) {
          map.setCenter({ lat: pins[0].lat, lng: pins[0].lng });
          map.setZoom(15);
        } else {
          map.fitBounds(bounds, 40);
        }
        setMapFailed(false);
      })
      .catch(() => {
        if (!cancelled) setMapFailed(true);
      });
    return () => {
      cancelled = true;
      for (const m of markers) m.setMap(null);
    };
  }, [pins, mapsApiKey]);

  const showMap = Boolean(mapsApiKey) && pins.length > 0 && !mapFailed;
  let note = "";
  if (!mapsApiKey) note = "The map is off because no Google Maps key is set.";
  else if (mapFailed) note = "The map could not load. Try Refresh.";
  else if (pins.length === 0)
    note = "No orders with a map location in this view.";

  return (
    <s-section>
      <s-stack gap="small-200">
        <s-stack
          direction="inline"
          gap="base"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-text fontWeight="semibold">Dispatch tracker</s-text>
          <s-stack direction="inline" gap="base" alignItems="center">
            {STAGES.map((stage) => (
              <s-stack
                key={stage}
                direction="inline"
                gap="small-300"
                alignItems="center"
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: STAGE_META[stage].color,
                    display: "inline-block",
                  }}
                />
                <s-text fontSize="small">
                  {STAGE_META[stage].label}: {summary[stage]}
                </s-text>
              </s-stack>
            ))}
          </s-stack>
        </s-stack>
        {showMap && (
          <div
            ref={mapEl}
            role="region"
            aria-label="Dispatch map"
            style={{ width: "100%", height: 320, borderRadius: 8 }}
          />
        )}
        {note && (
          <s-text color="subdued" fontSize="small">
            {note}
          </s-text>
        )}
        {summary.unpinned > 0 && (
          <s-text color="subdued" fontSize="small">
            {summary.unpinned} order{summary.unpinned === 1 ? "" : "s"} not
            shown on the map (no location on the address).
          </s-text>
        )}
      </s-stack>
    </s-section>
  );
}
