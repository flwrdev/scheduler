// The scheduling rules engine, used by the server and by the extensions.
// Defines DeliveryScheduleRules (timezone, cutoff hour, preparation hours, booking window,
// slots, blocked dates and slots, capacity) and answers the questions built on them: which
// dates and slots are bookable, whether a chosen date and slot is valid, when the cutoff
// passes, whether a slot is blocked or full, and which order tags a choice produces.
// Everything here is pure: it takes the rules and a clock and returns an answer.

import { findSlotOverrideKey, resolveConfiguredSlotValue } from "./slot-value";

export interface DeliveryScheduleSlot {
  display: string;
  value: string;
}

export interface DeliveryScheduleCapacity {
  capacity: number;
  booked: number;
}

export interface DeliveryScheduleRules {
  timezone: string;
  cutoffHour: number;
  prepHours: number;
  maxDays: number;
  slots: DeliveryScheduleSlot[];
  disabledDates: string[];
  disabledSlots: Record<string, string[]>;
  slotCapacity: Record<string, Record<string, DeliveryScheduleCapacity>>;
}

const LEGACY_DELIVERY_TAG_PATTERN = /^\d{4}-\d{2}-\d{2}\s*\|\s*.+$/;
const DELIVERY_TIME_SLOT_TAG_PATTERN =
  /^\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*-\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM)$/i;

// Provide one safe fallback contract so both server routes and extensions can keep
// validating delivery choices even if a shop-specific rules record is unavailable.
export const DEFAULT_DELIVERY_SCHEDULE_RULES: DeliveryScheduleRules = {
  timezone: "Asia/Manila",
  cutoffHour: 17,
  prepHours: 1,
  maxDays: 25,
  slots: [
    { display: "9AM-12PM", value: "9AM-12PM" },
    { display: "12PM-3PM", value: "12PM-3PM" },
    { display: "3PM-6PM", value: "3PM-6PM" },
    { display: "6PM-11PM", value: "6PM-11PM" },
  ],
  disabledDates: [],
  disabledSlots: {},
  slotCapacity: {},
};

export function cloneDeliveryScheduleRules(
  rules: DeliveryScheduleRules,
): DeliveryScheduleRules {
  return {
    ...rules,
    slots: rules.slots.map((slot) => ({ ...slot })),
    disabledDates: [...rules.disabledDates],
    disabledSlots: Object.fromEntries(
      Object.entries(rules.disabledSlots).map(([date, slots]) => [
        date,
        [...slots],
      ]),
    ),
    slotCapacity: Object.fromEntries(
      Object.entries(rules.slotCapacity).map(([date, capacities]) => [
        date,
        Object.fromEntries(
          Object.entries(capacities).map(([slot, values]) => [
            slot,
            { ...values },
          ]),
        ),
      ]),
    ),
  };
}

export type DeliverySelectionValidationCode =
  | "invalid_date"
  | "date_before_min"
  | "date_after_max"
  | "date_blocked"
  | "slot_unknown"
  | "slot_unavailable"
  | "no_slots_available";

export type DeliveryDateValidationResult =
  | {
      ok: true;
      minDate: string;
      maxDate: string;
      availableSlots: DeliveryScheduleSlot[];
      message: string;
    }
  | {
      ok: false;
      code:
        | "invalid_date"
        | "date_before_min"
        | "date_after_max"
        | "date_blocked"
        | "no_slots_available";
      message: string;
      minDate: string;
      maxDate: string;
      availableSlots: DeliveryScheduleSlot[];
    };

export type DeliverySelectionValidationResult =
  | {
      ok: true;
      minDate: string;
      maxDate: string;
      availableSlots: DeliveryScheduleSlot[];
    }
  | {
      ok: false;
      code: DeliverySelectionValidationCode;
      message: string;
      minDate: string;
      maxDate: string;
      availableSlots: DeliveryScheduleSlot[];
    };

type ZonedNowParts = {
  date: string;
  minutes: number;
};

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MS_PER_MINUTE = 60_000;

const zonedDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function padNumber(value: number) {
  return String(value).padStart(2, "0");
}

function getFormatter(timezone: string) {
  const cached = zonedDateTimeFormatters.get(timezone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  zonedDateTimeFormatters.set(timezone, formatter);
  return formatter;
}

// Convert "now" into shop-local calendar parts so delivery cutoffs are evaluated in
// the merchant's timezone instead of the server or browser timezone.
function getZonedNowParts(timezone: string, now = new Date()): ZonedNowParts {
  const parts = getFormatter(timezone).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const year = values.year;
  const month = values.month;
  const day = values.day;
  const hour = Number(values.hour);
  const minute = Number(values.minute);

  return {
    date: `${year}-${month}-${day}`,
    minutes: hour * MINUTES_PER_HOUR + minute,
  };
}

/**
 * "Today" as the merchant's calendar sees it, `YYYY-MM-DD`.
 *
 * Exposed for the order event tags (`app/lib/order-tags.ts`), which stamp the
 * shop-local day an event happened. Stamping UTC instead is what made a 4:07 AM
 * Manila reschedule read as the previous day on the admin order page — see the
 * 2026-08-14 verification-log entry. Reuses the same cached zoned formatter the
 * delivery cutoffs run on, so the tag date and the cutoff always agree on which
 * day it is.
 */
export function getShopLocalDate(
  timezone: string = DEFAULT_DELIVERY_SCHEDULE_RULES.timezone,
  now = new Date(),
): string {
  // Never throws. Callers use this to stamp an OPTIONAL event tag onto a write
  // that has already succeeded, so a bad input must cost the tag and nothing
  // else — an earlier version let an unparseable timestamp escape as a
  // RangeError, which took the order's date and slot tags down with it.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return "";
  try {
    return getZonedNowParts(timezone, now).date;
  } catch {
    // An invalid stored timezone falls back to the shop default rather than
    // stamping the server's own zone.
    try {
      return getZonedNowParts(DEFAULT_DELIVERY_SCHEDULE_RULES.timezone, now).date;
    } catch {
      return "";
    }
  }
}

export function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toDateOrdinal(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

export function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day));
  nextDate.setUTCDate(nextDate.getUTCDate() + days);

  return [
    nextDate.getUTCFullYear(),
    padNumber(nextDate.getUTCMonth() + 1),
    padNumber(nextDate.getUTCDate()),
  ].join("-");
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isDeliveryTimeSlotTag(
  value: string | null | undefined,
): boolean {
  return DELIVERY_TIME_SLOT_TAG_PATTERN.test(normalizedString(value));
}

export function isDeliveryScheduleTag(
  value: string | null | undefined,
): boolean {
  const tag = normalizedString(value);
  if (!tag) return false;

  const lowerTag = tag.toLowerCase();
  return (
    lowerTag.startsWith("delivery:") ||
    lowerTag.startsWith("delivery date:") ||
    lowerTag.startsWith("delivery time:") ||
    LEGACY_DELIVERY_TAG_PATTERN.test(tag) ||
    isIsoDateString(tag) ||
    isDeliveryTimeSlotTag(tag)
  );
}

export function getAvailableTimeSlots(
  _date: string | null | undefined,
  rules: DeliveryScheduleRules = DEFAULT_DELIVERY_SCHEDULE_RULES,
): DeliveryScheduleSlot[] {
  return rules.slots.map((slot) => ({ ...slot }));
}

// "Still sellable ⇒ still movable": a booking can be rescheduled online for as
// long as its current delivery date is still bookable under the shop's schedule
// rules (same cutoffHour semantics as storefront date selection). This keeps the
// reschedule gate in parity with the merchant's configured lead time instead of
// a hardcoded lead window.
//
// When the booking's current slot is known, "still sellable" is asked of THAT
// slot too (slot start minus prepHours — the same instant the storefront stops
// selling it). The day-level cutoff alone let order #4292 be moved at 8:47 AM
// on delivery day, 13 minutes before its 9AM-12PM window, after the merchant
// had prepared it (2026-09-04). An unparseable slot keeps the day-level answer
// rather than locking on bad data.
export function canRescheduleDelivery(
  deliveryDate: string,
  currentDate = new Date(),
  rules: DeliveryScheduleRules = DEFAULT_DELIVERY_SCHEDULE_RULES,
  timeSlot?: string | null,
): boolean {
  if (!isIsoDateString(deliveryDate)) {
    return false;
  }

  if (deliveryDate < getMinSelectableDate(rules, currentDate)) {
    return false;
  }

  if (typeof timeSlot === "string" && timeSlot.trim()) {
    const lastOrderAt = getSlotLastOrderInstant(rules, deliveryDate, timeSlot);
    if (lastOrderAt && currentDate.getTime() >= lastOrderAt.getTime()) {
      return false;
    }
  }

  return true;
}

export function buildDeliveryTags(
  deliveryDate: string | null | undefined,
  timeSlot: string | null | undefined,
): string[] {
  const dateValue = normalizedString(deliveryDate);
  const timeSlotValue = normalizedString(timeSlot);

  if (!isIsoDateString(dateValue) || !timeSlotValue) {
    return [];
  }

  return [dateValue, timeSlotValue];
}

export function buildDeliveryTag(
  deliveryDate: string | null | undefined,
  timeSlot: string | null | undefined,
): string[] {
  return buildDeliveryTags(deliveryDate, timeSlot);
}

export function replaceExistingDeliveryTags(
  existingTags: string[] | null | undefined,
  newDeliveryTags: string[] | string | null | undefined,
): string[] {
  const nextTags: string[] = [];
  const seenTags = new Set<string>();
  const deliveryTags = Array.isArray(newDeliveryTags)
    ? newDeliveryTags
    : newDeliveryTags
      ? [newDeliveryTags]
      : [];

  for (const rawTag of existingTags ?? []) {
    const tag = normalizedString(rawTag);
    if (!tag || isDeliveryScheduleTag(tag)) {
      continue;
    }

    if (!seenTags.has(tag)) {
      nextTags.push(tag);
      seenTags.add(tag);
    }
  }

  for (const rawTag of deliveryTags) {
    const tag = normalizedString(rawTag);
    if (tag && !seenTags.has(tag)) {
      nextTags.push(tag);
      seenTags.add(tag);
    }
  }

  return nextTags;
}

export function replaceExistingDeliveryTag(
  existingTags: string[] | null | undefined,
  newDeliveryTags: string[] | string | null | undefined,
): string[] {
  return replaceExistingDeliveryTags(existingTags, newDeliveryTags);
}

function toLocalSerial(dateStr: string, minutes: number): number {
  return toDateOrdinal(dateStr) * MINUTES_PER_DAY + minutes;
}

function parseSlotTime(label: string): number | null {
  const match = label.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) {
    return null;
  }

  const baseHour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3].toUpperCase();

  if (
    !Number.isFinite(baseHour) ||
    !Number.isFinite(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  let hour = baseHour % 12;
  if (meridiem === "PM") {
    hour += 12;
  }

  return hour * MINUTES_PER_HOUR + minute;
}

function getSlotStartSerial(dateStr: string, slotValue: string): number | null {
  const parts = typeof slotValue === "string" ? slotValue.split("-") : [];
  if (parts.length !== 2) {
    return null;
  }

  const startMinutes = parseSlotTime(parts[0]);
  if (startMinutes == null) {
    return null;
  }

  return toLocalSerial(dateStr, startMinutes);
}

function getCutoffMinutes(rules: DeliveryScheduleRules) {
  return Number(rules.cutoffHour) * MINUTES_PER_HOUR;
}

// Zone offset (minutes, local − UTC) in effect at a minute-aligned instant.
function zoneOffsetMinutesAt(timezone: string, instantMs: number): number {
  const parts = getZonedNowParts(timezone, new Date(instantMs));
  return toLocalSerial(parts.date, parts.minutes) - instantMs / MS_PER_MINUTE;
}

/**
 * Inverse of getZonedNowParts: the absolute instant at which `timezone`'s wall
 * clock reads `wallSerial` (minutes since epoch of the LOCAL calendar, the
 * same unit toLocalSerial produces). Treat the wall clock as UTC, correct by
 * the zone's offset at that guess, then re-check once so a DST transition
 * between the guess and the answer still lands on the right side.
 */
function zonedWallClockToInstant(timezone: string, wallSerial: number): Date {
  const guessMs = wallSerial * MS_PER_MINUTE;
  const firstOffset = zoneOffsetMinutesAt(timezone, guessMs);
  let instantMs = (wallSerial - firstOffset) * MS_PER_MINUTE;

  const secondOffset = zoneOffsetMinutesAt(timezone, instantMs);
  if (secondOffset !== firstOffset) {
    instantMs = (wallSerial - secondOffset) * MS_PER_MINUTE;
  }

  return new Date(instantMs);
}

/** The instant `dateStr`'s same-day cutoff (`cutoffHour`, shop-local) passes. */
export function getCutoffInstant(
  rules: DeliveryScheduleRules,
  dateStr: string,
): Date {
  return zonedWallClockToInstant(
    rules.timezone,
    toLocalSerial(dateStr, getCutoffMinutes(rules)),
  );
}

/**
 * The instant after which `slotValue` on `dateStr` can no longer be ordered:
 * slot start minus `prepHours`, shop-local. Null when the slot value's start
 * time is unparseable (isSlotAvailable rejects those slots too).
 */
export function getSlotLastOrderInstant(
  rules: DeliveryScheduleRules,
  dateStr: string,
  slotValue: string,
): Date | null {
  const slotStartSerial = getSlotStartSerial(dateStr, slotValue);
  if (slotStartSerial == null) {
    return null;
  }

  return zonedWallClockToInstant(
    rules.timezone,
    slotStartSerial - Number(rules.prepHours) * MINUTES_PER_HOUR,
  );
}

export function getMinSelectableDate(
  rules: DeliveryScheduleRules,
  now = new Date(),
): string {
  const zonedNow = getZonedNowParts(rules.timezone, now);
  const cutoffMinutes = getCutoffMinutes(rules);

  return zonedNow.minutes >= cutoffMinutes
    ? addDays(zonedNow.date, 1)
    : zonedNow.date;
}

export function getMaxSelectableDate(
  rules: DeliveryScheduleRules,
  minDateStr: string,
): string {
  const span = Math.max(1, Number(rules.maxDays) || 1);
  return addDays(minDateStr, span - 1);
}

export function isDateBlocked(
  rules: DeliveryScheduleRules,
  dateStr: string,
): boolean {
  return (
    Array.isArray(rules.disabledDates) && rules.disabledDates.includes(dateStr)
  );
}

export function isSlotBlocked(
  rules: DeliveryScheduleRules,
  dateStr: string,
  slotValue: string,
): boolean {
  const disabledSlots = rules.disabledSlots?.[dateStr];
  if (!Array.isArray(disabledSlots)) {
    return false;
  }

  // Canonical (not exact) key match — see findSlotOverrideKey. A blocked-slot
  // entry whose spelling drifted from the configured value must still block.
  return findSlotOverrideKey(disabledSlots, slotValue) != null;
}

/**
 * Read the capacity entry a date holds for `slotValue`, tolerating override-key
 * spelling drift the same way the booked-count matcher does.
 */
export function getSlotCapacityEntry(
  rules: DeliveryScheduleRules,
  dateStr: string,
  slotValue: string,
): DeliveryScheduleCapacity | null {
  const capacities = rules.slotCapacity?.[dateStr];
  if (!capacities) {
    return null;
  }

  const key = findSlotOverrideKey(Object.keys(capacities), slotValue);
  return key == null ? null : (capacities[key] ?? null);
}

export function isSlotAtCapacity(
  rules: DeliveryScheduleRules,
  dateStr: string,
  slotValue: string,
): boolean {
  const values = getSlotCapacityEntry(rules, dateStr, slotValue);
  if (!values) {
    return false;
  }

  return Number(values.booked) >= Number(values.capacity);
}

export function isDateSelectable(
  rules: DeliveryScheduleRules,
  dateStr: string,
  now = new Date(),
): boolean {
  if (!isIsoDateString(dateStr)) {
    return false;
  }

  const minDate = getMinSelectableDate(rules, now);
  const maxDate = getMaxSelectableDate(rules, minDate);

  return (
    dateStr >= minDate && dateStr <= maxDate && !isDateBlocked(rules, dateStr)
  );
}

export function isSlotAvailable(
  rules: DeliveryScheduleRules,
  dateStr: string,
  rawSlotValue: string,
  now = new Date(),
): boolean {
  // Keep one shared availability gate so cart, customer account, and server routes
  // all accept and reject the same delivery slot combinations. The raw value is
  // resolved to its CONFIGURED slot value first (case/spacing-tolerant, §4.2) so
  // blocked/capacity lookups — which are keyed by configured values — stay exact.
  if (!dateStr || !rawSlotValue || !isDateSelectable(rules, dateStr, now)) {
    return false;
  }

  const slotValue = resolveConfiguredSlotValue(rules, rawSlotValue);
  if (slotValue == null) {
    return false;
  }

  if (
    isSlotBlocked(rules, dateStr, slotValue) ||
    isSlotAtCapacity(rules, dateStr, slotValue)
  ) {
    return false;
  }

  const slotStartSerial = getSlotStartSerial(dateStr, slotValue);
  if (slotStartSerial == null) {
    return false;
  }

  const zonedNow = getZonedNowParts(rules.timezone, now);
  if (dateStr !== zonedNow.date) {
    return true;
  }

  const nowSerial = toLocalSerial(zonedNow.date, zonedNow.minutes);
  const cutoffSerial = toLocalSerial(dateStr, getCutoffMinutes(rules));
  if (nowSerial >= cutoffSerial) {
    return false;
  }

  const latestAllowedOrderSerial =
    slotStartSerial - Number(rules.prepHours) * MINUTES_PER_HOUR;
  return nowSerial < latestAllowedOrderSerial;
}

export type MerchantRescheduleValidationResult =
  | {
      ok: true;
      // Capacity is merchant ops policy, not a hard gate (REC-4): the caller
      // warns and lets the merchant explicitly override. null = no capacity
      // configured for this date+slot.
      capacity: DeliveryScheduleCapacity | null;
    }
  | {
      ok: false;
      code: "invalid_date" | "date_blocked" | "slot_unknown" | "slot_blocked";
      message: string;
    };

// Merchant-mode validation (§5 validation matrix, locked 2026-07-11): only the
// data-integrity checks bind the merchant path. The customer-facing
// validateDeliverySelection bundles the cutoff/prep minDate and maxDays sales
// window with those checks, so the merchant path uses this decomposed variant
// instead — the customer/storefront engine above is deliberately untouched.
export function validateMerchantRescheduleSelection(
  rules: DeliveryScheduleRules,
  dateStr: string,
  rawSlotValue: string,
): MerchantRescheduleValidationResult {
  if (!isIsoDateString(dateStr)) {
    return {
      ok: false,
      code: "invalid_date",
      message: "Enter a valid delivery date (YYYY-MM-DD).",
    };
  }

  // Same §4.2 resolution as the customer validator: match tolerantly, then use
  // the configured value for the blocked/capacity lookups below.
  const slotValue = resolveConfiguredSlotValue(rules, rawSlotValue);
  if (slotValue == null) {
    return {
      ok: false,
      code: "slot_unknown",
      message: "Selected time slot is not one of the configured slots.",
    };
  }

  if (isDateBlocked(rules, dateStr)) {
    return {
      ok: false,
      code: "date_blocked",
      message: "That date is blocked in the delivery settings.",
    };
  }

  if (isSlotBlocked(rules, dateStr, slotValue)) {
    return {
      ok: false,
      code: "slot_blocked",
      message: "That time slot is blocked for the selected date.",
    };
  }

  const capacity = getSlotCapacityEntry(rules, dateStr, slotValue);
  return { ok: true, capacity: capacity ? { ...capacity } : null };
}

export function getTodayAvailabilityMessage(
  rules: DeliveryScheduleRules,
  selectedDate: string,
  now = new Date(),
): string {
  if (!selectedDate) {
    return "";
  }

  const zonedNow = getZonedNowParts(rules.timezone, now);
  if (selectedDate !== zonedNow.date) {
    return "";
  }

  return zonedNow.minutes >= getCutoffMinutes(rules)
    ? "Same-day delivery cutoff passed. Choose tomorrow."
    : "";
}

export function getAvailableSlots(
  rules: DeliveryScheduleRules,
  dateStr: string,
  now = new Date(),
): DeliveryScheduleSlot[] {
  if (!isIsoDateString(dateStr)) {
    return [];
  }

  return getAvailableTimeSlots(dateStr, rules).filter((slot) =>
    isSlotAvailable(rules, dateStr, slot.value, now),
  );
}

export function getUnavailableDatesInWindow(
  rules: DeliveryScheduleRules,
  now = new Date(),
): string[] {
  const minDate = getMinSelectableDate(rules, now);
  const maxDate = getMaxSelectableDate(rules, minDate);
  const unavailableDates: string[] = [];

  for (
    let currentDate = minDate;
    currentDate <= maxDate;
    currentDate = addDays(currentDate, 1)
  ) {
    const result = validateDeliveryDate(rules, currentDate, now);
    if (!result.ok) {
      unavailableDates.push(currentDate);
    }
  }

  return unavailableDates;
}

export function validateDeliveryDate(
  rules: DeliveryScheduleRules,
  dateStr: string,
  now = new Date(),
): DeliveryDateValidationResult {
  // Return structured date failures so callers can both explain the rejection and
  // keep their surrounding delivery window state in sync with the same rule engine.
  const minDate = getMinSelectableDate(rules, now);
  const maxDate = getMaxSelectableDate(rules, minDate);

  if (!isIsoDateString(dateStr)) {
    return {
      ok: false,
      code: "invalid_date",
      message: "Please select a delivery date.",
      minDate,
      maxDate,
      availableSlots: [],
    };
  }

  if (dateStr < minDate) {
    return {
      ok: false,
      code: "date_before_min",
      message:
        getTodayAvailabilityMessage(rules, dateStr, now) ||
        "Selected delivery date is no longer available. Please choose another date.",
      minDate,
      maxDate,
      availableSlots: [],
    };
  }

  if (dateStr > maxDate) {
    return {
      ok: false,
      code: "date_after_max",
      message: `Selected delivery date is outside the current delivery window. Choose a date between ${minDate} and ${maxDate}.`,
      minDate,
      maxDate,
      availableSlots: [],
    };
  }

  if (isDateBlocked(rules, dateStr)) {
    return {
      ok: false,
      code: "date_blocked",
      message:
        "Selected delivery date is unavailable. Please choose another date.",
      minDate,
      maxDate,
      availableSlots: [],
    };
  }

  const availableSlots = getAvailableSlots(rules, dateStr, now);
  if (!availableSlots.length) {
    return {
      ok: false,
      code: "no_slots_available",
      message:
        getTodayAvailabilityMessage(rules, dateStr, now) ||
        "No delivery slots available for this date. Choose another date.",
      minDate,
      maxDate,
      availableSlots,
    };
  }

  return {
    ok: true,
    minDate,
    maxDate,
    availableSlots,
    message: "",
  };
}

export function validateDeliverySelection(
  rules: DeliveryScheduleRules,
  dateStr: string,
  rawSlotValue: string,
  now = new Date(),
): DeliverySelectionValidationResult {
  // Resolve the incoming slot to its configured value once (case/spacing-tolerant,
  // §4.2) so this validator and the booked-count matcher can never disagree about
  // which configured slot an order names (audit DEF-2/DEF-4).
  const slotValue = resolveConfiguredSlotValue(rules, rawSlotValue);
  // Run the final slot check only after the date has been normalized so every UI and
  // API surface shares one canonical reason for rejecting a delivery selection.
  const dateValidation = validateDeliveryDate(rules, dateStr, now);
  if (!dateValidation.ok) {
    if (dateValidation.code === "invalid_date") {
      return {
        ok: false,
        code: "invalid_date",
        message: "date must be a valid YYYY-MM-DD string",
        minDate: dateValidation.minDate,
        maxDate: dateValidation.maxDate,
        availableSlots: dateValidation.availableSlots,
      };
    }

    return dateValidation;
  }

  const { minDate, maxDate, availableSlots } = dateValidation;

  if (slotValue == null) {
    return {
      ok: false,
      code: "slot_unknown",
      message:
        "Selected time slot is unavailable. Please choose another time slot.",
      minDate,
      maxDate,
      availableSlots,
    };
  }

  if (!availableSlots.length) {
    return {
      ok: false,
      code: "no_slots_available",
      message:
        getTodayAvailabilityMessage(rules, dateStr, now) ||
        "No delivery slots available for this date. Choose another date.",
      minDate,
      maxDate,
      availableSlots,
    };
  }

  if (!availableSlots.some((slot) => slot.value === slotValue)) {
    return {
      ok: false,
      code: "slot_unavailable",
      message:
        "Selected time slot is unavailable. Please choose another time slot.",
      minDate,
      maxDate,
      availableSlots,
    };
  }

  return {
    ok: true,
    minDate,
    maxDate,
    availableSlots,
  };
}
