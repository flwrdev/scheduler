// Reads and writes the delivery data on a Shopify order: pulls Delivery Date and Delivery Time
// out of the webhook payload, builds the metafields (custom, delivery and sidekick namespaces),
// replaces the schedule tags, and works out delivery.sync_status for a choice made at checkout.
// All writes go through the Admin GraphQL API.

import {
  buildDeliveryTags,
  isDeliveryScheduleTag,
  isSlotAtCapacity,
  isSlotBlocked,
  validateDeliverySelection,
  type DeliveryScheduleRules,
} from "../lib/delivery-availability";
import { resolveConfiguredSlotValue } from "../lib/slot-value";

export interface AdminGraphQLClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

interface OrderAttributeInput {
  key?: unknown;
  name?: unknown;
  value?: unknown;
}

export interface OrderCustomAttribute {
  key: string;
  value: string;
}

interface DeliveryAttributeValues {
  deliveryDate: string | null;
  timeSlot: string | null;
}

interface SyncOrderDeliveryMetafieldsOptions extends DeliveryAttributeValues {
  orderId: string;
  /**
   * Scheduler V2 D4: outcome of checkout-time validation, recorded on the new
   * additive `delivery.sync_status` metafield ("ok" | "attention:<code>").
   * Omitted on paths that don't evaluate it (e.g. reschedules) — the
   * metafield is then left untouched.
   */
  syncStatus?: string;
}

interface MetafieldsSetResponse {
  data?: {
    metafieldsSet?: {
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface OrderTagsQueryResponse {
  data?: {
    order?: {
      tags?: string[] | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface TagsMutationResponse {
  data?: {
    tagsAdd?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
    tagsRemove?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export interface SyncOrderDeliveryMetafieldsResult {
  ok: boolean;
  skipped: boolean;
  metafieldCount: number;
  errors: string[];
}

interface SyncOrderDeliveryScheduleTagOptions extends DeliveryAttributeValues {
  orderId: string;
  currentTags?: string[] | null;
  additionalTags?: string[] | null;
}

export interface SyncOrderDeliveryScheduleTagResult {
  ok: boolean;
  skipped: boolean;
  scheduleTags: string[];
  removedTags: string[];
  errors: string[];
}

const DELIVERY_DATE_ATTRIBUTE_KEY = "Delivery Date";
const DELIVERY_TIME_ATTRIBUTE_KEY = "Delivery Time";
export const DELIVERY_SCHEDULE_TAG_PATTERN =
  /^(Delivery Date:\s*\d{4}-\d{2}-\d{2}|Delivery Time:\s*.+|Delivery:\s*\d{4}-\d{2}-\d{2}\s*\[.+\]|\d{4}-\d{2}-\d{2}\s*\|\s*.+|\d{4}-\d{2}-\d{2}|\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*-\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM))$/i;

function isExistingDeliveryScheduleTag(tag: string): boolean {
  return isDeliveryScheduleTag(tag);
}

const SET_ORDER_DELIVERY_METAFIELDS_MUTATION = `#graphql
  mutation SetOrderDeliveryMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

const FETCH_ORDER_TAGS_QUERY = `#graphql
  query FetchOrderTags($id: ID!) {
    order(id: $id) {
      tags
    }
  }
`;

const REMOVE_ORDER_DELIVERY_TAGS_MUTATION = `#graphql
  mutation RemoveOrderDeliveryTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ADD_ORDER_DELIVERY_TAGS_MUTATION = `#graphql
  mutation AddOrderDeliveryTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOrderAttributes(
  payload: Record<string, unknown>,
): Array<{ key: string; value: string }> {
  const candidates = [
    payload.customAttributes,
    payload.custom_attributes,
    payload.noteAttributes,
    payload.note_attributes,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;

    return candidate
      .map((attribute: OrderAttributeInput) => ({
        key: stringValue(attribute.key ?? attribute.name),
        value: stringValue(attribute.value),
      }))
      .filter((attribute) => attribute.key && attribute.value);
  }

  return [];
}

function findAttributeValue(
  attributes: Array<{ key: string; value: string }>,
  key: string,
): string | null {
  return attributes.find((attribute) => attribute.key === key)?.value ?? null;
}

function isValidDateValue(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function buildOrderDeliveryScheduleTags(
  values: DeliveryAttributeValues,
): string[] {
  return buildDeliveryTags(values.deliveryDate, values.timeSlot);
}

export function buildOrderDeliveryScheduleTag(
  values: DeliveryAttributeValues,
): string[] {
  return buildOrderDeliveryScheduleTags(values);
}

export function extractExistingDeliveryScheduleTags(
  currentTags: string[] | null | undefined,
): string[] {
  const scheduleTags: string[] = [];
  const seenTags = new Set<string>();

  for (const rawTag of currentTags ?? []) {
    const tag = stringValue(rawTag);
    if (!tag || !isExistingDeliveryScheduleTag(tag)) {
      continue;
    }

    if (seenTags.has(tag)) {
      continue;
    }

    seenTags.add(tag);
    scheduleTags.push(tag);
  }

  return scheduleTags;
}

function extractTagMutationErrors(result: TagsMutationResponse): string[] {
  const graphQLErrors = result.errors?.map((error) => error.message) ?? [];
  const removeErrors =
    result.data?.tagsRemove?.userErrors?.map((error) => error.message) ?? [];
  const addErrors =
    result.data?.tagsAdd?.userErrors?.map((error) => error.message) ?? [];

  return [...graphQLErrors, ...removeErrors, ...addErrors];
}

export function getOrderGidFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const adminGraphqlId = stringValue(
    payload.admin_graphql_api_id ?? payload.adminGraphqlApiId,
  );
  if (adminGraphqlId) return adminGraphqlId;

  const rawId =
    typeof payload.id === "number" || typeof payload.id === "string"
      ? String(payload.id)
      : "";
  return rawId ? `gid://shopify/Order/${rawId}` : null;
}

export function extractDeliveryAttributesFromPayload(
  payload: Record<string, unknown>,
): DeliveryAttributeValues {
  const attributes = normalizeOrderAttributes(payload);

  return {
    deliveryDate: findAttributeValue(attributes, DELIVERY_DATE_ATTRIBUTE_KEY),
    timeSlot: findAttributeValue(attributes, DELIVERY_TIME_ATTRIBUTE_KEY),
  };
}

export function buildNextDeliveryCustomAttributes(
  currentAttributes: OrderCustomAttribute[] | null | undefined,
  deliveryDate: string,
  timeSlot: string,
): OrderCustomAttribute[] {
  const nextAttributes: OrderCustomAttribute[] = [];
  let hasDeliveryDate = false;
  let hasDeliveryTime = false;

  for (const attribute of currentAttributes ?? []) {
    const key = stringValue(attribute.key);
    if (!key) {
      continue;
    }

    if (key === DELIVERY_DATE_ATTRIBUTE_KEY) {
      nextAttributes.push({ key, value: deliveryDate });
      hasDeliveryDate = true;
      continue;
    }

    if (key === DELIVERY_TIME_ATTRIBUTE_KEY) {
      nextAttributes.push({ key, value: timeSlot });
      hasDeliveryTime = true;
      continue;
    }

    nextAttributes.push({ key, value: attribute.value });
  }

  if (!hasDeliveryDate) {
    nextAttributes.push({
      key: DELIVERY_DATE_ATTRIBUTE_KEY,
      value: deliveryDate,
    });
  }

  if (!hasDeliveryTime) {
    nextAttributes.push({ key: DELIVERY_TIME_ATTRIBUTE_KEY, value: timeSlot });
  }

  return nextAttributes;
}

export function buildOrderDeliveryMetafields(
  options: SyncOrderDeliveryMetafieldsOptions,
) {
  if (!isValidDateValue(options.deliveryDate)) return [];

  const metafields = [
    {
      ownerId: options.orderId,
      namespace: "custom",
      key: "date",
      value: options.deliveryDate,
      type: "date",
    },
    {
      ownerId: options.orderId,
      namespace: "delivery",
      key: "date",
      value: options.deliveryDate,
      type: "date",
    },
    {
      ownerId: options.orderId,
      namespace: "sidekick",
      key: "delivery_date",
      value: options.deliveryDate,
      type: "single_line_text_field",
    },
  ];

  if (options.timeSlot) {
    metafields.push(
      {
        ownerId: options.orderId,
        namespace: "custom",
        key: "time_slot",
        value: options.timeSlot,
        type: "single_line_text_field",
      },
      {
        ownerId: options.orderId,
        namespace: "delivery",
        key: "time_slot",
        value: options.timeSlot,
        type: "single_line_text_field",
      },
    );
  }

  if (options.syncStatus) {
    metafields.push({
      ownerId: options.orderId,
      namespace: "delivery",
      key: "sync_status",
      value: options.syncStatus,
      type: "single_line_text_field",
    });
  }

  return metafields;
}

/**
 * Checkout-time semantics (Scheduler V2 D4 — audit DEF-7): validation runs
 * against the moment the customer paid, not webhook processing time, so a
 * retried/delayed webhook can never invalidate an order that was legal at
 * checkout. Falls back to processing time when the payload carries no
 * parseable `created_at`.
 */
export function resolveOrderCheckoutTime(
  payload: Record<string, unknown>,
  fallback = new Date(),
): Date {
  const raw = payload.created_at ?? payload.createdAt;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

/**
 * Map a checkout-time validation outcome onto the `delivery.sync_status`
 * wire value (D4): "ok" when the selection was legal at checkout, otherwise
 * "attention:<code>". A slot that fails ONLY because it is at capacity is
 * reported as "attention:capacity" — capacity is advisory here, never
 * enforced (audit DEF-3 accepted; §6.4).
 */
export function evaluateDeliverySyncStatus(
  rules: DeliveryScheduleRules,
  deliveryDate: string,
  timeSlot: string,
  checkoutTime: Date,
): string {
  const validation = validateDeliverySelection(
    rules,
    deliveryDate,
    timeSlot,
    checkoutTime,
  );
  if (validation.ok) {
    return "ok";
  }

  if (
    validation.code === "slot_unavailable" ||
    validation.code === "no_slots_available"
  ) {
    const slotValue = resolveConfiguredSlotValue(rules, timeSlot);
    if (
      slotValue != null &&
      !isSlotBlocked(rules, deliveryDate, slotValue) &&
      isSlotAtCapacity(rules, deliveryDate, slotValue)
    ) {
      return "attention:capacity";
    }
  }

  return `attention:${validation.code}`;
}

export async function syncOrderDeliveryMetafields(
  admin: AdminGraphQLClient,
  options: SyncOrderDeliveryMetafieldsOptions,
): Promise<SyncOrderDeliveryMetafieldsResult> {
  const metafields = buildOrderDeliveryMetafields(options);
  if (metafields.length === 0) {
    return { ok: true, skipped: true, metafieldCount: 0, errors: [] };
  }

  const response = await admin.graphql(SET_ORDER_DELIVERY_METAFIELDS_MUTATION, {
    variables: { metafields },
  });
  const result = (await response.json()) as MetafieldsSetResponse;
  const graphQLErrors = result.errors?.map((error) => error.message) ?? [];
  const userErrors =
    result.data?.metafieldsSet?.userErrors?.map((error) => error.message) ?? [];
  const errors = [...graphQLErrors, ...userErrors];

  return {
    ok: response.ok && errors.length === 0,
    skipped: false,
    metafieldCount: metafields.length,
    errors,
  };
}

export async function syncOrderDeliveryScheduleTag(
  admin: AdminGraphQLClient,
  options: SyncOrderDeliveryScheduleTagOptions,
): Promise<SyncOrderDeliveryScheduleTagResult> {
  const scheduleTags = buildOrderDeliveryScheduleTags(options);
  const additionalTags = Array.from(
    new Set((options.additionalTags ?? []).map(stringValue).filter(Boolean)),
  );
  const tagsToAdd = Array.from(new Set([...scheduleTags, ...additionalTags]));

  if (tagsToAdd.length === 0) {
    return {
      ok: true,
      skipped: true,
      scheduleTags: [],
      removedTags: [],
      errors: [],
    };
  }

  let currentTags = options.currentTags;
  if (currentTags === undefined) {
    const orderTagsResponse = await admin.graphql(FETCH_ORDER_TAGS_QUERY, {
      variables: { id: options.orderId },
    });
    const orderTagsResult =
      (await orderTagsResponse.json()) as OrderTagsQueryResponse;
    const queryErrors =
      orderTagsResult.errors?.map((error) => error.message) ?? [];

    if (!orderTagsResponse.ok || queryErrors.length > 0) {
      return {
        ok: false,
        skipped: false,
        scheduleTags,
        removedTags: [],
        errors:
          queryErrors.length > 0
            ? queryErrors
            : ["Failed to load current order tags."],
      };
    }

    currentTags = orderTagsResult.data?.order?.tags ?? [];
  }

  const existingScheduleTags = extractExistingDeliveryScheduleTags(currentTags);
  const removedTags = existingScheduleTags;

  if (removedTags.length > 0) {
    const removeTagsResponse = await admin.graphql(
      REMOVE_ORDER_DELIVERY_TAGS_MUTATION,
      {
        variables: {
          id: options.orderId,
          tags: removedTags,
        },
      },
    );
    const removeTagsResult =
      (await removeTagsResponse.json()) as TagsMutationResponse;
    const removeErrors = extractTagMutationErrors(removeTagsResult);

    if (!removeTagsResponse.ok || removeErrors.length > 0) {
      return {
        ok: false,
        skipped: false,
        scheduleTags,
        removedTags,
        errors:
          removeErrors.length > 0
            ? removeErrors
            : ["Failed to remove prior delivery schedule tags."],
      };
    }
  }

  if (tagsToAdd.length > 0) {
    const addTagsResponse = await admin.graphql(
      ADD_ORDER_DELIVERY_TAGS_MUTATION,
      {
        variables: {
          id: options.orderId,
          tags: tagsToAdd,
        },
      },
    );
    const addTagsResult =
      (await addTagsResponse.json()) as TagsMutationResponse;
    const addErrors = extractTagMutationErrors(addTagsResult);

    if (!addTagsResponse.ok || addErrors.length > 0) {
      return {
        ok: false,
        skipped: false,
        scheduleTags,
        removedTags,
        errors:
          addErrors.length > 0
            ? addErrors
            : ["Failed to add delivery schedule tag."],
      };
    }
  }

  return {
    ok: true,
    skipped: false,
    scheduleTags,
    removedTags,
    errors: [],
  };
}
