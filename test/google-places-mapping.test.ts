import { describe, it, expect } from "vitest";
import {
  mapAddressComponents,
  type PlacesAddressComponent,
} from "../app/lib/google-places.client";

const c = (type: string, longText: string): PlacesAddressComponent => ({
  longText,
  shortText: longText,
  types: [type],
});

// The shape Google returns for a full Metro Manila street address.
const FULL: PlacesAddressComponent[] = [
  c("street_number", "11"),
  c("route", "Kalayaan Avenue"),
  c("sublocality_level_1", "Diliman"),
  c("locality", "Quezon City"),
  c("administrative_area_level_1", "Metro Manila"),
  c("country", "Philippines"),
  c("postal_code", "1101"),
];

describe("mapAddressComponents", () => {
  it("maps a full street address", () => {
    expect(mapAddressComponents(FULL)).toEqual({
      address1: "11 Kalayaan Avenue",
      address2: "",
      city: "Quezon City",
      zip: "1101",
    });
  });

  it("keeps the number-before-street order of a PH address line", () => {
    // Component order from Google is not guaranteed — the mapping must not
    // depend on it.
    const shuffled = [...FULL].reverse();
    expect(mapAddressComponents(shuffled).address1).toBe("11 Kalayaan Avenue");
  });

  it("uses the route alone when there is no street number", () => {
    const noNumber = FULL.filter((x) => !x.types?.includes("street_number"));
    expect(mapAddressComponents(noNumber).address1).toBe("Kalayaan Avenue");
  });

  it("returns an empty address1 for an establishment with no street data", () => {
    // resolvePlace falls back to the suggestion label's first segment.
    const mall = [c("locality", "Mandaluyong"), c("postal_code", "1550")];
    expect(mapAddressComponents(mall).address1).toBe("");
  });

  it("puts a subpremise into address2 and never into the street line", () => {
    const withUnit = [...FULL, c("subpremise", "Unit 5B")];
    const mapped = mapAddressComponents(withUnit);
    expect(mapped.address2).toBe("Unit 5B");
    expect(mapped.address1).toBe("11 Kalayaan Avenue");
  });

  it("leaves the zip empty when Google has no postal code", () => {
    const noZip = FULL.filter((x) => !x.types?.includes("postal_code"));
    expect(mapAddressComponents(noZip).zip).toBe("");
  });

  it("falls back through the administrative levels for the city", () => {
    const provincial = [
      c("route", "Rizal Street"),
      c("administrative_area_level_3", "Antipolo"),
      c("administrative_area_level_2", "Rizal"),
    ];
    expect(mapAddressComponents(provincial).city).toBe("Antipolo");
    const level2Only = [c("administrative_area_level_2", "Rizal")];
    expect(mapAddressComponents(level2Only).city).toBe("Rizal");
  });

  it("ignores the barangay sublocality", () => {
    expect(mapAddressComponents(FULL).city).toBe("Quezon City");
  });

  it("survives components with missing fields", () => {
    const ragged: PlacesAddressComponent[] = [
      { types: null },
      { longText: null, types: ["locality"] },
      c("postal_code", " 1101 "),
    ];
    expect(mapAddressComponents(ragged)).toEqual({
      address1: "",
      address2: "",
      city: "",
      zip: "1101",
    });
  });
});
