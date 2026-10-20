import { describe, expect, it } from "vitest";

import { NCR_ZIP_ENTRIES } from "../app/data/ncr-zipcodes";
import { checkDeliveryCoverage } from "../app/services/delivery-coverage.server";

describe("NCR_ZIP_ENTRIES data", () => {
  it("covers all 17 NCR LGUs with a substantial entry count", () => {
    const cities = new Set(NCR_ZIP_ENTRIES.map((e) => e.city));
    expect(cities.size).toBe(17);
    expect(NCR_ZIP_ENTRIES.length).toBeGreaterThan(300);
  });

  it("has digit-only zips (spaces from the source sheet cleaned)", () => {
    for (const entry of NCR_ZIP_ENTRIES) {
      expect(entry.zip).toMatch(/^\d{3,4}$/);
    }
  });
});

describe("checkDeliveryCoverage", () => {
  it("matches an exact zip code", () => {
    const result = checkDeliveryCoverage({ zip: "1300" });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches[0].city).toBe("Pasay");
    }
  });

  it("tolerates spaces and stray text around the zip", () => {
    const result = checkDeliveryCoverage({ zip: " 1209 " });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches[0].city).toBe("Makati");
      expect(result.matches[0].area.toLowerCase()).toContain("bel-air");
    }
  });

  it("reports an unknown zip as not covered", () => {
    const result = checkDeliveryCoverage({ zip: "9999" });
    expect(result).toMatchObject({ ok: true, covered: false });
  });

  it("matches an area/barangay name case- and diacritic-insensitively", () => {
    const result = checkDeliveryCoverage({ area: "BEL AIR" });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches[0].zip).toBe("1209");
    }
  });

  it("matches a city name (e.g. the customer just says the city)", () => {
    const result = checkDeliveryCoverage({ area: "Parañaque" });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches.every((m) => m.city === "Parañaque")).toBe(true);
    }

    const plain = checkDeliveryCoverage({ area: "paranaque" });
    expect(plain).toMatchObject({ ok: true, covered: true });
  });

  it("caps the number of returned matches", () => {
    const result = checkDeliveryCoverage({ area: "Quezon City" });
    expect(result.ok).toBe(true);
    if (result.ok && result.covered) {
      expect(result.matches.length).toBeLessThanOrEqual(8);
    }
  });

  it("maps common aliases like BGC to the sheet's spelling", () => {
    const result = checkDeliveryCoverage({ area: "BGC" });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches[0].area.toLowerCase()).toContain("fort bonifacio");
    }
  });

  it("reports an out-of-coverage place as not covered", () => {
    const result = checkDeliveryCoverage({ area: "Cebu City" });
    expect(result).toMatchObject({ ok: true, covered: false });
  });

  it("errors when neither zip nor area is given", () => {
    const result = checkDeliveryCoverage({});
    expect(result.ok).toBe(false);
  });
});

describe("flat per-city delivery fees (merchant's quoting table, 2026-07)", () => {
  it("quotes P150 for Manila and P200 for QC", () => {
    const manila = checkDeliveryCoverage({ zip: "1000" });
    if (manila.ok && manila.covered) {
      expect(manila.matches[0].flatFeePhp).toBe(150);
    }
    const qc = checkDeliveryCoverage({ area: "Quezon City" });
    if (qc.ok && qc.covered) {
      expect(qc.matches[0].flatFeePhp).toBe(200);
    }
  });

  it("splits Caloocan by zip: South (14:00-19) = P150, North (1420+) = P200", () => {
    const south = checkDeliveryCoverage({ zip: "1405" });
    if (south.ok && south.covered) {
      expect(south.matches[0].flatFeePhp).toBe(150);
    }
    const north = checkDeliveryCoverage({ zip: "1425" });
    if (north.ok && north.covered) {
      expect(north.matches[0].flatFeePhp).toBe(200);
    }
  });

  it("covers provincial towns with a km-based estimate and a condition note", () => {
    // "Dasmariñas" is BOTH a Makati village and a Cavite city — both returned.
    const dasma = checkDeliveryCoverage({ area: "Dasmariñas" });
    expect(dasma).toMatchObject({ ok: true, covered: true });
    if (dasma.ok && dasma.covered) {
      const cavite = dasma.matches.find((m) => m.provincial);
      // Distance-based estimate — dapat malapit sa ~P350 actual checkout rate,
      // hindi ang lumang P450 flat na masyadong mataas.
      expect(cavite?.estimatedFeePhp).toBeGreaterThan(280);
      expect(cavite?.estimatedFeePhp).toBeLessThan(400);
      expect(cavite?.flatFeePhp).toBeUndefined();
      expect(dasma.provincialNote).toBeTruthy();
    }

    const meycauayan = checkDeliveryCoverage({ area: "meycauayan" });
    if (meycauayan.ok && meycauayan.covered) {
      expect(meycauayan.matches[0].estimatedFeePhp).toBeGreaterThan(100);
      expect(meycauayan.matches[0].estimatedKm).toBeGreaterThan(0);
    }
  });

  it("still rejects places in neither list", () => {
    const result = checkDeliveryCoverage({ area: "Baguio" });
    expect(result).toMatchObject({ ok: true, covered: false });
  });
});

describe("delivery fee estimation (Lalamove motorcycle + handling fee)", () => {
  it("computes haversine distance within tolerance (pickup to Makati CPO ~10km)", async () => {
    const { haversineKm, PICKUP_POINT } = await import(
      "../app/services/delivery-coverage.server"
    );
    const km = haversineKm(PICKUP_POINT, { lat: 14.554, lng: 121.018 });
    expect(km).toBeGreaterThan(8);
    expect(km).toBeLessThan(12);
  });

  it("applies the fee bands: base P49 + P6/km first 5km + P5/km beyond + P40 handling", async () => {
    const { estimateDeliveryFeePhp } = await import(
      "../app/services/delivery-coverage.server"
    );
    // 3 km: 49 + 18 + 0 + 40 = 107
    expect(estimateDeliveryFeePhp(3)).toBe(107);
    // 8 km: 49 + 30 + 15 + 40 = 134
    expect(estimateDeliveryFeePhp(8)).toBe(134);
    // Exactly 5 km: 49 + 30 + 40 = 119
    expect(estimateDeliveryFeePhp(5)).toBe(119);
  });

  it("includes an estimated km + fee on covered matches that carry coordinates", () => {
    const result = checkDeliveryCoverage({ zip: "1632" });
    expect(result.ok).toBe(true);
    if (result.ok && result.covered) {
      const withEstimate = result.matches.find((m) => m.estimatedFeePhp !== undefined);
      if (withEstimate) {
        expect(withEstimate.estimatedKm).toBeGreaterThan(0);
        expect(withEstimate.estimatedFeePhp).toBeGreaterThanOrEqual(89);
      }
    }
  });
});
