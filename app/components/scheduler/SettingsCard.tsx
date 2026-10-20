// Scheduler card for the general rules: timezone, same-day cutoff hour, preparation time and
// booking window in days.

import { useMemo, useState } from "react";

import { flag } from "../../lib/web-component-props";
import { SectionHeader } from "../ui/SectionHeader";
import type { SchedulerPageState } from "./op-plumbing";
import { formatHourLabel, useSchedulerOp } from "./op-plumbing";

// Lists every timezone the browser knows. The saved timezone is added if it is missing.
function listTimezones(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return supported.includes(current) || !current
    ? supported
    : [current, ...supported];
}

export function SettingsCard({
  state,
  onSync,
}: {
  state: SchedulerPageState;
  onSync: (state: SchedulerPageState) => void;
}) {
  const { rules, version } = state;
  const [draft, setDraft] = useState({
    timezone: rules.timezone,
    cutoffHour: String(rules.cutoffHour),
    prepHours: String(rules.prepHours),
    maxDays: String(rules.maxDays),
  });

  const { submitOp, submitting, fieldErrors } = useSchedulerOp({
    onSync,
    successMessage: () => "Delivery settings saved",
  });

  const timezoneOptions = useMemo(
    () =>
      listTimezones(rules.timezone).map((zone) => ({
        label: zone.replaceAll("_", " "),
        value: zone,
      })),
    [rules.timezone],
  );
  const cutoffOptions = useMemo(
    () =>
      Array.from({ length: 24 }, (_, hour) => ({
        label: formatHourLabel(hour),
        value: String(hour),
      })),
    [],
  );

  const dirty =
    draft.timezone !== rules.timezone ||
    draft.cutoffHour !== String(rules.cutoffHour) ||
    draft.prepHours !== String(rules.prepHours) ||
    draft.maxDays !== String(rules.maxDays);

  // Changes one field of the draft. The value is read before the state update runs.
  function updateDraft(field: keyof typeof draft, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function handleSave() {
    submitOp("saveSettings", {
      version,
      timezone: draft.timezone,
      cutoffHour: draft.cutoffHour.trim(),
      prepHours: draft.prepHours.trim(),
      maxDays: draft.maxDays.trim(),
    });
  }

  return (
    <s-section>
      <s-stack gap="base">
        <SectionHeader
          title="Delivery settings"
          description="Store timezone, same-day cutoff, preparation time, and how far ahead customers can book."
        />

        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
          gap="base"
        >
          <s-select
            label="Timezone"
            value={draft.timezone}
            error={fieldErrors.timezone}
            onInput={(e) => updateDraft("timezone", e.currentTarget.value)}
          >
            {timezoneOptions.map((option) => (
              <s-option key={option.value} value={option.value}>
                {option.label}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Same-day cutoff"
            value={draft.cutoffHour}
            error={fieldErrors.cutoffHour}
            details="Orders after this time start from tomorrow."
            onInput={(e) => updateDraft("cutoffHour", e.currentTarget.value)}
          >
            {cutoffOptions.map((option) => (
              <s-option key={option.value} value={option.value}>
                {option.label}
              </s-option>
            ))}
          </s-select>
          <s-number-field
            label="Preparation time (hours)"
            min={0}
            max={72}
            autocomplete="off"
            value={draft.prepHours}
            error={fieldErrors.prepHours}
            onInput={(e) => updateDraft("prepHours", e.currentTarget.value)}
          />
          <s-number-field
            label="Booking window (days)"
            min={1}
            max={120}
            autocomplete="off"
            value={draft.maxDays}
            error={fieldErrors.maxDays}
            details="How many days ahead customers can choose."
            onInput={(e) => updateDraft("maxDays", e.currentTarget.value)}
          />
        </s-grid>

        <s-stack direction="inline">
          <s-button
            variant="primary"
            onClick={handleSave}
            loading={flag(submitting)}
            disabled={flag(!dirty || submitting)}
          >
            Save settings
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
