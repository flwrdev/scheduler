// Canonical slot-value comparison (Scheduler V2 §4.2, docs/scheduler-v2-ux.md).
//
// Slot values on orders and in config are FROZEN as written ("9AM-12PM" shape;
// see api.md §2) — this module never rewrites a stored or written value. It only
// defines how two slot values are COMPARED, so the availability validator, the
// booked-count matcher, and the webhook all agree that "9am - 12pm", "9AM-12PM",
// and "9:00AM - 12:00PM" name the same slot. Divergent ad-hoc matching was the
// root of the silent-overbooking and split-brain defects (audit DEF-2/DEF-4).

import type { DeliveryScheduleRules } from "./delivery-availability";

const SLOT_TIME_PART = /^(\d{1,2})(?::(\d{2}))?(AM|PM)$/;

function canonicalTimePart(part: string): string | null {
  const match = part.match(SLOT_TIME_PART);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = match[2] ?? "00";
  if (hour < 1 || hour > 12 || Number(minute) > 59) {
    return null;
  }

  // ":00" is elided so "9:00AM" and "9AM" canonicalize identically.
  return minute === "00" ? `${hour}${match[3]}` : `${hour}:${minute}${match[3]}`;
}

/**
 * Reduce a slot value to its canonical comparison form: trimmed, uppercased,
 * whitespace removed. When the value is a parseable "start - end" time range,
 * each side is normalized further (leading zeros and ":00" dropped) so every
 * spelling of the same range collapses to one key. Non-range values still get
 * the basic trim/case/space folding, so exact-but-differently-cased legacy
 * values keep matching too.
 */
export function normalizeSlotValueForMatch(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  const compact = value.trim().toUpperCase().replace(/\s+/g, "");
  const parts = compact.split("-");
  if (parts.length === 2) {
    const start = canonicalTimePart(parts[0]);
    const end = canonicalTimePart(parts[1]);
    if (start && end) {
      return `${start}-${end}`;
    }
  }

  return compact;
}

export function slotValuesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const normalizedA = normalizeSlotValueForMatch(a);
  return normalizedA !== "" && normalizedA === normalizeSlotValueForMatch(b);
}

/**
 * Resolve a raw slot value (from a request, cart attribute, or order) to the
 * CONFIGURED slot value it names, or null when no configured slot matches.
 * Callers keep operating on the configured value so downstream lookups into
 * disabledSlots/slotCapacity (which are keyed by configured values) stay exact.
 */
export function resolveConfiguredSlotValue(
  rules: DeliveryScheduleRules,
  rawValue: string | null | undefined,
): string | null {
  const normalized = normalizeSlotValueForMatch(rawValue);
  if (!normalized) {
    return null;
  }

  const slot = rules.slots.find(
    (candidate) => normalizeSlotValueForMatch(candidate.value) === normalized,
  );
  return slot ? slot.value : null;
}

/**
 * Resolve the KEY under which a per-date override map (a `disabledSlots` array
 * or a `slotCapacity` object) holds the entry for `slotValue`, or null when the
 * map has no entry for that slot.
 *
 * Override keys were written by several generations of the editor, so a key's
 * spelling can drift from the configured slot value ("9am - 12pm" vs
 * "9AM-12PM"). The booked-count matcher already resolves those canonically, so
 * the availability lookups must too — otherwise a cap the Scheduler dashboard
 * renders as "Full" is never enforced at checkout, and a slot the merchant
 * blocked for a date stays bookable (audit DEF-2/DEF-4).
 *
 * An exact spelling always wins over a canonical match, so a map holding both
 * spellings resolves to the one the caller actually named.
 */
export function findSlotOverrideKey(
  keys: Iterable<string>,
  slotValue: string | null | undefined,
): string | null {
  const normalized = normalizeSlotValueForMatch(slotValue);
  if (!normalized) {
    return null;
  }

  let canonicalMatch: string | null = null;
  for (const key of keys) {
    if (key === slotValue) {
      return key;
    }
    if (
      canonicalMatch == null &&
      normalizeSlotValueForMatch(key) === normalized
    ) {
      canonicalMatch = key;
    }
  }

  return canonicalMatch;
}
