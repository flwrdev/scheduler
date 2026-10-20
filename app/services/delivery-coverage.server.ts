// Delivery-coverage lookup for the FlowerCart Messenger agent.
//
// Backed by the merchant's own zip/barangay list (Google Drive
// "zip code - Sheet1.csv" — the same copy they use for local delivery),
// generated into app/data/ncr-zipcodes.ts. Pure in-process lookup: no
// external API in the conversation hot path (architecture rule), no
// Google Maps dependency.
//
// Answers "saan kayo nagde-deliver / covered ba kami?" and, for entries with
// baked coordinates, an ESTIMATED fee (haversine x road factor through the
// Lalamove motorcycle bands + handling fee). The exact fee is always the
// Lalamove-calculated shipping rate at checkout — the agent may quote the
// estimate only as "tantiya".

import { NCR_ZIP_ENTRIES } from "../data/ncr-zipcodes";
import type { NcrZipEntry } from "../data/ncr-zipcodes";

const MAX_MATCHES = 8;

// The Flowercart pickup point (merchant-provided) and the Lalamove motorcycle
// dynamic-price bands + the merchant's Shopify handling fee. The estimate is
// straight-line distance x a road factor — close to but never exactly the
// Lalamove-routed checkout fee; the agent must present it as an ESTIMATE.
export const PICKUP_POINT = { lat: 14.63226007982472, lng: 120.96984450954608 };
const ROAD_FACTOR = 1.4;
const BASE_FARE_PHP = 49;
const PER_KM_FIRST5_PHP = 6;
const PER_KM_BEYOND5_PHP = 5;
const HANDLING_FEE_PHP = 40;

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function estimateDeliveryFeePhp(roadKm: number): number {
  const first = Math.min(roadKm, 5) * PER_KM_FIRST5_PHP;
  const beyond = Math.max(0, roadKm - 5) * PER_KM_BEYOND5_PHP;
  return Math.round(BASE_FARE_PHP + first + beyond + HANDLING_FEE_PHP);
}

// Merchant's flat quoting table ("Delivery Fees by City", Meta knowledge base,
// updated 2026-07). Since 2026-08-02 the km-based estimate is the PRIMARY quote
// (mas dikit sa distance-based checkout); this table is the NCR-only fallback
// when an entry has no coordinates.
const CITY_FLAT_FEE_PHP: Record<string, number> = {
  manila: 150,
  malabon: 150,
  navotas: 150,
  valenzuela: 200,
  mandaluyong: 200,
  "san juan": 200,
  makati: 200,
  pasay: 200,
  "quezon city": 200,
  pasig: 250,
  taguig: 250,
  paranaque: 250,
  "las pinas": 250,
  marikina: 250,
  pateros: 250,
  muntinlupa: 300,
};

// Caloocan is split in the merchant's table: South P150, North P200.
function caloocanFlatFee(zip: string): number {
  return Number(zip) >= 1420 ? 200 : 150;
}

// Towns OUTSIDE Metro Manila from the merchant's coverage page — covered, pero
// conditional: deliveries can take longer; advance booking recommended.
// Town-center coordinates: one-time Nominatim geocode (2026-08-02, build-time).
// Ang quoted fee nila ay ang km-based estimate — ang lumang flat table (P200-450)
// ay masyadong malayo sa distance-based checkout rate kaya tinanggal.
const PROVINCIAL_AREAS: Array<{ name: string; province: string; lat: number; lng: number }> = [
  { name: "Meycauayan", province: "Bulacan", lat: 14.7345008, lng: 120.9571635 },
  { name: "Marilao", province: "Bulacan", lat: 14.7575956, lng: 120.9484672 },
  { name: "Obando", province: "Bulacan", lat: 14.70989, lng: 120.9365149 },
  { name: "Bocaue", province: "Bulacan", lat: 14.7954178, lng: 120.9253578 },
  { name: "Balagtas", province: "Bulacan", lat: 14.8177897, lng: 120.9064492 },
  { name: "San Jose del Monte", province: "Bulacan", lat: 14.8101978, lng: 121.0474088 },
  { name: "Cainta", province: "Rizal", lat: 14.5780161, lng: 121.1163072 },
  { name: "Taytay", province: "Rizal", lat: 14.5587089, lng: 121.1359659 },
  { name: "Rodriguez (Montalban)", province: "Rizal", lat: 14.7324642, lng: 121.1453418 },
  { name: "Antipolo", province: "Rizal", lat: 14.5871972, lng: 121.1759246 },
  { name: "San Mateo", province: "Rizal", lat: 14.6951949, lng: 121.1174024 },
  { name: "Binangonan", province: "Rizal", lat: 14.4647563, lng: 121.1923358 },
  { name: "Angono", province: "Rizal", lat: 14.5258481, lng: 121.1529683 },
  { name: "Cavite City", province: "Cavite", lat: 14.4820919, lng: 120.908919 },
  { name: "Bacoor", province: "Cavite", lat: 14.4596033, lng: 120.9598169 },
  { name: "Imus", province: "Cavite", lat: 14.4290216, lng: 120.9365838 },
  { name: "Kawit", province: "Cavite", lat: 14.4442694, lng: 120.9035361 },
  { name: "Molino", province: "Cavite", lat: 14.3942698, lng: 120.9862923 },
  { name: "Noveleta", province: "Cavite", lat: 14.4278394, lng: 120.8808454 },
  { name: "Rosario", province: "Cavite", lat: 14.4167151, lng: 120.8552642 },
  { name: "General Trias", province: "Cavite", lat: 14.3861207, lng: 120.8802855 },
  { name: "Dasmariñas", province: "Cavite", lat: 14.3270819, lng: 120.9370871 },
  { name: "San Pedro", province: "Laguna", lat: 14.3639435, lng: 121.056771 },
  { name: "Biñan", province: "Laguna", lat: 14.3388259, lng: 121.0841826 },
  { name: "Santa Rosa", province: "Laguna", lat: 14.3146042, lng: 121.1137004 },
  { name: "Cabuyao", province: "Laguna", lat: 14.280145, lng: 121.1234786 },
  { name: "Calamba", province: "Laguna", lat: 14.2060217, lng: 121.1556496 },
];

const PROVINCIAL_NOTE =
  "Outside-Metro-Manila area: covered, and same-day delivery is available (same slots and cutoff as Metro Manila).";

export interface CoverageMatch extends NcrZipEntry {
  estimatedKm?: number;
  estimatedFeePhp?: number;
  /** Merchant's flat quoted fee for this city/town (the fee the agent quotes). */
  flatFeePhp?: number;
  provincial?: boolean;
}

export interface CheckDeliveryCoverageInput {
  zip?: string;
  area?: string;
}

export type CheckDeliveryCoverageResult =
  | { ok: true; covered: true; matches: CoverageMatch[]; feeNote: string; provincialNote?: string }
  | { ok: true; covered: false; note: string }
  | { ok: false; error: string };

const FEE_NOTE =
  "Quote estimatedFeePhp as the delivery fee ESTIMATE — it mirrors the distance-based checkout computation. flatFeePhp (Metro Manila only) is the shop's typical per-city fee, a fallback when there is no estimate. The exact fee always shows at checkout. Free shipping on orders P2,500 and up.";

function flatFeeFor(entry: NcrZipEntry): number | undefined {
  const cityNorm = entry.city
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  if (cityNorm === "caloocan") {
    return caloocanFlatFee(entry.zip);
  }
  return CITY_FLAT_FEE_PHP[cityNorm];
}

function toMatch(entry: NcrZipEntry): CoverageMatch {
  const match: CoverageMatch = { ...entry, flatFeePhp: flatFeeFor(entry) };
  if (entry.lat === undefined || entry.lng === undefined) {
    return match;
  }
  const roadKm =
    Math.round(haversineKm(PICKUP_POINT, { lat: entry.lat, lng: entry.lng }) * ROAD_FACTOR * 10) /
    10;
  return { ...match, estimatedKm: roadKm, estimatedFeePhp: estimateDeliveryFeePhp(roadKm) };
}

const NORMALIZED_PROVINCIAL = PROVINCIAL_AREAS.map((p) => ({
  p,
  nameNorm: p.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim(),
}));

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const NORMALIZED_ENTRIES = NCR_ZIP_ENTRIES.map((entry) => ({
  entry,
  areaNorm: normalize(entry.area),
  cityNorm: normalize(entry.city),
}));

// Common customer spellings that don't appear verbatim in the merchant's sheet.
const AREA_ALIASES: Record<string, string> = {
  bgc: "fort bonifacio",
  "bonifacio global city": "fort bonifacio",
  "the fort": "fort bonifacio",
  qc: "quezon city",
  kalookan: "caloocan",
  maynila: "manila",
  "las pinas city": "las pinas",
};

export function checkDeliveryCoverage(
  input: CheckDeliveryCoverageInput,
): CheckDeliveryCoverageResult {
  const zipDigits = (input.zip ?? "").replace(/\D+/g, "");
  let areaNorm = normalize(input.area ?? "");
  if (AREA_ALIASES[areaNorm]) {
    areaNorm = AREA_ALIASES[areaNorm];
  } else {
    // The alias may be embedded ("BGC, Taguig" -> "bgc taguig"): expand on a
    // whole-word alias hit so "BGC" still resolves to fort bonifacio.
    for (const [alias, canonical] of Object.entries(AREA_ALIASES)) {
      if (new RegExp(`\\b${alias}\\b`).test(areaNorm)) {
        areaNorm = canonical;
        break;
      }
    }
  }

  if (!zipDigits && !areaNorm) {
    return { ok: false, error: "Provide a zip code or a barangay/area/city name." };
  }

  if (zipDigits) {
    const matches = NORMALIZED_ENTRIES.filter(({ entry }) => entry.zip === zipDigits)
      .map(({ entry }) => toMatch(entry))
      .slice(0, MAX_MATCHES);
    if (matches.length) {
      return { ok: true, covered: true, matches, feeNote: FEE_NOTE };
    }
    if (!areaNorm) {
      return {
        ok: true,
        covered: false,
        note: `Zip ${zipDigits} is not in the Metro Manila delivery list.`,
      };
    }
  }

  if (areaNorm) {
    // NCR: city-level match first, then area substring both directions.
    const cityMatches = NORMALIZED_ENTRIES.filter(
      ({ cityNorm }) => cityNorm === areaNorm || areaNorm.includes(cityNorm),
    );
    const ncrPool = cityMatches.length
      ? cityMatches
      : NORMALIZED_ENTRIES.filter(
          ({ areaNorm: candidate }) =>
            candidate.includes(areaNorm) || (areaNorm.length >= 4 && areaNorm.includes(candidate)),
        );

    // Provincial towns from the merchant's fee table. Names like "Dasmarinas"
    // exist BOTH as an NCR village and a Cavite city — return both and let the
    // agent ask the customer which one they mean.
    const provincial = NORMALIZED_PROVINCIAL.filter(
      ({ nameNorm }) =>
        nameNorm.includes(areaNorm) || (areaNorm.length >= 4 && areaNorm.includes(nameNorm)),
    );

    if (ncrPool.length || provincial.length) {
      const matches: CoverageMatch[] = [
        ...ncrPool.slice(0, MAX_MATCHES).map((candidate) => toMatch(candidate.entry)),
        ...provincial.slice(0, MAX_MATCHES).map(({ p }) => {
          const roadKm =
            Math.round(haversineKm(PICKUP_POINT, { lat: p.lat, lng: p.lng }) * ROAD_FACTOR * 10) /
            10;
          return {
            area: p.name,
            zip: "",
            city: `${p.name}, ${p.province}`,
            estimatedKm: roadKm,
            estimatedFeePhp: estimateDeliveryFeePhp(roadKm),
            provincial: true,
          };
        }),
      ].slice(0, MAX_MATCHES + 2);
      return {
        ok: true,
        covered: true,
        matches,
        feeNote: FEE_NOTE,
        ...(provincial.length ? { provincialNote: PROVINCIAL_NOTE } : {}),
      };
    }
  }

  return {
    ok: true,
    covered: false,
    note: "That place is not in the delivery coverage list.",
  };
}
