// Modal to change the delivery date and time slot of one or more orders ("Update delivery
// slot"). Shows the available slots from the schedule rules and warns about past dates and
// slots that would exceed their capacity. The parent submits the `reschedule` action.

import { useEffect, useMemo, useRef, useState } from "react";
import type { RescheduleRulesData } from "../../routes/app.orders_.reschedule-rules";
import { findSlotOverrideKey, slotValuesMatch } from "../../lib/slot-value";
import { getShopLocalDate } from "../../lib/delivery-availability";
import { isCompleteIsoDate } from "../../lib/date-field";
import { flag } from "../../lib/web-component-props";
import { AppModal } from "../ui/AppModal";

// "Update delivery slot" modal (Phase 4) — one date+slot applied to N target
// orders. Serves both the bulk-actions bar (selection) and the details
// panel's single-order action. Merchant path = administrative override (§5):
// only data-integrity problems (blocked date/slot, unknown slot) hard-block
// here; capacity overload renders as an explicit warn+confirm step (REC-4).
export interface RescheduleTarget {
  id: string;
  name: string;
  currentDate: string | null;
  currentSlot: string | null;
}

export interface RescheduleCapacityInfo {
  capacity: number;
  booked: number;
  moving: number;
  projected: number;
}

export interface RescheduleModalProps {
  open: boolean;
  onClose: () => void;
  targets: RescheduleTarget[];
  isSubmitting: boolean;
  rules: RescheduleRulesData | null;
  rulesLoading: boolean;
  // Server-side capacity backstop (action responded capacity_override_required
  // because the client's booked counts were stale).
  serverCapacity: RescheduleCapacityInfo | null;
  onConfirm: (
    date: string,
    timeSlot: string,
    override: boolean,
    notifyCustomer: boolean,
  ) => void;
}

export function RescheduleModal({
  open,
  onClose,
  targets,
  isSubmitting,
  rules,
  rulesLoading,
  serverCapacity,
  onConfirm,
}: RescheduleModalProps) {
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState("");
  // Default ON: a merchant-side move is the one schedule change the customer
  // did not make themselves, so silence is the surprising option.
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  // The server capacity warning belongs to one specific submit — remember
  // what was submitted so editing the date/slot afterwards drops the warning.
  const [lastSubmitted, setLastSubmitted] = useState<{
    date: string;
    slot: string;
  } | null>(null);

  // Reset (and prefill for a single target) each time the modal opens.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const single = targets.length === 1 ? targets[0] : null;
      setDate(single?.currentDate ?? "");
      setSlot(single?.currentSlot ?? "");
      setLastSubmitted(null);
    }
    wasOpenRef.current = open;
  }, [open, targets]);

  const dateBlocked = Boolean(
    rules && date && rules.disabledDates.includes(date),
  );

  // Config override keys can carry drifted spellings ("9am - 12pm" vs the
  // configured "9AM-12PM") — the server resolves them canonically
  // (findSlotOverrideKey, §4.2), so this display must too, or a blocked/full
  // slot shows as clean here and the merchant only learns from the submit's
  // 400/409.
  const slotOptions = useMemo(() => {
    const disabledForDate = rules?.disabledSlots?.[date] ?? [];
    const caps = rules?.slotCapacity?.[date];
    const options = (rules?.slots ?? []).map((s) => {
      const capKey = caps ? findSlotOverrideKey(Object.keys(caps), s.value) : null;
      const cap = capKey == null ? undefined : caps?.[capKey];
      const blocked = findSlotOverrideKey(disabledForDate, s.value) != null;
      const suffix = blocked
        ? " — blocked"
        : cap
          ? ` — ${cap.booked}/${cap.capacity} booked`
          : "";
      return {
        label: `${s.display}${suffix}`,
        value: s.value,
        disabled: blocked,
      };
    });
    return [{ label: "Select a time slot", value: "", disabled: true }, ...options];
  }, [rules, date]);

  // Client-side projected load (REC-4): orders already in the target
  // date+slot don't count against the remaining capacity. The slot half of
  // "already there" uses the same canonical comparison the server does —
  // a raw compare treats a drifted stored spelling as a move.
  const clientCapacity = useMemo<RescheduleCapacityInfo | null>(() => {
    const caps = rules?.slotCapacity?.[date];
    const capKey =
      caps && slot ? findSlotOverrideKey(Object.keys(caps), slot) : null;
    const cap = capKey == null ? undefined : caps?.[capKey];
    if (!cap) return null;
    const moving = targets.filter(
      (t) => t.currentDate !== date || !slotValuesMatch(t.currentSlot, slot),
    ).length;
    return {
      capacity: Number(cap.capacity),
      booked: Number(cap.booked),
      moving,
      projected: Number(cap.booked) + moving,
    };
  }, [rules, date, slot, targets]);

  // Administrative override deliberately allows any date (§5) — but a PAST
  // date is almost always a typo'd year, and the order would quietly leave
  // the Today/Tomorrow views as overdue. Warn, never block.
  const shopTodayISO = rules ? getShopLocalDate(rules.timezone) : "";
  const dateInPast = Boolean(
    shopTodayISO && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < shopTodayISO,
  );

  const serverWarningActive = Boolean(
    serverCapacity &&
      lastSubmitted &&
      lastSubmitted.date === date &&
      lastSubmitted.slot === slot,
  );
  const capacityWarning = serverWarningActive
    ? serverCapacity
    : clientCapacity &&
        clientCapacity.moving > 0 &&
        clientCapacity.projected > clientCapacity.capacity
      ? clientCapacity
      : null;

  const targetCount = targets.length;
  const targetLabel =
    targetCount === 1
      ? `order ${targets[0].name}`
      : `${targetCount} orders`;
  const slotBlocked = Boolean(
    slot && findSlotOverrideKey(rules?.disabledSlots?.[date] ?? [], slot) != null,
  );
  const canSubmit =
    !isSubmitting &&
    targetCount > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Boolean(slot) &&
    !dateBlocked &&
    !slotBlocked &&
    rules !== null;

  const handleConfirm = () => {
    setLastSubmitted({ date, slot });
    onConfirm(date, slot, Boolean(capacityWarning), notifyCustomer);
  };

  // Takes the date field's text. Only an empty value or a finished date is kept, so
  // half-typed dates do not reach the rest of the form.
  const handleDateInput = (value: string) => {
    if (value === "" || isCompleteIsoDate(value)) setDate(value);
  };

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Update delivery slot"
      primaryAction={{
        content: isSubmitting
          ? "Updating…"
          : capacityWarning
            ? `Reschedule anyway (${capacityWarning.projected}/${capacityWarning.capacity})`
            : "Update delivery",
        onAction: handleConfirm,
        destructive: Boolean(capacityWarning),
        loading: isSubmitting,
        disabled: !canSubmit,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-stack gap="base">
        <s-paragraph>
          Set a new delivery date and time slot for {targetLabel}.
        </s-paragraph>
        {rulesLoading && (
          <s-paragraph color="subdued">Loading delivery settings…</s-paragraph>
        )}
        {!rulesLoading && rules === null && (
          <s-banner tone="critical">
            Couldn’t load the delivery settings. Close this dialog and try again.
          </s-banner>
        )}
        <s-date-field
          label="Delivery date"
          value={date}
          error={
            dateBlocked
              ? "That date is blocked in the delivery settings."
              : undefined
          }
          details="Customer limits (cutoff, lead time, reschedule lock) don’t apply here."
          onInput={(e) => handleDateInput(e.currentTarget.value)}
        />
        {dateInPast && (
          <s-banner tone="warning" heading="This date is in the past">
            {date} is before today ({shopTodayISO}). The order will show as
            overdue. Check the year before you confirm.
          </s-banner>
        )}
        <s-select
          label="Time slot"
          value={slot}
          disabled={flag(rules === null)}
          error={
            slotBlocked
              ? "That time slot is blocked for the selected date."
              : undefined
          }
          onInput={(e) => setSlot(e.currentTarget.value)}
        >
          {slotOptions.map((option) => (
            <s-option
              key={option.value}
              value={option.value}
              disabled={flag(option.disabled)}
            >
              {option.label}
            </s-option>
          ))}
        </s-select>
        {capacityWarning && (
          <s-banner tone="warning" heading="This slot will exceed its capacity">
            {date} {slot} is at {capacityWarning.booked}/
            {capacityWarning.capacity}. Moving {capacityWarning.moving}{" "}
            {capacityWarning.moving === 1 ? "order" : "orders"} puts it at{" "}
            {capacityWarning.projected}/{capacityWarning.capacity}. Confirm to
            go over the limit.
          </s-banner>
        )}
        <s-checkbox
          label="Email the customer about the new schedule"
          checked={flag(notifyCustomer)}
          disabled={flag(isSubmitting)}
          details="Sent from your business mailbox. Orders without an email are skipped."
          onInput={(e) => setNotifyCustomer(e.currentTarget.checked)}
        />
      </s-stack>
    </AppModal>
  );
}
