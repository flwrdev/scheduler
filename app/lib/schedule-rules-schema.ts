// Strict schedule-rules schema (Scheduler V2 §4.1, docs/scheduler-rules-v2-ux — see
// docs/scheduler-v2-ux.md). One module owns the two directions the rules blob moves:
//
// - WRITE (validateScheduleRulesPatch): admin payloads are validated strictly and
//   rejected with per-field errors. Nothing is silently mended, dropped, or
//   "kept from the old value" — the silent-keep-old behavior was audit DEF-9.
// - READ (deserializeStoredScheduleRules): stored JSON is parsed leniently for
//   sales continuity (a storefront request must not 500 on a corrupt column) but
//   LOUDLY — every fallback or dropped entry is reported as a ConfigHealthIssue
//   instead of silently resurrecting defaults (audit DEF-10).
//
// Slot values remain verbatim strings (frozen "9AM-12PM" wire format, api.md §2);
// comparisons go through normalizeSlotValueForMatch (see lib/slot-value.ts).

import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  isIsoDateString,
  type DeliveryScheduleCapacity,
  type DeliveryScheduleRules,
  type DeliveryScheduleSlot,
} from "./delivery-availability";
import { normalizeSlotValueForMatch } from "./slot-value";

// Locked bounds (design §4.1). prepHours/maxDays caps stop the unbounded
// per-request O(maxDays) validation loops (audit PERF-3).
export const CUTOFF_HOUR_MIN = 0;
export const CUTOFF_HOUR_MAX = 23;
export const PREP_HOURS_MIN = 0;
export const PREP_HOURS_MAX = 72;
export const MAX_DAYS_MIN = 1;
export const MAX_DAYS_MAX = 120;

export interface ConfigHealthIssue {
  column:
    | "timezone"
    | "cutoffHour"
    | "prepHours"
    | "maxDays"
    | "slotsJson"
    | "disabledDatesJson"
    | "disabledSlotsJson"
    | "slotCapacityJson";
  message: string;
}

export type ScheduleRulesPatchValidation =
  | { ok: true; patch: Partial<DeliveryScheduleRules> }
  | { ok: false; fieldErrors: Record<string, string> };

export function isValidTimeZone(value: string): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Calendar-real ISO date: shape AND a Date.UTC round-trip, so 2026-02-31 /
// 2026-13-01 are rejected instead of silently rolling over (audit DATE-01 for
// config data; the storefront-facing isIsoDateString is deliberately untouched).
export function isRealIsoDate(value: string): boolean {
  if (typeof value !== "string" || !isIsoDateString(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

// Strict integer gate: integer numbers, or digit-only strings. "" , "1e2",
// "0x10", floats, and negatives are all rejected — Number("") === 0 silently
// saving cutoffHour 0 was audit DEF-8.
export function parseStrictInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function integerFieldError(
  fieldErrors: Record<string, string>,
  field: string,
  label: string,
  value: unknown,
  min: number,
  max: number,
): number | null {
  const parsed = parseStrictInteger(value);
  if (parsed == null || parsed < min || parsed > max) {
    fieldErrors[field] = `${label} must be a whole number between ${min} and ${max}.`;
    return null;
  }

  return parsed;
}

function normalizeSlotDisplay(display: string): string {
  return display.trim().toUpperCase();
}

// Display labels that are ALREADY duplicated in the stored slot list. The write
// path grandfathers these: the old free-text editor only ever rejected duplicate
// VALUES, and the read path still de-dupes by value only, so a pre-V2 config can
// legitimately hold two slots labelled "Morning". Without this, re-validating the
// whole list on every slot op made createSlot/deleteSlot/reorderSlots fail
// permanently with a `fieldErrors.slots` message naming a label the merchant
// never touched — and SlotsCard binds only display/start/end, so nothing rendered
// it. New duplicates are still rejected.
function duplicatedSlotDisplays(slots: DeliveryScheduleSlot[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();

  for (const slot of slots) {
    const normalized = normalizeSlotDisplay(
      typeof slot?.display === "string" ? slot.display : "",
    );
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      duplicated.add(normalized);
    }
    seen.add(normalized);
  }

  return duplicated;
}

function validateSlots(
  fieldErrors: Record<string, string>,
  rawSlots: unknown,
  currentSlots: DeliveryScheduleSlot[],
): DeliveryScheduleSlot[] | null {
  if (!Array.isArray(rawSlots)) {
    fieldErrors.slots = "Slots must be a list.";
    return null;
  }

  const slots: DeliveryScheduleSlot[] = [];
  const seenValues = new Set<string>();
  const seenDisplays = new Set<string>();
  const grandfatheredDisplays = duplicatedSlotDisplays(currentSlots);

  for (const [index, rawSlot] of rawSlots.entries()) {
    const display =
      rawSlot && typeof rawSlot.display === "string" ? rawSlot.display.trim() : "";
    const value =
      rawSlot && typeof rawSlot.value === "string" ? rawSlot.value.trim() : "";

    if (!display || !value) {
      fieldErrors.slots = `Slot ${index + 1} needs both a display label and a value.`;
      return null;
    }

    const normalizedValue = normalizeSlotValueForMatch(value);
    if (seenValues.has(normalizedValue)) {
      fieldErrors.slots = `Slot value "${value}" is duplicated.`;
      return null;
    }

    const normalizedDisplay = normalizeSlotDisplay(display);
    if (
      seenDisplays.has(normalizedDisplay) &&
      !grandfatheredDisplays.has(normalizedDisplay)
    ) {
      fieldErrors.slots = `Slot label "${display}" is duplicated.`;
      return null;
    }

    seenValues.add(normalizedValue);
    seenDisplays.add(normalizedDisplay);
    slots.push({ display, value });
  }

  return slots;
}

function slotValueReferenceSet(slots: DeliveryScheduleSlot[]): Set<string> {
  return new Set(slots.map((slot) => normalizeSlotValueForMatch(slot.value)));
}

/**
 * Strictly validate an admin-provided partial rules payload against the locked
 * schema. `effectiveSlots` is the slot list the cross-checks run against: the
 * patch's own slots when provided, otherwise the currently stored slots — so
 * disabledSlots/slotCapacity can never persist a reference to a slot that does
 * not exist (audit DEF-9 orphan hole).
 */
export function validateScheduleRulesPatch(
  patch: Partial<DeliveryScheduleRules>,
  currentSlots: DeliveryScheduleSlot[],
): ScheduleRulesPatchValidation {
  const fieldErrors: Record<string, string> = {};
  const clean: Partial<DeliveryScheduleRules> = {};

  if (patch.timezone !== undefined) {
    const timezone = typeof patch.timezone === "string" ? patch.timezone.trim() : "";
    if (!isValidTimeZone(timezone)) {
      fieldErrors.timezone =
        "Timezone must be a valid IANA timezone name (for example Asia/Manila).";
    } else {
      clean.timezone = timezone;
    }
  }

  if (patch.cutoffHour !== undefined) {
    const cutoffHour = integerFieldError(
      fieldErrors,
      "cutoffHour",
      "Same-day cutoff hour",
      patch.cutoffHour,
      CUTOFF_HOUR_MIN,
      CUTOFF_HOUR_MAX,
    );
    if (cutoffHour != null) clean.cutoffHour = cutoffHour;
  }

  if (patch.prepHours !== undefined) {
    const prepHours = integerFieldError(
      fieldErrors,
      "prepHours",
      "Preparation time (hours)",
      patch.prepHours,
      PREP_HOURS_MIN,
      PREP_HOURS_MAX,
    );
    if (prepHours != null) clean.prepHours = prepHours;
  }

  if (patch.maxDays !== undefined) {
    const maxDays = integerFieldError(
      fieldErrors,
      "maxDays",
      "Booking window (days)",
      patch.maxDays,
      MAX_DAYS_MIN,
      MAX_DAYS_MAX,
    );
    if (maxDays != null) clean.maxDays = maxDays;
  }

  if (patch.slots !== undefined) {
    const slots = validateSlots(fieldErrors, patch.slots, currentSlots);
    if (slots) clean.slots = slots;
  }

  const effectiveSlots = clean.slots ?? currentSlots;
  const knownSlotValues = slotValueReferenceSet(effectiveSlots);

  if (patch.disabledDates !== undefined) {
    if (!Array.isArray(patch.disabledDates)) {
      fieldErrors.disabledDates = "Blocked dates must be a list.";
    } else {
      const dates = new Set<string>();
      let invalid: string | null = null;
      for (const rawDate of patch.disabledDates) {
        const date = typeof rawDate === "string" ? rawDate.trim() : "";
        if (!isRealIsoDate(date)) {
          invalid = String(rawDate);
          break;
        }
        dates.add(date);
      }

      if (invalid != null) {
        fieldErrors.disabledDates = `"${invalid}" is not a valid calendar date (YYYY-MM-DD).`;
      } else {
        clean.disabledDates = Array.from(dates);
      }
    }
  }

  if (patch.disabledSlots !== undefined) {
    if (
      !patch.disabledSlots ||
      typeof patch.disabledSlots !== "object" ||
      Array.isArray(patch.disabledSlots)
    ) {
      fieldErrors.disabledSlots = "Blocked time slots must map dates to slot lists.";
    } else {
      const disabledSlots: Record<string, string[]> = {};
      for (const [rawDate, rawSlots] of Object.entries(patch.disabledSlots)) {
        const date = rawDate.trim();
        if (!isRealIsoDate(date)) {
          fieldErrors.disabledSlots = `"${rawDate}" is not a valid calendar date (YYYY-MM-DD).`;
          break;
        }

        if (!Array.isArray(rawSlots)) {
          fieldErrors.disabledSlots = `Blocked slots for ${date} must be a list.`;
          break;
        }

        const values: string[] = [];
        const seen = new Set<string>();
        let unknown: string | null = null;
        for (const rawValue of rawSlots) {
          const value = typeof rawValue === "string" ? rawValue.trim() : "";
          const normalized = normalizeSlotValueForMatch(value);
          if (!normalized || !knownSlotValues.has(normalized)) {
            unknown = String(rawValue);
            break;
          }
          if (!seen.has(normalized)) {
            seen.add(normalized);
            values.push(value);
          }
        }

        if (unknown != null) {
          fieldErrors.disabledSlots = `Blocked slot "${unknown}" on ${date} does not match any configured slot.`;
          break;
        }

        if (values.length) {
          disabledSlots[date] = values;
        }
      }

      if (!fieldErrors.disabledSlots) {
        clean.disabledSlots = disabledSlots;
      }
    }
  }

  if (patch.slotCapacity !== undefined) {
    if (
      !patch.slotCapacity ||
      typeof patch.slotCapacity !== "object" ||
      Array.isArray(patch.slotCapacity)
    ) {
      fieldErrors.slotCapacity = "Slot capacity must map dates to per-slot limits.";
    } else {
      const slotCapacity: Record<string, Record<string, DeliveryScheduleCapacity>> = {};
      for (const [rawDate, rawCapacities] of Object.entries(patch.slotCapacity)) {
        const date = rawDate.trim();
        if (!isRealIsoDate(date)) {
          fieldErrors.slotCapacity = `"${rawDate}" is not a valid calendar date (YYYY-MM-DD).`;
          break;
        }

        if (
          !rawCapacities ||
          typeof rawCapacities !== "object" ||
          Array.isArray(rawCapacities)
        ) {
          fieldErrors.slotCapacity = `Capacity entries for ${date} must map slots to limits.`;
          break;
        }

        const capacities: Record<string, DeliveryScheduleCapacity> = {};
        for (const [rawValue, rawEntry] of Object.entries(rawCapacities)) {
          const value = rawValue.trim();
          const normalized = normalizeSlotValueForMatch(value);
          if (!normalized || !knownSlotValues.has(normalized)) {
            fieldErrors.slotCapacity = `Capacity slot "${rawValue}" on ${date} does not match any configured slot.`;
            break;
          }

          const capacity = parseStrictInteger(
            rawEntry && typeof rawEntry === "object"
              ? (rawEntry as { capacity?: unknown }).capacity
              : undefined,
          );
          if (capacity == null) {
            fieldErrors.slotCapacity = `Capacity for ${value} on ${date} must be a whole number of 0 or more.`;
            break;
          }

          // `booked` is vestigial in storage (live counts overlay it on read);
          // it is pinned to 0 so a stale persisted count can never be compared.
          capacities[value] = { capacity, booked: 0 };
        }

        if (fieldErrors.slotCapacity) {
          break;
        }

        if (Object.keys(capacities).length) {
          slotCapacity[date] = capacities;
        }
      }

      if (!fieldErrors.slotCapacity) {
        clean.slotCapacity = slotCapacity;
      }
    }
  }

  if (Object.keys(fieldErrors).length) {
    return { ok: false, fieldErrors };
  }

  return { ok: true, patch: clean };
}

interface StoredScheduleRulesRecord {
  timezone: string;
  cutoffHour: number;
  prepHours: number;
  maxDays: number;
  slotsJson: string;
  disabledDatesJson: string;
  disabledSlotsJson: string;
  slotCapacityJson: string;
}

export interface StoredScheduleRulesReadResult {
  rules: DeliveryScheduleRules;
  configHealth: ConfigHealthIssue[];
}

function clampStoredInteger(
  issues: ConfigHealthIssue[],
  column: "cutoffHour" | "prepHours" | "maxDays",
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isInteger(value)) {
    issues.push({ column, message: `Stored ${column} is not an integer; using ${fallback}.` });
    return fallback;
  }

  if (value < min || value > max) {
    const clamped = Math.min(Math.max(value, min), max);
    issues.push({
      column,
      message: `Stored ${column} (${value}) is outside ${min}–${max}; clamped to ${clamped}.`,
    });
    return clamped;
  }

  return value;
}

/**
 * Parse a stored per-slot capacity limit, or null when the stored value does not
 * name one.
 *
 * The read used to do a bare `Number(...)` behind a `Number.isFinite(v) && v >= 0`
 * gate. `Number(null)`, `Number("")` and `Number([])` are all 0, which passes that
 * gate — so a hand-edited row, a restored backup, or any writer predating the
 * strict write gate silently pinned the slot to capacity 0. `isSlotAtCapacity`
 * then reads `0 >= 0` as true: the window disappears from checkout for that date
 * and every reschedule into it is rejected as `slot_unavailable`, with no
 * ConfigHealthIssue to fire the "Stored settings need attention" banner. Parse
 * strictly instead, and stay lenient-but-LOUD about a recoverable float.
 */
function parseStoredCapacity(
  issues: ConfigHealthIssue[],
  date: string,
  value: string,
  raw: unknown,
): number | null {
  const strict = parseStrictInteger(raw);
  if (strict != null) {
    return strict;
  }

  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    const floored = Math.floor(raw);
    issues.push({
      column: "slotCapacityJson",
      message: `Stored capacity for ${value} on ${date} (${raw}) is not a whole number; using ${floored}.`,
    });
    return floored;
  }

  return null;
}

function parseJsonColumn(
  issues: ConfigHealthIssue[],
  column: ConfigHealthIssue["column"],
  jsonValue: string,
): unknown {
  try {
    return JSON.parse(jsonValue);
  } catch {
    issues.push({
      column,
      message: `Stored ${column} is not valid JSON; falling back to defaults for this column.`,
    });
    return undefined;
  }
}

/**
 * Lenient-but-loud read of a stored config row. Storefront-facing callers keep
 * getting a fully shaped rules object (sales continuity), but every fallback or
 * dropped entry surfaces in `configHealth` so admin surfaces can show the truth
 * instead of a fabricated "all good" (audit DEF-10 / DASH-2).
 *
 * A valid, deliberately empty `slots: []` is respected as empty — it no longer
 * resurrects the default slots.
 */
export function deserializeStoredScheduleRules(
  record: StoredScheduleRulesRecord,
): StoredScheduleRulesReadResult {
  const issues: ConfigHealthIssue[] = [];
  const defaults = DEFAULT_DELIVERY_SCHEDULE_RULES;

  let timezone = typeof record.timezone === "string" ? record.timezone.trim() : "";
  if (!isValidTimeZone(timezone)) {
    issues.push({
      column: "timezone",
      message: `Stored timezone "${record.timezone}" is not a valid IANA timezone; using ${defaults.timezone}.`,
    });
    timezone = defaults.timezone;
  }

  const cutoffHour = clampStoredInteger(
    issues,
    "cutoffHour",
    record.cutoffHour,
    CUTOFF_HOUR_MIN,
    CUTOFF_HOUR_MAX,
    defaults.cutoffHour,
  );
  const prepHours = clampStoredInteger(
    issues,
    "prepHours",
    record.prepHours,
    PREP_HOURS_MIN,
    PREP_HOURS_MAX,
    defaults.prepHours,
  );
  const maxDays = clampStoredInteger(
    issues,
    "maxDays",
    record.maxDays,
    MAX_DAYS_MIN,
    MAX_DAYS_MAX,
    defaults.maxDays,
  );

  let slots: DeliveryScheduleSlot[];
  const rawSlots = parseJsonColumn(issues, "slotsJson", record.slotsJson);
  if (rawSlots === undefined || !Array.isArray(rawSlots)) {
    if (rawSlots !== undefined) {
      issues.push({
        column: "slotsJson",
        message: "Stored slots are not a list; falling back to the default slots.",
      });
    }
    slots = defaults.slots.map((slot) => ({ ...slot }));
  } else {
    const seenValues = new Set<string>();
    slots = [];
    for (const rawSlot of rawSlots) {
      const display =
        rawSlot && typeof rawSlot.display === "string" ? rawSlot.display.trim() : "";
      const value =
        rawSlot && typeof rawSlot.value === "string" ? rawSlot.value.trim() : "";
      const normalized = normalizeSlotValueForMatch(value);

      if (!display || !value) {
        issues.push({
          column: "slotsJson",
          message: "Dropped a stored slot with a missing label or value.",
        });
        continue;
      }

      if (seenValues.has(normalized)) {
        issues.push({
          column: "slotsJson",
          message: `Dropped a stored duplicate of slot value "${value}".`,
        });
        continue;
      }

      seenValues.add(normalized);
      slots.push({ display, value });
    }
  }

  let disabledDates: string[];
  const rawDates = parseJsonColumn(issues, "disabledDatesJson", record.disabledDatesJson);
  if (rawDates === undefined || !Array.isArray(rawDates)) {
    if (rawDates !== undefined) {
      issues.push({
        column: "disabledDatesJson",
        message: "Stored blocked dates are not a list; treating as none.",
      });
    }
    disabledDates = [];
  } else {
    const dates = new Set<string>();
    for (const rawDate of rawDates) {
      const date = typeof rawDate === "string" ? rawDate.trim() : "";
      if (!isRealIsoDate(date)) {
        issues.push({
          column: "disabledDatesJson",
          message: `Dropped stored blocked date "${String(rawDate)}" (not a valid calendar date).`,
        });
        continue;
      }
      dates.add(date);
    }
    disabledDates = Array.from(dates);
  }

  // The override maps below are pruned against the slot list resolved above.
  //
  // The read used to keep every stored override verbatim while the write path
  // rejects any patch referencing a slot that is not configured — and each
  // day-override op resubmits the WHOLE map. One orphan key (a slot dropped just
  // above for a missing label or a duplicate value, or a custom slot lost to a
  // corrupt slotsJson) therefore failed every subsequent save AND every slot
  // delete, permanently, with no in-app way to remove the offending entry. The
  // read is the only place that can break that deadlock, so it prunes here and
  // says so, per this module's lenient-but-LOUD contract.
  //
  // Matching is canonical (not exact) for the same reason the availability
  // lookups are: a key whose spelling drifted from the configured value names a
  // real slot and must survive.
  const knownSlotValues = slotValueReferenceSet(slots);

  const disabledSlots: Record<string, string[]> = {};
  const rawDisabledSlots = parseJsonColumn(
    issues,
    "disabledSlotsJson",
    record.disabledSlotsJson,
  );
  if (rawDisabledSlots !== undefined) {
    if (
      !rawDisabledSlots ||
      typeof rawDisabledSlots !== "object" ||
      Array.isArray(rawDisabledSlots)
    ) {
      issues.push({
        column: "disabledSlotsJson",
        message: "Stored blocked slots are not a date map; treating as none.",
      });
    } else {
      for (const [date, rawValues] of Object.entries(rawDisabledSlots)) {
        if (!isRealIsoDate(date) || !Array.isArray(rawValues)) {
          issues.push({
            column: "disabledSlotsJson",
            message: `Dropped stored blocked-slot entry for "${date}" (invalid date or slot list).`,
          });
          continue;
        }

        const values: string[] = [];
        const seen = new Set<string>();
        for (const rawValue of rawValues) {
          if (typeof rawValue !== "string" || !rawValue.trim()) {
            continue;
          }

          const normalized = normalizeSlotValueForMatch(rawValue);
          if (!knownSlotValues.has(normalized)) {
            issues.push({
              column: "disabledSlotsJson",
              message: `Dropped stored blocked slot "${rawValue}" on ${date} (no matching configured slot).`,
            });
            continue;
          }

          if (seen.has(normalized)) {
            continue;
          }
          seen.add(normalized);
          values.push(rawValue);
        }

        if (values.length) {
          disabledSlots[date] = values;
        }
      }
    }
  }

  const slotCapacity: Record<string, Record<string, DeliveryScheduleCapacity>> = {};
  const rawCapacity = parseJsonColumn(issues, "slotCapacityJson", record.slotCapacityJson);
  if (rawCapacity !== undefined) {
    if (!rawCapacity || typeof rawCapacity !== "object" || Array.isArray(rawCapacity)) {
      issues.push({
        column: "slotCapacityJson",
        message: "Stored slot capacity is not a date map; treating as none.",
      });
    } else {
      for (const [date, rawCapacities] of Object.entries(rawCapacity)) {
        if (!isRealIsoDate(date) || !rawCapacities || typeof rawCapacities !== "object") {
          issues.push({
            column: "slotCapacityJson",
            message: `Dropped stored capacity entry for "${date}" (invalid date or shape).`,
          });
          continue;
        }

        const capacities: Record<string, DeliveryScheduleCapacity> = {};
        const capacityKeyByCanonical = new Map<string, string>();
        for (const [value, rawEntry] of Object.entries(
          rawCapacities as Record<string, unknown>,
        )) {
          const normalized = normalizeSlotValueForMatch(value);
          if (!knownSlotValues.has(normalized)) {
            issues.push({
              column: "slotCapacityJson",
              message: `Dropped stored capacity for "${value}" on ${date} (no matching configured slot).`,
            });
            continue;
          }

          const capacity = parseStoredCapacity(
            issues,
            date,
            value,
            rawEntry && typeof rawEntry === "object"
              ? (rawEntry as { capacity?: unknown }).capacity
              : undefined,
          );

          if (capacity == null) {
            issues.push({
              column: "slotCapacityJson",
              message: `Dropped stored capacity for ${value} on ${date} (invalid limit).`,
            });
            continue;
          }

          // Two keys on one date that canonicalize to the same slot are an
          // ambiguity: buildCapacityKeyIndex resolves it last-write-wins, while
          // the enforcement lookup prefers an exact spelling — so the booked
          // count and the cap it is compared against could land on different
          // entries. Collapse the pair here (matching the counts engine's
          // last-write-wins) so only one entry per slot ever reaches either.
          const supersededKey = capacityKeyByCanonical.get(normalized);
          if (supersededKey !== undefined) {
            delete capacities[supersededKey];
            issues.push({
              column: "slotCapacityJson",
              message: `Dropped duplicate stored capacity key "${supersededKey}" on ${date} (superseded by "${value}").`,
            });
          }
          capacityKeyByCanonical.set(normalized, value);

          // A missing/invalid stored `booked` no longer deletes the whole
          // capacity limit (old DEF-style silent destruction) — booked is
          // vestigial and reset to 0; live counts overlay it on read.
          capacities[value] = { capacity, booked: 0 };
        }

        if (Object.keys(capacities).length) {
          slotCapacity[date] = capacities;
        }
      }
    }
  }

  return {
    rules: {
      timezone,
      cutoffHour,
      prepHours,
      maxDays,
      slots,
      disabledDates,
      disabledSlots,
      slotCapacity,
    },
    configHealth: issues,
  };
}
