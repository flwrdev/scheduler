import { describe, it, expect } from "vitest";
import {
  buildNextShippingAddress,
  hasContactChanges,
  validateOrderContactPatch,
  type OrderContactPatch,
  type OrderShippingAddressSnapshot,
} from "../app/services/update-order-contact.server";

const CURRENT: OrderShippingAddressSnapshot = {
  firstName: "Glenard",
  lastName: "Alondra",
  company: "PAVAHAI",
  address1: "Rd 5 BLK 6 Lot 1 Comembo",
  address2: "Comembo",
  city: "Taguig City",
  province: "Metro Manila",
  provinceCode: "PH-00",
  country: "Philippines",
  countryCodeV2: "PH",
  zip: "1630",
  phone: "09939028780",
};

const patch = (over: Partial<OrderContactPatch> = {}): OrderContactPatch => ({
  address1: CURRENT.address1 ?? "",
  address2: CURRENT.address2 ?? "",
  city: CURRENT.city ?? "",
  phone: CURRENT.phone ?? "",
  ...over,
});

describe("validateOrderContactPatch", () => {
  it("requires a street address", () => {
    const result = validateOrderContactPatch(patch({ address1: "   " }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/street address/i);
  });

  it("requires a city", () => {
    const result = validateOrderContactPatch(patch({ city: "" }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/city/i);
  });

  it("allows an empty apartment and phone", () => {
    expect(
      validateOrderContactPatch(patch({ address2: "", phone: "" })).ok,
    ).toBe(true);
  });

  it("accepts the several spellings a PH mobile number arrives in", () => {
    for (const phone of ["09939028780", "+639939028780", "0993 902 8780"]) {
      expect(validateOrderContactPatch(patch({ phone })).ok).toBe(true);
    }
  });

  it("rejects an over-long street address", () => {
    const result = validateOrderContactPatch(
      patch({ address1: "x".repeat(256) }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/255/);
  });

  it("rejects an over-long city", () => {
    expect(validateOrderContactPatch(patch({ city: "x".repeat(129) })).ok).toBe(
      false,
    );
  });

  it("rejects an over-long ZIP but allows an absent one", () => {
    expect(validateOrderContactPatch(patch({ zip: "x".repeat(17) })).ok).toBe(
      false,
    );
    expect(validateOrderContactPatch(patch({ zip: "1226" })).ok).toBe(true);
    expect(validateOrderContactPatch(patch()).ok).toBe(true);
  });
});

describe("buildNextShippingAddress", () => {
  it("carries forward every field the merchant cannot edit", () => {
    const next = buildNextShippingAddress(CURRENT, patch());
    expect(next.firstName).toBe("Glenard");
    expect(next.lastName).toBe("Alondra");
    expect(next.company).toBe("PAVAHAI");
    expect(next.provinceCode).toBe("PH-00");
    expect(next.countryCode).toBe("PH");
    expect(next.zip).toBe("1630");
  });

  // The ZIP has no manual form field. It reaches the patch only when the
  // Places address search supplied a postal code; absent/blank means the
  // stored ZIP is carried forward, because `zip: ""` fails the whole PH
  // mutation.
  it("carries the stored ZIP forward when the patch has none", () => {
    const next = buildNextShippingAddress(CURRENT, patch());
    expect(next.zip).toBe(CURRENT.zip);
  });

  it("takes a ZIP the address search supplied", () => {
    const next = buildNextShippingAddress(CURRENT, patch({ zip: "1226" }));
    expect(next.zip).toBe("1226");
  });

  it("treats a blank patch ZIP as absent — never sends an empty zip", () => {
    for (const zip of ["", "   "]) {
      expect(buildNextShippingAddress(CURRENT, patch({ zip })).zip).toBe(
        "1630",
      );
    }
    const noStored: OrderShippingAddressSnapshot = { ...CURRENT, zip: null };
    expect(
      buildNextShippingAddress(noStored, patch({ zip: "" })),
    ).not.toHaveProperty("zip");
  });

  it("writes a searched ZIP even when the stored address had none", () => {
    const noStored: OrderShippingAddressSnapshot = { ...CURRENT, zip: null };
    expect(buildNextShippingAddress(noStored, patch({ zip: "1226" })).zip).toBe(
      "1226",
    );
  });

  it("omits the ZIP when the stored address has none", () => {
    const noZip: OrderShippingAddressSnapshot = { ...CURRENT, zip: null };
    expect(buildNextShippingAddress(noZip, patch())).not.toHaveProperty("zip");
  });

  it("maps the read-side countryCodeV2 onto the write-side countryCode", () => {
    const next = buildNextShippingAddress(CURRENT, patch());
    expect(next.countryCode).toBe("PH");
    expect(next).not.toHaveProperty("countryCodeV2");
  });

  it("never emits the free-text province or country", () => {
    // MailingAddressInput has provinceCode/countryCode only — sending the
    // display strings is a hard GraphQL error.
    const next = buildNextShippingAddress(CURRENT, patch());
    expect(next).not.toHaveProperty("province");
    expect(next).not.toHaveProperty("country");
  });

  it("applies the edited fields", () => {
    const next = buildNextShippingAddress(
      CURRENT,
      patch({
        address1: "12 Kalayaan Ave",
        city: "Quezon City",
        phone: "09171234567",
      }),
    );
    expect(next.address1).toBe("12 Kalayaan Ave");
    expect(next.city).toBe("Quezon City");
    expect(next.phone).toBe("09171234567");
    // …and the ZIP rides along untouched.
    expect(next.zip).toBe("1630");
  });

  it("trims whitespace off every value", () => {
    const next = buildNextShippingAddress(
      CURRENT,
      patch({ address1: "  12 Kalayaan Ave  ", city: " Quezon City " }),
    );
    expect(next.address1).toBe("12 Kalayaan Ave");
    expect(next.city).toBe("Quezon City");
  });

  // Live-verified 2026-08-14: shippingAddress MERGES (the schema doc's
  // "overwrites" is wrong), so an omitted key is a silent no-op. Only an
  // explicit "" actually clears a field.
  it("sends an explicit empty string to clear the apartment and phone", () => {
    const next = buildNextShippingAddress(
      CURRENT,
      patch({ address2: "", phone: "" }),
    );
    expect(next.address2).toBe("");
    expect(next.phone).toBe("");
    // …while the carry-forward fields are still present.
    expect(next.firstName).toBe("Glenard");
    expect(next.countryCode).toBe("PH");
    expect(next.zip).toBe("1630");
  });

  it("never sends an empty carry-forward key", () => {
    // countryCode is an enum — "" is a hard GraphQL error, not a clear.
    const sparse: OrderShippingAddressSnapshot = {
      address1: "1 Main St",
      city: "Manila",
    };
    const next = buildNextShippingAddress(sparse, patch());
    for (const key of [
      "firstName",
      "lastName",
      "company",
      "provinceCode",
      "countryCode",
      "zip",
    ]) {
      expect(next).not.toHaveProperty(key);
    }
  });

  it("still produces a usable input when there is no stored address", () => {
    const next = buildNextShippingAddress(
      null,
      patch({ address1: "1 Main St", city: "Manila", address2: "", phone: "" }),
    );
    expect(next).toEqual({
      address1: "1 Main St",
      city: "Manila",
      address2: "",
      phone: "",
    });
  });

  it("matches the input that was live-verified against order #1043", () => {
    // The exact shape the dev-store smoke ran on 2026-08-14: Shopify accepted
    // it, applied the street edit and the new phone, and left the recipient
    // name, province, country, and ZIP intact.
    const live: OrderShippingAddressSnapshot = {
      firstName: "The",
      lastName: "FlowerCart",
      company: null,
      address1: "255 Kawit Street",
      address2: "146",
      city: "Manila",
      province: "Metro Manila",
      provinceCode: "PH-00",
      country: "Philippines",
      countryCodeV2: "PH",
      zip: "1013",
      phone: null,
    };
    const next = buildNextShippingAddress(live, {
      address1: "SMOKE 12 Kalayaan Ave",
      address2: "146",
      city: "Manila",
      phone: "09171234567",
    });
    expect(next).toEqual({
      firstName: "The",
      lastName: "FlowerCart",
      provinceCode: "PH-00",
      countryCode: "PH",
      zip: "1013",
      address1: "SMOKE 12 Kalayaan Ave",
      address2: "146",
      city: "Manila",
      phone: "09171234567",
    });
  });
});

describe("hasContactChanges", () => {
  it("is false when nothing moved", () => {
    expect(hasContactChanges(CURRENT, patch())).toBe(false);
  });

  it("ignores whitespace-only differences", () => {
    expect(
      hasContactChanges(
        CURRENT,
        patch({ address1: "  Rd 5 BLK 6 Lot 1 Comembo  " }),
      ),
    ).toBe(false);
  });

  it.each([
    ["address1", { address1: "12 Kalayaan Ave" }],
    ["address2", { address2: "Unit 4B" }],
    ["city", { city: "Quezon City" }],
    ["phone", { phone: "09171234567" }],
    ["zip", { zip: "1226" }],
  ])("detects an edited %s", (_field, over) => {
    expect(hasContactChanges(CURRENT, patch(over))).toBe(true);
  });

  it("ignores a blank or unchanged patch ZIP", () => {
    expect(hasContactChanges(CURRENT, patch({ zip: "" }))).toBe(false);
    expect(hasContactChanges(CURRENT, patch({ zip: " 1630 " }))).toBe(false);
  });

  it("detects a cleared field", () => {
    expect(hasContactChanges(CURRENT, patch({ phone: "" }))).toBe(true);
  });

  it("treats a first-ever address as a change", () => {
    expect(hasContactChanges(null, patch())).toBe(true);
  });
});
