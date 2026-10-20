// Google Places (New) address search for the "Edit details" modal — client-only.
//
// The Maps JS SDK is injected on demand (first modal open) and never on page
// load: the orders page must not pay the script cost, and a missing/blocked key
// must degrade to the plain manual form, not break it. Suggestions are
// restricted to the Philippines and biased to Metro Manila (the shop only
// delivers there), and every typing burst shares one AutocompleteSessionToken
// so Google bills it as a single session ended by the fetchFields call.

export interface MappedAddress {
  address1: string;
  address2: string;
  city: string;
  zip: string;
}

export interface PlacesAddressComponent {
  longText?: string | null;
  shortText?: string | null;
  types?: string[] | null;
}

interface PlaceHandle {
  fetchFields: (opts: { fields: string[] }) => Promise<unknown>;
  addressComponents?: PlacesAddressComponent[] | null;
}

interface PlacePrediction {
  placeId?: string | null;
  text?: { text?: string | null } | null;
  toPlace: () => PlaceHandle;
}

interface PlacesLibrary {
  AutocompleteSessionToken: new () => object;
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions: (request: {
      input: string;
      sessionToken: object;
      includedRegionCodes: string[];
      locationBias: { north: number; south: number; east: number; west: number };
    }) => Promise<{
      suggestions: Array<{ placePrediction?: PlacePrediction | null }>;
    }>;
  };
}

export interface AddressSuggestion {
  placeId: string;
  label: string;
  /** SDK handle back to the prediction — carries the billing session. */
  prediction: PlacePrediction;
}

// Rough Metro Manila bounding box (Valenzuela down to Muntinlupa). A bias, not
// a hard filter — a Rizal or Cavite address the merchant genuinely needs can
// still surface, just ranked below the in-city matches.
const METRO_MANILA_BOUNDS = {
  north: 14.79,
  south: 14.35,
  east: 121.13,
  west: 120.9,
};

const CALLBACK_NAME = "__deliverySchedulerMapsReady";

let sdkPromise: Promise<PlacesLibrary> | null = null;

/**
 * Inject the Maps JS SDK once and resolve to its Places library. Rejects when
 * the script fails to load (bad key, adblock, offline) — callers hide the
 * search field on rejection and the manual form carries on.
 */
export function loadPlacesLibrary(apiKey: string): Promise<PlacesLibrary> {
  if (!apiKey) {
    return Promise.reject(new Error("Missing Google Maps API key"));
  }
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve, reject) => {
      const w = window as unknown as Record<string, unknown>;
      const existing = (w.google as { maps?: { importLibrary?: unknown } })
        ?.maps?.importLibrary;
      if (typeof existing === "function") {
        resolve();
        return;
      }
      w[CALLBACK_NAME] = () => resolve();
      const script = document.createElement("script");
      script.src =
        "https://maps.googleapis.com/maps/api/js" +
        `?key=${encodeURIComponent(apiKey)}` +
        `&v=weekly&loading=async&callback=${CALLBACK_NAME}`;
      script.async = true;
      script.onerror = () => reject(new Error("Google Maps SDK failed to load"));
      document.head.appendChild(script);
    }).then(() => {
      const w = window as unknown as {
        google: { maps: { importLibrary: (name: string) => Promise<unknown> } };
      };
      return w.google.maps.importLibrary("places") as Promise<PlacesLibrary>;
    });
    // A failed load must not poison every later retry (e.g. the merchant's
    // network blipped) — the next modal open starts a fresh attempt.
    sdkPromise.catch(() => {
      sdkPromise = null;
    });
  }
  return sdkPromise;
}

/** One token per typing burst; pass it to every suggestion fetch until a place is resolved. */
export async function createSessionToken(apiKey: string): Promise<object> {
  const places = await loadPlacesLibrary(apiKey);
  return new places.AutocompleteSessionToken();
}

export async function fetchAddressSuggestions(
  apiKey: string,
  input: string,
  sessionToken: object,
): Promise<AddressSuggestion[]> {
  const places = await loadPlacesLibrary(apiKey);
  const { suggestions } =
    await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input,
      sessionToken,
      includedRegionCodes: ["ph"],
      locationBias: METRO_MANILA_BOUNDS,
    });
  const out: AddressSuggestion[] = [];
  for (const s of suggestions) {
    const p = s.placePrediction;
    if (!p?.placeId) continue;
    out.push({
      placeId: p.placeId,
      label: p.text?.text ?? "",
      prediction: p,
    });
  }
  return out;
}

/**
 * Resolve a picked suggestion into form fields. addressComponents is the only
 * field requested — it is the cheapest SKU that carries street/city/ZIP, and
 * fetchFields is also what closes the billing session.
 */
export async function resolvePlace(
  item: AddressSuggestion,
): Promise<MappedAddress> {
  const place = item.prediction.toPlace();
  await place.fetchFields({ fields: ["addressComponents"] });
  const mapped = mapAddressComponents(place.addressComponents ?? []);
  if (!mapped.address1) {
    // Establishments ("SM Megamall") often have no street_number/route — the
    // suggestion's own first segment is the best street line available.
    mapped.address1 = item.label.split(",")[0]?.trim() ?? "";
  }
  return mapped;
}

/**
 * Pure mapping from Google address components to the modal's fields.
 * PH shapes: `locality` is the city ("Quezon City"); `subpremise` is a unit
 * number when Google knows one; barangays arrive as sublocality and are
 * deliberately ignored — they belong in the street line the merchant writes.
 */
export function mapAddressComponents(
  components: PlacesAddressComponent[],
): MappedAddress {
  const find = (type: string): string => {
    const hit = components.find((c) => c.types?.includes(type));
    return (hit?.longText ?? "").trim();
  };
  const streetNumber = find("street_number");
  const route = find("route");
  return {
    address1: [streetNumber, route].filter(Boolean).join(" "),
    address2: find("subpremise"),
    // Outside the city proper Google sometimes files the town under an
    // administrative_area level instead of locality.
    city:
      find("locality") ||
      find("administrative_area_level_3") ||
      find("administrative_area_level_2"),
    zip: find("postal_code"),
  };
}

interface MapsGlobal {
  google: {
    maps: {
      importLibrary: (name: string) => Promise<unknown>;
      SymbolPath: { CIRCLE: number };
      Map: new (el: HTMLElement, opts: object) => MapHandle;
      Marker: new (opts: object) => MarkerHandle;
      LatLngBounds: new () => BoundsHandle;
    };
  };
}

export interface MarkerHandle {
  setMap: (map: MapHandle | null) => void;
  addListener: (event: string, handler: () => void) => void;
}

export interface BoundsHandle {
  extend: (point: { lat: number; lng: number }) => void;
}

export interface MapHandle {
  fitBounds: (bounds: BoundsHandle, padding?: number) => void;
  setCenter: (point: { lat: number; lng: number }) => void;
  setZoom: (zoom: number) => void;
}

/**
 * Loads the Maps JS SDK (same script as the address search) and returns the
 * `google.maps` namespace with the map library ready. Rejects when the script
 * cannot load, so the caller can show a plain message instead of a map.
 */
export async function loadMapsNamespace(
  apiKey: string,
): Promise<MapsGlobal["google"]["maps"]> {
  await loadPlacesLibrary(apiKey);
  const w = window as unknown as MapsGlobal;
  await w.google.maps.importLibrary("maps");
  return w.google.maps;
}
