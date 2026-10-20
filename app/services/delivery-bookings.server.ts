// Booked-counts engine V2 (Scheduler V2 §5, ADR-12 — docs/scheduler-v2-ux.md).
//
// Counts are derived from ONE Admin GraphQL orders search filtered by
// `metafields.custom.date:<date>` over the future capacity-tracked dates —
// cost scales with actual bookings on tracked days, not store order volume.
// Matching is METAFIELDS ONLY (custom.date + custom.time_slot) through the
// canonical slot comparator; the old created_at-lookback scan and its
// tag/attribute booking heuristics are gone (audit PERF-1/RACE-03, DEF-13,
// DEF-15). The raw matched bookings are memoized in-process per shop for a
// short TTL (never persisted), which also makes exclude-self-on-reschedule
// free (audit DEF-14).

import type { DeliveryScheduleRules } from "../lib/delivery-availability";
import { normalizeSlotValueForMatch } from "../lib/slot-value";

interface AdminGraphQLResponseError {
  message: string;
}

interface DeliveryMetafield {
  value?: string | null;
}

interface DeliveryOrderNode {
  id: string;
  cancelledAt: string | null;
  deliveryDateMetafield?: DeliveryMetafield | null;
  timeSlotMetafield?: DeliveryMetafield | null;
}

interface DeliveryOrdersQueryResponse {
  data?: {
    orders?: {
      edges: Array<{ node: DeliveryOrderNode }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
  // Usually an array of {message}, but Shopify auth failures put a plain
  // string here.
  errors?: AdminGraphQLResponseError[] | string;
}

export interface AdminGraphQLClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** One live order occupying a capacity-tracked date+slot bucket. */
export interface DeliveryBooking {
  orderId: string;
  /** The tracked date (slotCapacity key) this booking counts against. */
  date: string;
  /** The slotCapacity key (configured slot value) this booking counts against. */
  slotValue: string;
}

/**
 * Which truncation cap clipped a scan, and the tracked dates it clipped. Both
 * caps make the derived counts a LOWER BOUND, never the truth — design §5 says
 * counts may fail open, but never silently, so this travels up to the caller
 * instead of dying in a console.warn.
 */
export interface DeliveryBookingsTruncation {
  /** Tracked dates dropped past MAX_TRACKED_DATES — never queried, so they count 0. */
  droppedDates: string[];
  /** Tracked dates in a chunk that hit MAX_PAGES_PER_CHUNK — counts may be low. */
  pagedOutDates: string[];
}

export interface DeliveryBookingsSnapshot {
  bookings: DeliveryBooking[];
  /** ISO timestamp of when this snapshot was fetched from the Admin API. */
  fetchedAt: string;
  fromCache: boolean;
  /** Null when the whole tracked set was scanned; set when a cap clipped it. */
  truncation: DeliveryBookingsTruncation | null;
}

const FETCH_DELIVERY_BOOKINGS_QUERY = `#graphql
  query FetchDeliveryBookings($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          cancelledAt
          deliveryDateMetafield: metafield(namespace: "custom", key: "date") {
            value
          }
          timeSlotMetafield: metafield(namespace: "custom", key: "time_slot") {
            value
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ORDER_PAGE_SIZE = 250;
// Per date-chunk, not per store history: a chunk covers ≤ DATE_CHUNK_SIZE tracked
// days, so 5×250 orders is far beyond any realistic booking volume for them.
const MAX_PAGES_PER_CHUNK = 5;
// Keep each search-query string well under Shopify's limits.
const DATE_CHUNK_SIZE = 30;
// Matches the design's maxDays ≤ 120 horizon; write-side pruning keeps the real
// count far below this.
const MAX_TRACKED_DATES = 120;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  signature: string;
  fetchedAtMs: number;
  fetchedAt: string;
  bookings: DeliveryBooking[];
  /** Cached alongside the bookings so a partial set never re-reads as complete. */
  pagedOutDates: string[];
}

const bookingsCache = new Map<string, CacheEntry>();

export function invalidateDeliveryBookingsCache(shop?: string): void {
  if (shop) {
    bookingsCache.delete(shop);
  } else {
    bookingsCache.clear();
  }
}

function getTodayString(timezone: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

interface TrackedDates {
  /** The dates actually queried. */
  dates: string[];
  /** The dates cut past MAX_TRACKED_DATES — reported, not just logged. */
  dropped: string[];
}

/**
 * The future (today-inclusive, shop-local) dates that have configured capacity —
 * the only dates worth querying. Sorted ascending; truncation is logged AND
 * returned, never silent.
 */
function getTrackedDates(rules: DeliveryScheduleRules): TrackedDates {
  const today = getTodayString(rules.timezone);
  const dates = Object.keys(rules.slotCapacity)
    .filter((date) => date >= today)
    .sort();

  if (dates.length > MAX_TRACKED_DATES) {
    console.warn(
      `Delivery booked counts: ${dates.length} capacity-tracked dates configured; only the first ${MAX_TRACKED_DATES} are counted.`,
    );
    return {
      dates: dates.slice(0, MAX_TRACKED_DATES),
      dropped: dates.slice(MAX_TRACKED_DATES),
    };
  }

  return { dates, dropped: [] };
}

/** Null unless a cap actually clipped the scan — keeps "complete" the default. */
function buildTruncation(
  droppedDates: string[],
  pagedOutDates: string[],
): DeliveryBookingsTruncation | null {
  if (!droppedDates.length && !pagedOutDates.length) {
    return null;
  }
  return { droppedDates, pagedOutDates };
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function extractGraphQLErrorMessage(
  errors: AdminGraphQLResponseError[] | string | undefined,
  fallback: string,
) {
  // Shopify auth failures return `errors` as a plain STRING, not the usual
  // array of {message} objects — mapping over it used to TypeError (caught by
  // the fail-open path, but masking the real cause).
  if (typeof errors === "string") {
    return errors.trim() || fallback;
  }

  if (!Array.isArray(errors) || !errors.length) {
    return fallback;
  }

  return errors
    .map((error) =>
      typeof error?.message === "string" ? error.message : String(error),
    )
    .join(", ");
}

/**
 * Map every tracked date to its capacity keys, indexed by the CANONICAL slot
 * form — so an order's `custom.time_slot` value resolves to the exact
 * slotCapacity key even when stored config predates the strict write gate
 * (case/spacing drift).
 */
function buildCapacityKeyIndex(
  rules: DeliveryScheduleRules,
  trackedDates: string[],
): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>();
  for (const date of trackedDates) {
    const keysByCanonical = new Map<string, string>();
    for (const capacityKey of Object.keys(rules.slotCapacity[date] ?? {})) {
      const canonical = normalizeSlotValueForMatch(capacityKey);
      if (canonical) {
        keysByCanonical.set(canonical, capacityKey);
      }
    }
    index.set(date, keysByCanonical);
  }
  return index;
}

async function fetchBookingsForDates(
  admin: AdminGraphQLClient,
  rules: DeliveryScheduleRules,
  trackedDates: string[],
): Promise<{ bookings: DeliveryBooking[]; pagedOutDates: string[] }> {
  const capacityKeyIndex = buildCapacityKeyIndex(rules, trackedDates);
  const bookings: DeliveryBooking[] = [];
  const pagedOutDates: string[] = [];

  for (const dateChunk of chunk(trackedDates, DATE_CHUNK_SIZE)) {
    const query = dateChunk
      .map((date) => `metafields.custom.date:${date}`)
      .join(" OR ");

    let cursor: string | null = null;
    let truncated = true;

    for (let page = 0; page < MAX_PAGES_PER_CHUNK; page += 1) {
      const response = await admin.graphql(FETCH_DELIVERY_BOOKINGS_QUERY, {
        variables: {
          first: ORDER_PAGE_SIZE,
          after: cursor,
          query,
        },
      });

      const responseJson = (await response.json()) as DeliveryOrdersQueryResponse;
      if (!response.ok || responseJson.errors?.length) {
        throw new Error(
          extractGraphQLErrorMessage(
            responseJson.errors,
            "Failed to load delivery bookings.",
          ),
        );
      }

      const orders = responseJson.data?.orders;
      if (!orders) {
        truncated = false;
        break;
      }

      for (const edge of orders.edges) {
        const order = edge.node;
        if (order.cancelledAt) {
          continue;
        }

        const date = order.deliveryDateMetafield?.value?.trim() ?? "";
        const keysByCanonical = capacityKeyIndex.get(date);
        if (!keysByCanonical) {
          continue;
        }

        const canonicalSlot = normalizeSlotValueForMatch(
          order.timeSlotMetafield?.value,
        );
        const capacityKey = canonicalSlot
          ? keysByCanonical.get(canonicalSlot)
          : undefined;
        if (!capacityKey) {
          continue;
        }

        bookings.push({ orderId: order.id, date, slotValue: capacityKey });
      }

      if (!orders.pageInfo.hasNextPage || !orders.pageInfo.endCursor) {
        truncated = false;
        break;
      }

      cursor = orders.pageInfo.endCursor;
    }

    if (truncated) {
      // No silent caps (design §5): counts may miss bookings past the page cap,
      // so the whole chunk's dates ride back to the caller as suspect — the log
      // alone never reached the merchant.
      console.warn(
        `Delivery booked counts: pagination cap hit for dates ${dateChunk[0]}..${dateChunk[dateChunk.length - 1]}; counts may be incomplete.`,
      );
      pagedOutDates.push(...dateChunk);
    }
  }

  return { bookings, pagedOutDates };
}

/**
 * The raw matched bookings for a shop's tracked dates, memoized in-process for
 * CACHE_TTL_MS. The cache stores bookings (not counts) so exclusions and count
 * derivation happen per read. Cache entries are keyed by shop and invalidated
 * on rules saves and when the tracked-date set changes.
 */
export async function getDeliveryBookingsSnapshot(
  shop: string,
  admin: AdminGraphQLClient,
  rules: DeliveryScheduleRules,
  options: { bypassCache?: boolean } = {},
): Promise<DeliveryBookingsSnapshot> {
  // The dropped dates come from the rules, not the scan, so they are recomputed
  // on every read — a cache hit can never hide a date-cap that tripped since.
  const { dates: trackedDates, dropped: droppedDates } = getTrackedDates(rules);
  if (!trackedDates.length) {
    return {
      bookings: [],
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      truncation: buildTruncation(droppedDates, []),
    };
  }

  const signature = trackedDates.join("|");
  const cached = bookingsCache.get(shop);
  const nowMs = Date.now();

  if (
    !options.bypassCache &&
    cached &&
    cached.signature === signature &&
    nowMs - cached.fetchedAtMs < CACHE_TTL_MS
  ) {
    return {
      bookings: cached.bookings,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
      truncation: buildTruncation(droppedDates, cached.pagedOutDates),
    };
  }

  const { bookings, pagedOutDates } = await fetchBookingsForDates(
    admin,
    rules,
    trackedDates,
  );
  const fetchedAt = new Date(nowMs).toISOString();
  bookingsCache.set(shop, {
    signature,
    fetchedAtMs: nowMs,
    fetchedAt,
    bookings,
    pagedOutDates,
  });

  return {
    bookings,
    fetchedAt,
    fromCache: false,
    truncation: buildTruncation(droppedDates, pagedOutDates),
  };
}

function orderIdKey(orderId: string): string {
  // Compare by the trailing numeric id so "gid://shopify/Order/123" and "123"
  // name the same order regardless of which form the caller holds.
  const match = orderId.trim().match(/(\d+)$/);
  return match ? match[1] : orderId.trim();
}

/**
 * Derive per-date/per-slot booked counts (keyed exactly like `slotCapacity`)
 * from a bookings snapshot. `excludeOrderId` removes the order being
 * rescheduled so it does not block itself out of its own slot (DEF-14).
 */
export function deriveBookedCounts(
  bookings: DeliveryBooking[],
  excludeOrderId?: string,
): Record<string, Record<string, number>> {
  const excludedKey = excludeOrderId ? orderIdKey(excludeOrderId) : null;
  const counts: Record<string, Record<string, number>> = {};

  for (const booking of bookings) {
    if (excludedKey && orderIdKey(booking.orderId) === excludedKey) {
      continue;
    }

    counts[booking.date] ??= {};
    counts[booking.date][booking.slotValue] =
      (counts[booking.date][booking.slotValue] ?? 0) + 1;
  }

  return counts;
}
