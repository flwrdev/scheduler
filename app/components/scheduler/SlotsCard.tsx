// Scheduler card to manage the time slots: add, rename the display label, reorder and delete.
// A slot's time range cannot be edited; to change times, add a new slot and delete the old one.

import { useMemo, useState } from "react";

import type { DeliveryScheduleRules } from "../../lib/delivery-availability";
import {
  generateSlotValue,
  isSlotRangeOrdered,
  parseSlotValueToTimes,
  type SlotTimePart,
} from "../../lib/slot-times";
import { flag } from "../../lib/web-component-props";
import { AppModal } from "../ui/AppModal";
import { SectionHeader } from "../ui/SectionHeader";
import type { SchedulerPageState } from "./op-plumbing";
import { formatDateLabel, useSchedulerOp } from "./op-plumbing";

const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTE_OPTIONS = ["00", "15", "30", "45"];
const MERIDIEM_OPTIONS = ["AM", "PM"];

interface TimeDraft {
  hour: string;
  minute: string;
  meridiem: "AM" | "PM";
}

// Turns the text drafted in the pickers into the time parts the slot helpers expect.
function toTimePart(draft: TimeDraft): SlotTimePart {
  return {
    hour: Number(draft.hour),
    minute: Number(draft.minute),
    meridiem: draft.meridiem,
  };
}

// Three drop-downs (hour, minute, AM/PM) that together pick one time.
function TimePartPicker({
  label,
  draft,
  onChange,
}: {
  label: string;
  draft: TimeDraft;
  onChange: (draft: TimeDraft) => void;
}) {
  return (
    <s-stack gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-stack direction="inline" gap="small-200">
        <s-select
          label={`${label} hour`}
          labelAccessibilityVisibility="exclusive"
          value={draft.hour}
          onInput={(e) => onChange({ ...draft, hour: e.currentTarget.value })}
        >
          {HOUR_OPTIONS.map((hour) => (
            <s-option key={hour} value={hour}>
              {hour}
            </s-option>
          ))}
        </s-select>
        <s-select
          label={`${label} minute`}
          labelAccessibilityVisibility="exclusive"
          value={draft.minute}
          onInput={(e) => onChange({ ...draft, minute: e.currentTarget.value })}
        >
          {MINUTE_OPTIONS.map((minute) => (
            <s-option key={minute} value={minute}>
              {minute}
            </s-option>
          ))}
        </s-select>
        <s-select
          label={`${label} meridiem`}
          labelAccessibilityVisibility="exclusive"
          value={draft.meridiem}
          onInput={(e) =>
            onChange({
              ...draft,
              meridiem: e.currentTarget.value as "AM" | "PM",
            })
          }
        >
          {MERIDIEM_OPTIONS.map((meridiem) => (
            <s-option key={meridiem} value={meridiem}>
              {meridiem}
            </s-option>
          ))}
        </s-select>
      </s-stack>
    </s-stack>
  );
}

// Lists the dates from today on that have a blocked-slot or capacity setting for this slot.
function affectedOverrides(
  rules: DeliveryScheduleRules,
  slotValue: string,
  today: string,
): string[] {
  const dates = new Set<string>();
  for (const [date, values] of Object.entries(rules.disabledSlots)) {
    if (date >= today && values.includes(slotValue)) {
      dates.add(date);
    }
  }
  for (const [date, capacities] of Object.entries(rules.slotCapacity)) {
    if (date >= today && slotValue in capacities) {
      dates.add(date);
    }
  }
  return [...dates].sort();
}

export function SlotsCard({
  state,
  onSync,
}: {
  state: SchedulerPageState;
  onSync: (state: SchedulerPageState) => void;
}) {
  const { rules, version, today } = state;
  const [displayDrafts, setDisplayDrafts] = useState<Record<string, string>>(
    {},
  );
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<{
    start: TimeDraft;
    end: TimeDraft;
    display: string;
  }>({
    start: { hour: "9", minute: "00", meridiem: "AM" },
    end: { hour: "12", minute: "00", meridiem: "PM" },
    display: "",
  });

  const { submitOp, submitting, fieldErrors } = useSchedulerOp({
    onSync,
    successMessage: (op) =>
      op === "deleteSlot"
        ? "Slot deleted"
        : op === "createSlot"
          ? "Slot added"
          : "Slots updated",
    onSuccess: (response) => {
      setDeleteTarget(null);
      setDisplayDrafts({});
      if (response.op === "createSlot") {
        setAddOpen(false);
        setAddDraft((d) => ({ ...d, display: "" }));
      }
    },
  });

  const addRange = useMemo(
    () => ({ start: toTimePart(addDraft.start), end: toTimePart(addDraft.end) }),
    [addDraft.start, addDraft.end],
  );
  const addPreview = generateSlotValue(addRange);
  const addRangeInvalid = !isSlotRangeOrdered(addRange);

  const deleteDates = deleteTarget
    ? affectedOverrides(rules, deleteTarget, today)
    : [];

  // Moves the slot at `index` one place up (-1) or down (1) and saves the new order.
  function moveSlot(index: number, delta: -1 | 1) {
    const order = rules.slots.map((s) => s.value);
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    submitOp("reorderSlots", { version, order });
  }

  return (
    <s-section>
      <s-stack gap="base">
        <SectionHeader
          title="Time slots"
          description="Checkout shows these windows in this order. Times are fixed once created — to change times, add a new slot and delete the old one."
          action={
            <s-button onClick={() => setAddOpen((open) => !open)}>
              {addOpen ? "Cancel" : "Add slot"}
            </s-button>
          }
        />

        {addOpen && (
          <s-box background="subdued" padding="base" borderRadius="base">
            <s-stack gap="small">
              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
                gap="base"
              >
                <TimePartPicker
                  label="Start"
                  draft={addDraft.start}
                  onChange={(start) => setAddDraft((d) => ({ ...d, start }))}
                />
                <TimePartPicker
                  label="End"
                  draft={addDraft.end}
                  onChange={(end) => setAddDraft((d) => ({ ...d, end }))}
                />
              </s-grid>
              <s-text-field
                label="Display label"
                autocomplete="off"
                value={addDraft.display}
                placeholder={addPreview}
                error={fieldErrors.display}
                details={`Slot value will be ${addPreview}`}
                onInput={(e) => {
                  const display = e.currentTarget.value;
                  setAddDraft((d) => ({ ...d, display }));
                }}
              />
              {(addRangeInvalid || fieldErrors.start || fieldErrors.end) && (
                <s-text tone="critical">
                  {fieldErrors.start ??
                    fieldErrors.end ??
                    "End time must be after the start time."}
                </s-text>
              )}
              <s-stack direction="inline">
                <s-button
                  variant="primary"
                  loading={flag(submitting)}
                  disabled={flag(addRangeInvalid || submitting)}
                  onClick={() =>
                    submitOp("createSlot", {
                      version,
                      start: toTimePart(addDraft.start),
                      end: toTimePart(addDraft.end),
                      display: addDraft.display,
                    })
                  }
                >
                  Add slot
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        )}

        <s-stack gap="small">
          {rules.slots.map((slot, index) => {
            const structured = parseSlotValueToTimes(slot.value);
            const draft = displayDrafts[slot.value] ?? slot.display;
            const displayDirty = draft !== slot.display;

            return (
              <s-stack key={slot.value} gap="small-200">
                {index > 0 && <s-divider />}
                {!structured && (
                  <s-banner tone="warning">
                    The value “{slot.value}” can’t be read as a time range, so
                    customers can never book it. Delete it and add a structured
                    slot in its place.
                  </s-banner>
                )}
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="end"
                  justifyContent="space-between"
                >
                  <s-stack direction="inline" gap="small-200" alignItems="end">
                    <div style={{ minWidth: "200px", flexGrow: 1 }}>
                      <s-text-field
                        label="Display label"
                        autocomplete="off"
                        value={draft}
                        error={displayDirty ? fieldErrors.display : undefined}
                        onInput={(e) => {
                          const value = e.currentTarget.value;
                          setDisplayDrafts((drafts) => ({
                            ...drafts,
                            [slot.value]: value,
                          }));
                        }}
                      />
                    </div>
                    {displayDirty && (
                      <s-button
                        loading={flag(submitting)}
                        onClick={() =>
                          submitOp("updateSlotDisplay", {
                            version,
                            value: slot.value,
                            display: draft,
                          })
                        }
                      >
                        Save
                      </s-button>
                    )}
                  </s-stack>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-badge tone={structured ? "info" : "critical"}>
                      {slot.value}
                    </s-badge>
                    <s-stack direction="inline" gap="small-200">
                      <s-button
                        accessibilityLabel={`Move ${slot.display} up`}
                        disabled={flag(index === 0 || submitting)}
                        onClick={() => moveSlot(index, -1)}
                      >
                        ↑
                      </s-button>
                      <s-button
                        accessibilityLabel={`Move ${slot.display} down`}
                        disabled={flag(
                          index === rules.slots.length - 1 || submitting,
                        )}
                        onClick={() => moveSlot(index, 1)}
                      >
                        ↓
                      </s-button>
                      <s-button
                        tone="critical"
                        disabled={flag(rules.slots.length <= 1 || submitting)}
                        onClick={() => setDeleteTarget(slot.value)}
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-stack>
              </s-stack>
            );
          })}
        </s-stack>
      </s-stack>

      <AppModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete slot ${deleteTarget ?? ""}?`}
        primaryAction={{
          content: "Delete slot",
          destructive: true,
          loading: submitting,
          onAction: () =>
            deleteTarget &&
            submitOp("deleteSlot", { version, value: deleteTarget }),
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteTarget(null) },
        ]}
      >
        <s-stack gap="small-200">
          <s-paragraph>
            Customers will no longer see this window at checkout.
          </s-paragraph>
          {deleteDates.length > 0 ? (
            <s-paragraph tone="caution">
              This also removes its blocked-slot and capacity overrides on:{" "}
              {deleteDates.map(formatDateLabel).join(", ")}.
            </s-paragraph>
          ) : (
            <s-paragraph color="subdued">
              No date overrides reference this slot.
            </s-paragraph>
          )}
        </s-stack>
      </AppModal>
    </s-section>
  );
}
