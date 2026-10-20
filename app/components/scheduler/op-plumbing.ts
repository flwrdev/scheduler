// Shared client plumbing for the merged /app/scheduler page (Scheduler V2 §3).
// One fetcher per section; every response is 200 + {ok, …} (ADR-11) and this
// hook funnels fresh server state back to the page so only the section that
// saved resyncs (DEF-11: no cross-section form wipes).

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import type { DeliveryScheduleRules } from "../../lib/delivery-availability";
import type {
  BookedCountsMeta,
  ConfigHealthIssue,
} from "../../services/schedule-rules.server";

export interface SchedulerPageState {
  rules: DeliveryScheduleRules;
  version: number;
  configHealth: ConfigHealthIssue[];
  countsMeta: BookedCountsMeta;
  today: string;
}

export type SchedulerActionResponse =
  | ({ ok: true; op: string } & SchedulerPageState)
  | {
      ok: false;
      op: string;
      code: "validation" | "stale_config" | "unknown_op" | "error";
      message?: string;
      fieldErrors?: Record<string, string>;
      rules?: DeliveryScheduleRules;
      version?: number;
      configHealth?: ConfigHealthIssue[];
      countsMeta?: BookedCountsMeta;
      today?: string;
    };

export const STALE_CONFIG_MESSAGE =
  "Schedule settings changed in another session — this page just reloaded the latest values. Re-apply your edit.";

interface UseSchedulerOpOptions {
  /** Called with fresh server state after any response that carries it. */
  onSync: (state: SchedulerPageState) => void;
  /** Called after a fully successful op (close modals, clear drafts, …). */
  onSuccess?: (response: Extract<SchedulerActionResponse, { ok: true }>) => void;
  successMessage?: (op: string) => string | null;
}

export function useSchedulerOp({
  onSync,
  onSuccess,
  successMessage,
}: UseSchedulerOpOptions) {
  const fetcher = useFetcher<SchedulerActionResponse>();
  const shopify = useAppBridge();
  const handledRef = useRef<SchedulerActionResponse | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submitting = fetcher.state !== "idle";

  useEffect(() => {
    const data = fetcher.data;
    if (!data || fetcher.state !== "idle" || handledRef.current === data) {
      return;
    }
    handledRef.current = data;

    if (data.ok) {
      setFieldErrors({});
      onSync({
        rules: data.rules,
        version: data.version,
        configHealth: data.configHealth,
        countsMeta: data.countsMeta,
        today: data.today,
      });
      const message = successMessage?.(data.op) ?? "Saved";
      if (message) {
        shopify.toast.show(message);
      }
      onSuccess?.(data);
      return;
    }

    if (data.code === "validation") {
      setFieldErrors(data.fieldErrors ?? {});
      const first = Object.values(data.fieldErrors ?? {})[0];
      shopify.toast.show(first ?? "Check the highlighted fields.", {
        isError: true,
      });
      return;
    }

    if (data.code === "stale_config") {
      setFieldErrors({});
      if (data.rules && typeof data.version === "number") {
        onSync({
          rules: data.rules,
          version: data.version,
          configHealth: data.configHealth ?? [],
          countsMeta:
            data.countsMeta ??
            ({ status: "skipped", fetchedAt: null, fromCache: false } as BookedCountsMeta),
          today: data.today ?? new Date().toISOString().slice(0, 10),
        });
      }
      shopify.toast.show(STALE_CONFIG_MESSAGE, { isError: true });
      return;
    }

    shopify.toast.show(data.message ?? "Something went wrong. Try again.", {
      isError: true,
    });
  }, [fetcher.data, fetcher.state, onSync, onSuccess, shopify, successMessage]);

  function submitOp(op: string, input: Record<string, unknown>) {
    fetcher.submit(
      { op, ...input },
      { method: "POST", encType: "application/json" },
    );
  }

  return { submitOp, submitting, fieldErrors, setFieldErrors, fetcher };
}

export function formatHourLabel(hour: number): string {
  const meridiem = hour < 12 ? "AM" : "PM";
  const base = hour % 12 === 0 ? 12 : hour % 12;
  return `${base}:00 ${meridiem}`;
}

export function formatDateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return parsed.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
