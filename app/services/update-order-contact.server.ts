// The "Edit details" action: rewrites an order's shipping address (street, city, ZIP) and the
// receiver's phone through Shopify's orderUpdate, validating the input first. It does not touch
// any delivery metafield or schedule tag.

import { getShopLocalDate } from "../lib/delivery-availability";
import { buildOrderEventTag } from "../lib/order-tags";
import type { AdminGraphQLClient } from "./order-delivery-metafields.server";

// Merchant "Edit details" (Orders Ops — panel Actions menu). Rewrites the
// order's SHIPPING ADDRESS only: street, city, ZIP, and the receiver's phone.
//
// This is an order write path but NOT a delivery write path — it touches no
// delivery metafield, tag, or customAttribute, so the docs/api.md §2 table of
// delivery writers is unchanged.
//
// ⚠️ How `OrderInput.shippingAddress` actually behaves — measured live against
// a dev-store order on 2026-08-14, because the schema documentation is WRONG
// about the most important part:
//
//   · The docs say it "Overwrites the existing shipping address". It does NOT.
//     It MERGES: a key left out of the input is left unchanged. Verified by
//     sending address1 alone and watching firstName/lastName/city/zip survive.
//   · An empty string CLEARS a field (verified on address2 and phone). So
//     "clear this field" must be an explicit "", never an omitted key —
//     omitting it is a silent no-op that still reports success.
//   · `zip: ""` is REJECTED for PH addresses ("Enter a postal code") and the
//     rejection kills the WHOLE mutation. The ZIP therefore has no manual form
//     field and can never be cleared. It IS conditionally writable since the
//     Places address search landed: when the picked address carries a postal
//     code the modal submits it, a blank submission is treated as absent, and
//     absent means the stored ZIP is carried forward like the recipient name.
//   · The read field is `countryCodeV2`; the write field is `countryCode`.
//
// The carry-forward of the non-editable fields (firstName, lastName, company,
// provinceCode, countryCode) is now belt-and-braces rather than load-bearing —
// merge semantics already preserve them. It is kept deliberately: the
// documented contract is "overwrite", so if Shopify ever makes the behaviour
// match the docs, this keeps working. `buildNextShippingAddress` is the one
// place it happens; nothing else builds this input.

const SHOPIFY_ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

export const MAX_ADDRESS_LINE_LENGTH = 255;
export const MAX_CITY_LENGTH = 128;
export const MAX_PHONE_LENGTH = 32;
export const MAX_ZIP_LENGTH = 16;

/**
 * The current address as READ from Shopify. Note `countryCodeV2` — the read
 * field and the write field are spelled differently (`countryCode` on
 * MailingAddressInput), which is exactly the kind of mismatch that silently
 * drops a country on save.
 */
export interface OrderShippingAddressSnapshot {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  country?: string | null;
  countryCodeV2?: string | null;
  zip?: string | null;
  phone?: string | null;
}

/**
 * The fields the merchant may actually change. `zip` is special: it has no
 * manual input — it only arrives when the Places address search supplied a
 * postal code — and it is either absent or non-empty, never "".
 */
export interface OrderContactPatch {
  address1: string;
  address2: string;
  city: string;
  phone: string;
  zip?: string;
}

/** Response shape of the `editDetails` op — read by the EditDetailsModal fetcher. */
export interface EditDetailsResponse {
  ok: boolean;
  message: string;
}

const ORDER_SHIPPING_ADDRESS_QUERY = `#graphql
  query OrderShippingAddress($id: ID!) {
    order(id: $id) {
      id
      displayFulfillmentStatus
      shippingAddress {
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        country
        countryCodeV2
        zip
        phone
      }
    }
  }
`;

const UPDATE_ORDER_SHIPPING_ADDRESS_MUTATION = `#graphql
  mutation UpdateOrderShippingAddress($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        shippingAddress {
          address1
          address2
          city
          zip
          phone
        }
      }
      userErrors { field message }
    }
  }
`;

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface OrderContactValidation {
  ok: boolean;
  message?: string;
}

/**
 * Pure field validation. Deliberately permissive on phone shape — Shopify
 * normalizes and reports its own userError, and PH mobile numbers reach this
 * form in several spellings (09xx, +639xx, with spaces). Only length and the
 * two genuinely required fields are enforced here.
 */
export function validateOrderContactPatch(
  patch: OrderContactPatch,
): OrderContactValidation {
  const address1 = trimmed(patch.address1);
  const city = trimmed(patch.city);

  if (!address1) {
    return { ok: false, message: "Enter a street address." };
  }
  if (address1.length > MAX_ADDRESS_LINE_LENGTH) {
    return {
      ok: false,
      message: `Street address must be ${MAX_ADDRESS_LINE_LENGTH} characters or fewer.`,
    };
  }
  if (trimmed(patch.address2).length > MAX_ADDRESS_LINE_LENGTH) {
    return {
      ok: false,
      message: `Apartment / unit must be ${MAX_ADDRESS_LINE_LENGTH} characters or fewer.`,
    };
  }
  if (!city) {
    return { ok: false, message: "Enter a city." };
  }
  if (city.length > MAX_CITY_LENGTH) {
    return {
      ok: false,
      message: `City must be ${MAX_CITY_LENGTH} characters or fewer.`,
    };
  }
  if (trimmed(patch.phone).length > MAX_PHONE_LENGTH) {
    return {
      ok: false,
      message: `Phone must be ${MAX_PHONE_LENGTH} characters or fewer.`,
    };
  }
  if (trimmed(patch.zip).length > MAX_ZIP_LENGTH) {
    return {
      ok: false,
      message: `ZIP must be ${MAX_ZIP_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true };
}

/**
 * Build the MailingAddressInput for the save.
 *
 * Two different rules, because omitting a key and sending "" mean different
 * things (see the measured behaviour at the top of this file):
 *
 *   · Carry-forward fields — omitted when blank. They are never being cleared,
 *     and `countryCode` is an enum where "" is invalid. `zip` is one of these
 *     unless the patch carries a replacement from the address search: it can't
 *     be cleared (Shopify rejects an empty PH postal code and fails the whole
 *     mutation), so a blank patch zip means "keep the stored one".
 *   · Clearable editable fields (address2, phone) — ALWAYS sent, even empty,
 *     because "" is the only thing that actually clears them. Omitting a
 *     blank one is a silent no-op that still reports success.
 *   · `address1` / `city` — required, guaranteed non-empty by validation.
 */
export function buildNextShippingAddress(
  current: OrderShippingAddressSnapshot | null,
  patch: OrderContactPatch,
): Record<string, string> {
  const next: Record<string, string> = {};
  /** Send only when there is a value. */
  const putIfPresent = (key: string, value: string | null | undefined): void => {
    const v = trimmed(value);
    if (v) next[key] = v;
  };
  /** Always send — "" is a meaningful instruction to clear. */
  const putAlways = (key: string, value: string | null | undefined): void => {
    next[key] = trimmed(value);
  };

  // Not editable here — re-sent as insurance against the documented
  // (but not actual) overwrite behaviour.
  putIfPresent("firstName", current?.firstName);
  putIfPresent("lastName", current?.lastName);
  putIfPresent("company", current?.company);
  putIfPresent("provinceCode", current?.provinceCode);
  // Read side is countryCodeV2, write side is countryCode.
  putIfPresent("countryCode", current?.countryCodeV2);
  // The address search may supply a new ZIP; without one the stored ZIP is
  // carried forward. Either way a blank zip is never sent.
  putIfPresent("zip", trimmed(patch.zip) || current?.zip);

  // Editable.
  putIfPresent("address1", patch.address1);
  putAlways("address2", patch.address2);
  putIfPresent("city", patch.city);
  putAlways("phone", patch.phone);

  return next;
}

/** True when the address the merchant submitted differs from what is stored. */
export function hasContactChanges(
  current: OrderShippingAddressSnapshot | null,
  patch: OrderContactPatch,
): boolean {
  const patchZip = trimmed(patch.zip);
  return (
    trimmed(current?.address1) !== trimmed(patch.address1) ||
    trimmed(current?.address2) !== trimmed(patch.address2) ||
    trimmed(current?.city) !== trimmed(patch.city) ||
    trimmed(current?.phone) !== trimmed(patch.phone) ||
    // An absent/blank patch zip is "keep the stored one" — never a change.
    (patchZip !== "" && patchZip !== trimmed(current?.zip))
  );
}

// Upstream failures answer 200 + ok:false (ADR-11) — Cloudflare replaces an
// origin 5xx body with its own HTML and breaks the embedded fetcher.
// Validation stays 4xx; Cloudflare passes those through untouched.
function opJson(payload: EditDetailsResponse, status = 200): Response {
  return Response.json(payload, status === 200 ? undefined : { status });
}

const ADD_ORDER_TAGS_MUTATION = `#graphql
  mutation AddOrderContactTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

export async function handleEditDetailsOp(
  admin: AdminGraphQLClient,
  fd: FormData,
  shopTimezone?: string,
): Promise<Response> {
  const orderId = String(fd.get("orderId") || "");
  if (!SHOPIFY_ORDER_GID_RE.test(orderId)) {
    return opJson({ ok: false, message: "Invalid order ID." }, 400);
  }

  const patch: OrderContactPatch = {
    address1: String(fd.get("address1") || ""),
    address2: String(fd.get("address2") || ""),
    city: String(fd.get("city") || ""),
    phone: String(fd.get("phone") || ""),
  };
  // A blank/whitespace zip is treated as absent — it must never reach the
  // mutation as "" (that fails the whole save for PH addresses).
  const zipRaw = String(fd.get("zip") || "").trim();
  if (zipRaw) patch.zip = zipRaw;

  const check = validateOrderContactPatch(patch);
  if (!check.ok) {
    return opJson({ ok: false, message: check.message ?? "Invalid input." }, 400);
  }

  // The stored address is re-read server-side and never taken from the client:
  // the carry-forward fields (recipient name, company, province, country) must
  // come from Shopify, not from whatever a form could be made to submit.
  let current: OrderShippingAddressSnapshot | null = null;
  try {
    const res = await admin.graphql(ORDER_SHIPPING_ADDRESS_QUERY, {
      variables: { id: orderId },
    });
    const j = (await res.json()) as {
      data?: {
        order?: {
          shippingAddress?: OrderShippingAddressSnapshot | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (j.errors?.length) {
      return opJson({
        ok: false,
        message: `Couldn't read the order: ${j.errors.map((e) => e.message).join("; ")}`,
      });
    }
    if (!j.data?.order) {
      return opJson({ ok: false, message: "Order not found." }, 404);
    }
    current = j.data.order.shippingAddress ?? null;
  } catch (e: unknown) {
    return opJson({
      ok: false,
      message: e instanceof Error ? e.message : "Couldn't read the order.",
    });
  }

  if (!hasContactChanges(current, patch)) {
    return opJson({ ok: true, message: "No changes to save." });
  }

  const shippingAddress = buildNextShippingAddress(current, patch);

  try {
    const res = await admin.graphql(UPDATE_ORDER_SHIPPING_ADDRESS_MUTATION, {
      variables: { input: { id: orderId, shippingAddress } },
    });
    const j = (await res.json()) as {
      data?: {
        orderUpdate?: {
          userErrors?: Array<{ field?: string[] | null; message: string }>;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    const errors = [
      ...(j.errors?.map((e) => e.message) ?? []),
      ...(j.data?.orderUpdate?.userErrors?.map((e) => e.message) ?? []),
    ];
    if (errors.length > 0) {
      return opJson({ ok: false, message: errors.join("; ") });
    }
  } catch (e: unknown) {
    return opJson({
      ok: false,
      message:
        e instanceof Error ? e.message : "Couldn't update the delivery details.",
    });
  }

  // Timeline event tag. A tagging failure must never fail a save that already
  // rewrote the address — the same posture as the reschedule service's mirror
  // steps, which log and carry on.
  const eventTag = buildOrderEventTag(
    "addressEdited",
    getShopLocalDate(shopTimezone),
  );
  if (eventTag) {
    try {
      const res = await admin.graphql(ADD_ORDER_TAGS_MUTATION, {
        variables: { id: orderId, tags: [eventTag] },
      });
      const j = (await res.json()) as {
        data?: {
          tagsAdd?: { userErrors?: Array<{ message: string }> } | null;
        };
        errors?: Array<{ message: string }>;
      };
      const tagErrors = [
        ...(j.errors?.map((e) => e.message) ?? []),
        ...(j.data?.tagsAdd?.userErrors?.map((e) => e.message) ?? []),
      ];
      if (tagErrors.length > 0) {
        console.warn("[handleEditDetailsOp] event tag write errors:", tagErrors);
      }
    } catch (error) {
      console.warn("[handleEditDetailsOp] event tag write threw:", error);
    }
  }

  return opJson({ ok: true, message: "Delivery details updated." });
}
