// Scheduler card for per-date overrides: block a whole date, block individual slots on a date,
// or set a capacity for a slot on a date. Each save is one `saveDayOverride` operation.

import { useState } from "react";

import { disallowDatesBefore, isCompleteIsoDate } from "../../lib/date-field";
import { buildUpcomingOverrides } from "../../lib/scheduler-overview";
import { flag } from "../../lib/web-component-props";
import { SectionHeader } from "../ui/SectionHeader";
import type { SchedulerPageState } from "./op-plumbing";
import { formatDateLabel, useSchedulerOp } from "./op-plumbing";

export interface DayDraft {
  blocked: boolean;
  blockedSlots: string[];
  capacities: Record<string, string>;
}

// Builds the editable draft for one date from the saved rules.
export function buildDayDraft(
  state: SchedulerPageState,
  date: string,
): DayDraft {
  const capacities: Record<string, string> = {};
  for (const [slotValue, entry] of Object.entries(
    state.rules.slotCapacity[date] ?? {},
  )) {
    capacities[slotValue] = String(entry.capacity);
  }
  return {
    blocked: state.rules.disabledDates.includes(date),
    blockedSlots: [...(state.rules.disabledSlots[date] ?? [])],
    capacities,
  };
}

export function DayOverridesCard({
  state,
  selectedDate,
  onSelectDate,
  onSync,
}: {
  state: SchedulerPageState;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  onSync: (state: SchedulerPageState) => void;
}) {
  const { rules, version, today } = state;
  const [draft, setDraft] = useState<DayDraft | null>(() =>
    selectedDate ? buildDayDraft(state, selectedDate) : null,
  );

  const { submitOp, submitting, fieldErrors } = useSchedulerOp({
    onSync,
    successMessage: (op) =>
      op === "clearDayOverride" ? "Overrides cleared" : "Day saved",
  });

  const upcoming = buildUpcomingOverrides(rules, today);

  // Opens the panel for a date (or closes it when `date` is null) and loads its draft.
  function selectDate(date: string | null) {
    onSelectDate(date);
    setDraft(date ? buildDayDraft(state, date) : null);
  }

  const hasStoredOverride =
    selectedDate !== null &&
    (rules.disabledDates.includes(selectedDate) ||
      selectedDate in rules.disabledSlots ||
      selectedDate in rules.slotCapacity);

  return (
    <s-section>
      <s-stack gap="base">
        <SectionHeader
          title="Date overrides"
          description="Block a whole day, close individual windows, or cap how many orders a window can take on one date."
        />

        <s-date-field
          label="Pick a date"
          value={selectedDate ?? ""}
          disallow={disallowDatesBefore(today)}
          error={fieldErrors.date}
          onInput={(e) => {
            const date = e.currentTarget.value;
            if (date === "") selectDate(null);
            else if (isCompleteIsoDate(date)) selectDate(date);
          }}
        />

        {selectedDate && draft && (
          <s-stack gap="small">
            <s-divider />
            <s-stack
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-heading>{formatDateLabel(selectedDate)}</s-heading>
              {selectedDate < today && <s-badge tone="warning">Past date</s-badge>}
            </s-stack>

            <s-checkbox
              label="Block the entire day"
              checked={flag(draft.blocked)}
              details="Customers can’t pick this date at all."
              onInput={(e) => {
                const blocked = e.currentTarget.checked;
                setDraft((d) => (d ? { ...d, blocked } : d));
              }}
            />

            {!draft.blocked && (
              <s-stack gap="small">
                {rules.slots.map((slot) => {
                  const blocked = draft.blockedSlots.includes(slot.value);
                  const liveBooked =
                    rules.slotCapacity[selectedDate]?.[slot.value]?.booked;
                  return (
                    <s-stack
                      key={slot.value}
                      direction="inline"
                      gap="base"
                      alignItems="center"
                    >
                      <div style={{ minWidth: "160px", flexGrow: 1 }}>
                        <s-checkbox
                          label={`${slot.display} (${slot.value})`}
                          checked={flag(blocked)}
                          details={blocked ? "Blocked on this date" : undefined}
                          onInput={(e) => {
                            const checked = e.currentTarget.checked;
                            setDraft((d) =>
                              d
                                ? {
                                    ...d,
                                    blockedSlots: checked
                                      ? [...d.blockedSlots, slot.value]
                                      : d.blockedSlots.filter(
                                          (value) => value !== slot.value,
                                        ),
                                  }
                                : d,
                            );
                          }}
                        />
                      </div>
                      {!blocked && (
                        <s-stack
                          direction="inline"
                          gap="small-200"
                          alignItems="center"
                        >
                          <div style={{ width: "120px" }}>
                            <s-number-field
                              label={`Capacity for ${slot.display}`}
                              labelAccessibilityVisibility="exclusive"
                              min={0}
                              autocomplete="off"
                              placeholder="No cap"
                              value={draft.capacities[slot.value] ?? ""}
                              onInput={(e) => {
                                const value = e.currentTarget.value;
                                setDraft((d) =>
                                  d
                                    ? {
                                        ...d,
                                        capacities: {
                                          ...d.capacities,
                                          [slot.value]: value,
                                        },
                                      }
                                    : d,
                                );
                              }}
                            />
                          </div>
                          {typeof liveBooked === "number" && (
                            <s-text color="subdued">{liveBooked} booked</s-text>
                          )}
                        </s-stack>
                      )}
                    </s-stack>
                  );
                })}
                {fieldErrors.capacities && (
                  <s-text tone="critical">{fieldErrors.capacities}</s-text>
                )}
                {fieldErrors.blockedSlots && (
                  <s-text tone="critical">{fieldErrors.blockedSlots}</s-text>
                )}
              </s-stack>
            )}

            <s-stack direction="inline" gap="small-200">
              <s-button
                variant="primary"
                loading={flag(submitting)}
                onClick={() => {
                  const capacities: Record<string, number | null> = {};
                  for (const [slotValue, raw] of Object.entries(
                    draft.capacities,
                  )) {
                    const trimmed = raw.trim();
                    capacities[slotValue] =
                      trimmed === "" ? null : Number(trimmed);
                  }
                  // Sends the drafted blocked slots and capacities even when the whole day is
                  // blocked, because saveDayOverride treats the payload as the full state of
                  // that date.
                  submitOp("saveDayOverride", {
                    version,
                    date: selectedDate,
                    blocked: draft.blocked,
                    blockedSlots: draft.blockedSlots,
                    capacities,
                  });
                }}
              >
                Save day
              </s-button>
              {hasStoredOverride && (
                <s-button
                  tone="critical"
                  loading={flag(submitting)}
                  onClick={() =>
                    submitOp("clearDayOverride", {
                      version,
                      date: selectedDate,
                    })
                  }
                >
                  Clear overrides
                </s-button>
              )}
              <s-button onClick={() => selectDate(null)}>Close</s-button>
            </s-stack>
          </s-stack>
        )}

        {upcoming.length > 0 && (
          <s-stack gap="small">
            <s-divider />
            <s-heading>Upcoming overrides</s-heading>
            <s-stack gap="small-200">
              {upcoming.map((entry) => (
                <s-stack
                  key={entry.date}
                  direction="inline"
                  gap="small-200"
                  alignItems="center"
                >
                  <s-button
                    variant="tertiary"
                    onClick={() => selectDate(entry.date)}
                  >
                    {formatDateLabel(entry.date)}
                  </s-button>
                  {entry.blocked && <s-badge tone="critical">Blocked</s-badge>}
                  {entry.blockedSlots.map((slotValue) => (
                    <s-badge key={slotValue} tone="warning">
                      {`${slotValue} blocked`}
                    </s-badge>
                  ))}
                  {entry.capacities.map(({ slotValue, capacity, booked }) => (
                    <s-badge
                      key={slotValue}
                      tone={booked >= capacity ? "critical" : "info"}
                    >
                      {`${slotValue}: ${booked}/${capacity}`}
                    </s-badge>
                  ))}
                </s-stack>
              ))}
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
