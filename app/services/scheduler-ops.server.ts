// Granular scheduler ops (Scheduler V2 §4.4 — docs/scheduler-v2-ux.md).
//
// The /app/scheduler action dispatches on an `op` discriminator; each op
// validates only its own inputs, rewrites only its own section of the rules
// blob, and writes through `upsertScheduleRules` under the optimistic version
// guard (client sends the version it loaded; mismatch → stale_config). Every
// result is designed for a 200 + {ok, …} envelope — never a raw 4xx/5xx to the
// embedded fetcher (ADR-11).

import {
  cloneDeliveryScheduleRules,
  type DeliveryScheduleRules,
} from "../lib/delivery-availability";
import {
  generateSlotValue,
  isSlotRangeOrdered,
  type SlotTimePart,
  type SlotTimeRange,
} from "../lib/slot-times";
import { normalizeSlotValueForMatch } from "../lib/slot-value";
import {
  getScheduleRulesWithHealth,
  upsertScheduleRules,
  type UpsertScheduleRulesResult,
} from "./schedule-rules.server";

export type SchedulerOpResult =
  | { ok: true; version: number; rules: DeliveryScheduleRules }
  | {
      ok: false;
      code: "validation" | "stale_config" | "unknown_op";
      fieldErrors?: Record<string, string>;
      /** Fresh server state so the UI can resync after a conflict. */
      rules?: DeliveryScheduleRules;
      version?: number;
    };

interface OpContext {
  rules: DeliveryScheduleRules;
  today: string;
}

type OpOutcome =
  | { patch: Partial<DeliveryScheduleRules> }
  | { fieldErrors: Record<string, string> };

function fieldError(field: string, message: string): OpOutcome {
  return { fieldErrors: { [field]: message } };
}

/** YYYY-MM-DD "today" in the shop's configured timezone. */
export function getTodayInTimezone(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Input narrowing — action bodies arrive as untyped JSON.

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function readTimePart(value: unknown): SlotTimePart | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const part = value as Record<string, unknown>;
  const hour = part.hour;
  const minute = part.minute;
  const meridiem = part.meridiem;
  if (
    typeof hour !== "number" ||
    !Number.isInteger(hour) ||
    hour < 1 ||
    hour > 12 ||
    typeof minute !== "number" ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    (meridiem !== "AM" && meridiem !== "PM")
  ) {
    return null;
  }
  return { hour, minute, meridiem };
}

function readTimeRange(input: Record<string, unknown>): SlotTimeRange | null {
  const start = readTimePart(input.start);
  const end = readTimePart(input.end);
  return start && end ? { start, end } : null;
}

// ---------------------------------------------------------------------------
// Section pruning (§4.4): past-dated override entries are dropped
// opportunistically whenever the section that owns them is rewritten.

function pruneDisabledDates(dates: string[], today: string): string[] {
  return dates.filter((date) => date >= today);
}

function pruneDateKeyedRecord<T>(
  record: Record<string, T>,
  today: string,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([date]) => date >= today),
  );
}

// ---------------------------------------------------------------------------
// Op handlers — pure (rules, input) → patch | fieldErrors.

function opSaveSettings(
  _context: OpContext,
  input: Record<string, unknown>,
): OpOutcome {
  // Bounds/timezone/integer strictness live in validateScheduleRulesPatch —
  // pass the fields through so rejects carry the schema's field errors.
  return {
    patch: {
      timezone: input.timezone,
      cutoffHour: input.cutoffHour,
      prepHours: input.prepHours,
      maxDays: input.maxDays,
    } as Partial<DeliveryScheduleRules>,
  };
}

function opCreateSlot(
  context: OpContext,
  input: Record<string, unknown>,
): OpOutcome {
  const range = readTimeRange(input);
  if (!range) {
    return fieldError("start", "Pick valid start and end times.");
  }
  if (!isSlotRangeOrdered(range)) {
    return fieldError("end", "End time must be after the start time.");
  }

  const value = generateSlotValue(range);
  const display = (readString(input, "display") ?? "").trim() || value;

  const duplicateValue = context.rules.slots.some(
    (slot) =>
      normalizeSlotValueForMatch(slot.value) ===
      normalizeSlotValueForMatch(value),
  );
  if (duplicateValue) {
    return fieldError(
      "start",
      `A slot with these times already exists (${value}).`,
    );
  }
  const duplicateDisplay = context.rules.slots.some(
    (slot) => slot.display.trim().toLowerCase() === display.toLowerCase(),
  );
  if (duplicateDisplay) {
    return fieldError("display", `Display label "${display}" is already used.`);
  }

  return {
    patch: { slots: [...context.rules.slots, { display, value }] },
  };
}

function opUpdateSlotDisplay(
  context: OpContext,
  input: Record<string, unknown>,
): OpOutcome {
  const value = readString(input, "value");
  const display = (readString(input, "display") ?? "").trim();
  if (!value || !context.rules.slots.some((slot) => slot.value === value)) {
    return fieldError("value", "That slot no longer exists. Reload the page.");
  }
  if (!display) {
    return fieldError("display", "Enter a display label.");
  }
  const duplicateDisplay = context.rules.slots.some(
    (slot) =>
      slot.value !== value &&
      slot.display.trim().toLowerCase() === display.toLowerCase(),
  );
  if (duplicateDisplay) {
    return fieldError("display", `Display label "${display}" is already used.`);
  }

  return {
    patch: {
      slots: context.rules.slots.map((slot) =>
        slot.value === value ? { ...slot, display } : slot,
      ),
    },
  };
}

function opReorderSlots(
  context: OpContext,
  input: Record<string, unknown>,
): OpOutcome {
  const order = input.order;
  if (
    !Array.isArray(order) ||
    order.some((value) => typeof value !== "string")
  ) {
    return fieldError("order", "Invalid slot order.");
  }
  const currentValues = context.rules.slots.map((slot) => slot.value);
  const isPermutation =
    order.length === currentValues.length &&
    [...order].sort().join("\0") === [...currentValues].sort().join("\0");
  if (!isPermutation) {
    return fieldError(
      "order",
      "Slot order is out of date. Reload the page and try again.",
    );
  }

  const byValue = new Map(context.rules.slots.map((slot) => [slot.value, slot]));
  return {
    patch: {
      slots: (order as string[]).map((value) => ({ ...byValue.get(value)! })),
    },
  };
}

function opDeleteSlot(
  context: OpContext,
  input: Record<string, unknown>,
): OpOutcome {
  const value = readString(input, "value");
  if (!value || !context.rules.slots.some((slot) => slot.value === value)) {
    return fieldError("value", "That slot no longer exists. Reload the page.");
  }
  if (context.rules.slots.length <= 1) {
    return fieldError("value", "Keep at least one delivery slot.");
  }

  const { today } = context;
  const disabledSlots = Object.fromEntries(
    Object.entries(pruneDateKeyedRecord(context.rules.disabledSlots, today))
      .map(([date, values]) => [date, values.filter((v) => v !== value)])
      .filter(([, values]) => (values as string[]).length > 0),
  ) as Record<string, string[]>;
  const slotCapacity = Object.fromEntries(
    Object.entries(pruneDateKeyedRecord(context.rules.slotCapacity, today))
      .map(([date, capacities]) => {
        const rest = Object.fromEntries(
          Object.entries(capacities).filter(([slot]) => slot !== value),
        );
        return [date, rest] as const;
      })
      .filter(([, capacities]) => Object.keys(capacities).length > 0),
  ) as DeliveryScheduleRules["slotCapacity"];

  return {
    patch: {
      slots: context.rules.slots.filter((slot) => slot.value !== value),
      disabledSlots,
      slotCapacity,
    },
  };
}

function opSaveDayOverride(
  context: OpContext,
  input: Record<string, unknown>,
): OpOutcome {
  const date = readString(input, "date");
  if (!date) {
    return fieldError("date", "Pick a date first.");
  }
  const blocked = input.blocked === true;
  const blockedSlotsInput = Array.isArray(input.blockedSlots)
    ? input.blockedSlots
    : [];
  if (blockedSlotsInput.some((value) => typeof value !== "string")) {
    return fieldError("blockedSlots", "Invalid blocked slots.");
  }
  const capacitiesInput =
    input.capacities && typeof input.capacities === "object"
      ? (input.capacities as Record<string, unknown>)
      : {};

  const knownValues = new Set(context.rules.slots.map((slot) => slot.value));
  for (const value of blockedSlotsInput as string[]) {
    if (!knownValues.has(value)) {
      return fieldError("blockedSlots", `Unknown slot "${value}".`);
    }
  }

  const dayCapacities: Record<string, { capacity: number; booked: number }> =
    {};
  for (const [slotValue, capacity] of Object.entries(capacitiesInput)) {
    if (capacity === null || capacity === undefined || capacity === "") {
      continue; // cleared — no capacity rule for this slot
    }
    if (!knownValues.has(slotValue)) {
      return fieldError("capacities", `Unknown slot "${slotValue}".`);
    }
    if (
      typeof capacity !== "number" ||
      !Number.isInteger(capacity) ||
      capacity < 0
    ) {
      return fieldError(
        "capacities",
        "Capacity must be a whole number of 0 or more.",
      );
    }
    dayCapacities[slotValue] = { capacity, booked: 0 };
  }

  const { today } = context;
  const disabledDates = pruneDisabledDates(
    context.rules.disabledDates.filter((d) => d !== date),
    today,
  );
  if (blocked) {
    disabledDates.push(date);
  }
  disabledDates.sort();

  const disabledSlots = pruneDateKeyedRecord(
    context.rules.disabledSlots,
    today,
  );
  delete disabledSlots[date];
  // Per-slot blocks survive a day-level block for the same reason the caps below
  // do: blocking the whole day is a flag, not an edit of that date's per-slot
  // config, and dropping them here made block -> unblock lose the merchant's
  // window blocks silently. They are redundant while the day is blocked (the
  // date-level block already wins) and become live again on unblock.
  if ((blockedSlotsInput as string[]).length) {
    disabledSlots[date] = [...(blockedSlotsInput as string[])];
  }

  const slotCapacity = pruneDateKeyedRecord(context.rules.slotCapacity, today);
  delete slotCapacity[date];
  if (Object.keys(dayCapacities).length) {
    slotCapacity[date] = dayCapacities;
  }

  return { patch: { disabledDates, disabledSlots, slotCapacity } };
}

function opClearDayOverride(
  context: OpContext,
  input: Record<string, unknown>,
): OpOutcome {
  const date = readString(input, "date");
  if (!date) {
    return fieldError("date", "Pick a date first.");
  }

  const { today } = context;
  const disabledSlots = pruneDateKeyedRecord(
    context.rules.disabledSlots,
    today,
  );
  delete disabledSlots[date];
  const slotCapacity = pruneDateKeyedRecord(context.rules.slotCapacity, today);
  delete slotCapacity[date];

  return {
    patch: {
      disabledDates: pruneDisabledDates(
        context.rules.disabledDates.filter((d) => d !== date),
        today,
      ),
      disabledSlots,
      slotCapacity,
    },
  };
}

const OP_HANDLERS: Record<
  string,
  (context: OpContext, input: Record<string, unknown>) => OpOutcome
> = {
  saveSettings: opSaveSettings,
  createSlot: opCreateSlot,
  updateSlotDisplay: opUpdateSlotDisplay,
  reorderSlots: opReorderSlots,
  deleteSlot: opDeleteSlot,
  saveDayOverride: opSaveDayOverride,
  clearDayOverride: opClearDayOverride,
};

function mapUpsertResult(result: UpsertScheduleRulesResult): SchedulerOpResult {
  if (result.ok) {
    return { ok: true, version: result.version, rules: result.rules };
  }
  if (result.code === "validation") {
    return { ok: false, code: "validation", fieldErrors: result.fieldErrors };
  }
  return {
    ok: false,
    code: "stale_config",
    rules: result.rules,
    version: result.version,
  };
}

/**
 * Run one granular op for `shop`. `expectedVersion` is the version the client
 * loaded; a concurrent writer having bumped it yields `stale_config` with the
 * fresh rules so the section can resync instead of last-writer-wins (DEF-11).
 */
export async function runSchedulerOp(
  shop: string,
  op: string,
  input: Record<string, unknown>,
  expectedVersion: number,
  now = new Date(),
): Promise<SchedulerOpResult> {
  const handler = OP_HANDLERS[op];
  if (!handler) {
    return { ok: false, code: "unknown_op" };
  }

  const { rules, version } = await getScheduleRulesWithHealth(shop);
  const context: OpContext = {
    rules: cloneDeliveryScheduleRules(rules),
    today: getTodayInTimezone(rules.timezone, now),
  };

  const outcome = handler(context, input);
  if ("fieldErrors" in outcome) {
    return { ok: false, code: "validation", fieldErrors: outcome.fieldErrors };
  }

  // If the client's loaded version is already behind, surface the conflict
  // now with fresh state instead of letting the DB guard produce a less
  // helpful failure later.
  if (expectedVersion !== version) {
    return { ok: false, code: "stale_config", rules, version };
  }

  const result = await upsertScheduleRules(shop, outcome.patch, {
    expectedVersion,
  });
  return mapUpsertResult(result);
}
