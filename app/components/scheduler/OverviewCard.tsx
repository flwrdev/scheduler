// Scheduler card with the summary: number of slots, blocked dates, capacity-tracked days and
// slots at or near capacity, and a button to refresh the booked counts.

import { buildSchedulerOverview } from "../../lib/scheduler-overview";
import { flag } from "../../lib/web-component-props";
import { SectionHeader } from "../ui/SectionHeader";
import type { SchedulerPageState } from "./op-plumbing";
import { formatDateLabel, useSchedulerOp } from "./op-plumbing";

// One number with a small grey label above it.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <s-stack gap="small-500">
      <s-paragraph color="subdued">{label}</s-paragraph>
      <s-paragraph fontSize="large" fontWeight="semibold">
        {value}
      </s-paragraph>
    </s-stack>
  );
}

export function OverviewCard({
  state,
  onSync,
  onSelectDate,
}: {
  state: SchedulerPageState;
  onSync: (state: SchedulerPageState) => void;
  onSelectDate: (date: string) => void;
}) {
  const { rules, countsMeta, today } = state;
  const overview = buildSchedulerOverview(rules, today);
  const { submitOp, submitting } = useSchedulerOp({
    onSync,
    successMessage: () => "Live counts refreshed",
  });

  // A short note about how fresh the booked counts are. Partial counts are never called "Live".
  const countsCaption =
    (countsMeta.status === "ok" || countsMeta.status === "partial") &&
    countsMeta.fetchedAt
      ? `${countsMeta.status === "partial" ? "Partial" : "Live"} counts ${
          countsMeta.fromCache ? "cached" : "refreshed"
        } ${new Date(countsMeta.fetchedAt).toLocaleTimeString()}`
      : countsMeta.status === "untracked"
        ? "No capacity-tracked dates yet"
        : null;

  return (
    <s-section>
      <s-stack gap="base">
        <SectionHeader
          title="Overview"
          action={
            <s-stack direction="inline" alignItems="center" gap="small">
              {countsCaption && (
                <s-text color="subdued">{countsCaption}</s-text>
              )}
              <s-button
                loading={flag(submitting)}
                onClick={() => submitOp("refreshCounts", {})}
              >
                Refresh counts
              </s-button>
            </s-stack>
          }
        />

        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))"
          gap="base"
        >
          <Stat label="Delivery slots" value={String(overview.slotCount)} />
          <Stat
            label="Blocked dates"
            value={String(overview.blockedDateCount)}
          />
          <Stat
            label="Capacity days"
            value={String(overview.trackedCapacityDayCount)}
          />
          <Stat
            label="At capacity"
            value={`${overview.fullCount} full / ${overview.nearLimitCount} near`}
          />
        </s-grid>

        {overview.watchlist.length > 0 && (
          <s-stack gap="small">
            <s-heading>Capacity watchlist</s-heading>
            <s-stack gap="small">
              {overview.watchlist.map((entry) => (
                <s-stack
                  key={`${entry.date}-${entry.slotValue}`}
                  direction="inline"
                  gap="base"
                  alignItems="center"
                >
                  <div style={{ minWidth: "150px" }}>
                    <s-button
                      variant="tertiary"
                      onClick={() => onSelectDate(entry.date)}
                    >
                      {`${formatDateLabel(entry.date)} · ${entry.slotValue}`}
                    </s-button>
                  </div>
                  <s-badge tone={entry.status.tone}>{entry.status.label}</s-badge>
                  <div style={{ flexGrow: 1, minWidth: "120px" }}>
                    <s-progress
                      value={entry.utilizationPercent}
                      max={100}
                      tone={entry.status.label === "Full" ? "critical" : "auto"}
                      accessibilityLabel={`${entry.booked} of ${entry.capacity} booked`}
                    />
                  </div>
                  <s-text color="subdued">
                    {`${entry.booked} of ${entry.capacity} booked`}
                  </s-text>
                </s-stack>
              ))}
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
