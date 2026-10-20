// Delivery Scheduler page (/app/scheduler). It shows the overview, delivery settings, time
// slots, date overrides and quick replies as cards.
// Loader: reads the schedule rules and the booked counts.
// Action: runs one small save operation at a time (scheduler-ops.server.ts). Each save carries
// the version the page loaded, and every answer is a 200 response with an `ok` flag.

import { useCallback, useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import { useLoaderData, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  getScheduleRulesDetailed,
  type BookedCountsTruncation,
  type ScheduleRulesDetailed,
} from "../services/schedule-rules.server";
import {
  getTodayInTimezone,
  runSchedulerOp,
} from "../services/scheduler-ops.server";
import { DayOverridesCard } from "../components/scheduler/DayOverridesCard";
import { OverviewCard } from "../components/scheduler/OverviewCard";
import { QuickRepliesCard } from "../components/scheduler/QuickRepliesCard";
import { SettingsCard } from "../components/scheduler/SettingsCard";
import { SlotsCard } from "../components/scheduler/SlotsCard";
import type {
  SchedulerActionResponse,
  SchedulerPageState,
} from "../components/scheduler/op-plumbing";

const DAY_OVERRIDES_ANCHOR_ID = "scheduler-day-overrides";

// Why a "partial" counts scan came back short, in merchant language.
const COUNTS_CAP_LABELS: Record<BookedCountsTruncation["caps"][number], string> =
  {
    dates: "more capacity-tracked dates than one scan covers",
    pages: "more orders on one date range than one scan pages through",
  };
// Enough dates for the merchant to act on without a wall of text in the banner.
const MAX_LISTED_AFFECTED_DATES = 8;

function describeCountsCaps(truncation: BookedCountsTruncation | undefined) {
  if (!truncation?.caps.length) {
    return null;
  }
  return truncation.caps.map((cap) => COUNTS_CAP_LABELS[cap]).join(" and ");
}

function describeAffectedDates(truncation: BookedCountsTruncation | undefined) {
  const dates = truncation?.affectedDates ?? [];
  if (!dates.length) {
    return null;
  }
  const listed = dates.slice(0, MAX_LISTED_AFFECTED_DATES);
  const rest = dates.length - listed.length;
  return `${dates.length} date${dates.length === 1 ? "" : "s"} affected: ${listed.join(
    ", ",
  )}${rest > 0 ? `, +${rest} more` : ""}`;
}

function getSessionShop(session: { shop?: string } | undefined) {
  return typeof session?.shop === "string" && session.shop
    ? session.shop
    : undefined;
}

function toPageState(detailed: ScheduleRulesDetailed): SchedulerPageState {
  return {
    rules: detailed.rules,
    version: detailed.version,
    configHealth: detailed.configHealth,
    countsMeta: detailed.countsMeta,
    today: getTodayInTimezone(detailed.rules.timezone),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = getSessionShop(session);
  const detailed = await getScheduleRulesDetailed(shop, admin);

  return Response.json(toPageState(detailed), {
    headers: { "Cache-Control": "no-store" },
  });
};

// The ?date= day panel is pure URL state — switching days must not refetch
// (and must not reset unrelated section drafts).
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const current = new URLSearchParams(currentUrl.search);
  const next = new URLSearchParams(nextUrl.search);
  current.delete("date");
  next.delete("date");
  if (
    currentUrl.pathname === nextUrl.pathname &&
    current.toString() === next.toString()
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = getSessionShop(session);

  if (request.method.toUpperCase() !== "POST") {
    return Response.json(
      { ok: false, op: "", code: "error", message: "Method not allowed." },
      { status: 405 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({
      ok: false,
      op: "",
      code: "error",
      message: "Request body must be a JSON object.",
    } satisfies SchedulerActionResponse);
  }

  const op = typeof body.op === "string" ? body.op : "";

  if (!shop) {
    return Response.json({
      ok: false,
      op,
      code: "error",
      message: "No shop session. Reload the page.",
    } satisfies SchedulerActionResponse);
  }

  try {
    if (op === "refreshCounts") {
      const detailed = await getScheduleRulesDetailed(shop, admin, {
        bypassCountsCache: true,
      });
      return Response.json(
        { ok: true, op, ...toPageState(detailed) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const version = body.version;
    if (typeof version !== "number" || !Number.isInteger(version)) {
      return Response.json({
        ok: false,
        op,
        code: "error",
        message: "Missing config version. Reload the page.",
      } satisfies SchedulerActionResponse);
    }

    const result = await runSchedulerOp(shop, op, body, version);

    if (result.ok) {
      // Re-read through the detailed path so the response carries booked
      // counts + health, exactly like the loader.
      const detailed = await getScheduleRulesDetailed(shop, admin);
      return Response.json(
        { ok: true, op, ...toPageState(detailed) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (result.code === "stale_config") {
      const detailed = await getScheduleRulesDetailed(shop, admin);
      return Response.json({
        ok: false,
        op,
        code: "stale_config",
        ...toPageState(detailed),
      } satisfies SchedulerActionResponse);
    }

    if (result.code === "unknown_op") {
      return Response.json({
        ok: false,
        op,
        code: "unknown_op",
        message: `Unknown action "${op}".`,
      } satisfies SchedulerActionResponse);
    }

    return Response.json({
      ok: false,
      op,
      code: "validation",
      fieldErrors: result.fieldErrors,
    } satisfies SchedulerActionResponse);
  } catch (error) {
    // ADR-11: never bubble a raw 5xx through the embedded fetcher.
    console.error(`Scheduler op "${op}" failed:`, error);
    return Response.json({
      ok: false,
      op,
      code: "error",
      message: "Saving failed upstream. Try again.",
    } satisfies SchedulerActionResponse);
  }
};

export default function SchedulerPage() {
  const loaderData = useLoaderData() as SchedulerPageState;
  const [state, setState] = useState<SchedulerPageState>(loaderData);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedDate = searchParams.get("date");

  // Loader revalidation (after saves or on navigation) refreshes page state;
  // section drafts survive via per-section remount keys below.
  useEffect(() => {
    setState(loaderData);
  }, [loaderData]);

  const onSync = useCallback((next: SchedulerPageState) => {
    setState(next);
  }, []);

  const onSelectDate = useCallback(
    (date: string | null, options?: { scrollIntoView?: boolean }) => {
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          if (date) {
            params.set("date", date);
          } else {
            params.delete("date");
          }
          return params;
        },
        { replace: true, preventScrollReset: true },
      );
      // Overview chips deep-link into the day panel, which lives at the
      // bottom of the page — without this the panel opens out of view.
      if (date && options?.scrollIntoView) {
        requestAnimationFrame(() => {
          document
            .getElementById(DAY_OVERRIDES_ANCHOR_ID)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    },
    [setSearchParams],
  );

  const countsCapsLabel = describeCountsCaps(state.countsMeta.truncation);
  const countsAffectedLabel = describeAffectedDates(state.countsMeta.truncation);

  const settingsKey = [
    state.rules.timezone,
    state.rules.cutoffHour,
    state.rules.prepHours,
    state.rules.maxDays,
  ].join("|");
  const slotsKey = JSON.stringify(state.rules.slots);
  // CONFIG only — `slotCapacity[date][slot]` also carries the LIVE `booked`
  // count, and every op response (and "Refresh counts") re-reads it, so keying
  // on the whole entry remounted the day panel whenever a new order landed and
  // wiped the merchant's half-typed edits (DEF-11: no cross-section form
  // wipes). A real config change from another surface — the stored cap, the
  // day block, a blocked slot — still changes the key and still remounts.
  const dayCapacityConfig = selectedDate
    ? Object.entries(state.rules.slotCapacity[selectedDate] ?? {}).map(
        ([slotValue, entry]) => [slotValue, entry.capacity] as const,
      )
    : null;
  const dayKey = `${selectedDate ?? ""}|${JSON.stringify({
    blocked: selectedDate
      ? state.rules.disabledDates.includes(selectedDate)
      : null,
    slots: selectedDate ? state.rules.disabledSlots[selectedDate] : null,
    capacity: dayCapacityConfig,
  })}`;

  return (
    <s-page heading="Delivery Scheduler" inlineSize="small">
      <s-stack gap="base">
        {state.configHealth.length > 0 && (
          <s-banner tone="critical" heading="Stored settings need attention">
            <s-stack gap="small-500">
              {state.configHealth.map((issue) => (
                <s-paragraph key={`${issue.column}-${issue.message}`}>
                  {issue.column}: {issue.message}
                </s-paragraph>
              ))}
            </s-stack>
          </s-banner>
        )}
        {state.countsMeta.status === "error" && (
          <s-banner tone="warning" heading="Live booked counts are unavailable">
            Capacity limits are not being checked against live orders right
            now. Counts will recover automatically — or press “Refresh counts”.
          </s-banner>
        )}
        {state.countsMeta.status === "partial" && (
          <s-banner tone="warning" heading="Live booked counts are incomplete">
            <s-stack gap="small-500">
              <s-paragraph>
                {`The order scan hit a limit${
                  countsCapsLabel ? ` (${countsCapsLabel})` : ""
                }, so booked counts are a lower bound right now — a window that is already full can still show as open, and checkouts into it are not being blocked.`}
              </s-paragraph>
              {countsAffectedLabel && (
                <s-paragraph>{countsAffectedLabel}</s-paragraph>
              )}
            </s-stack>
          </s-banner>
        )}

        <OverviewCard
          state={state}
          onSync={onSync}
          onSelectDate={(date) => onSelectDate(date, { scrollIntoView: true })}
        />
        <SettingsCard key={settingsKey} state={state} onSync={onSync} />
        <SlotsCard key={slotsKey} state={state} onSync={onSync} />
        <div id={DAY_OVERRIDES_ANCHOR_ID}>
          <DayOverridesCard
            key={dayKey}
            state={state}
            selectedDate={selectedDate}
            onSelectDate={onSelectDate}
            onSync={onSync}
          />
        </div>
        <QuickRepliesCard />
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) =>
  boundary.headers(headersArgs);
