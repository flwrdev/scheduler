// Refreshes the Orders page in the background by re-running the route loader (every 20 minutes).
// The mailbox is read again after each refresh. A refresh is held back while a modal is open,
// an action is running or the browser tab is hidden, then runs once it is safe.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

// Smart auto-refresh for /app/orders (Orders Ops V2 §6). Re-runs the route
// loader via useRevalidator — no navigation, so URL state (tab / filters /
// sort / cursors / ?order=) is preserved for free, and the background refresh
// is deliberately invisible (no loading bar; only the manual Refresh button
// shows a spinner).
//
// Cadence: 20 min on every view. A tick is suppressed and
// QUEUED while the merchant is mid-task (`paused` — any modal open or an
// action fetcher in flight) or the browser tab is hidden; the queued tick
// fires once the blocker lifts. Any loader settle (navigation, React
// Router's automatic post-action revalidation, or this hook's own refresh)
// resets the "Last updated" stamp and drops the queued tick — the data is
// already fresh at that point.

const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;
const TODAY_INTERVAL_MS = 20 * 60 * 1000;

export interface UseSmartRefreshOptions {
  isTodayView: boolean;
  paused: boolean;
  /** Loader data object — a new identity on every loader settle. */
  dataStamp: unknown;
}

export function useSmartRefresh({
  isTodayView,
  paused,
  dataStamp,
}: UseSmartRefreshOptions) {
  const revalidator = useRevalidator();
  // useRevalidator returns a new object per render; the interval callback
  // reads it through a ref so the timer never holds a stale closure.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const pausedRef = useRef(paused);
  const queuedRef = useRef(false);

  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(() => Date.now());

  // Re-render every 30s so the relative "Updated X min ago" label stays live.
  const [, setLabelTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setLabelTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Every loader settle produces a new loaderData identity → stamp + dequeue.
  useEffect(() => {
    setLastUpdatedAt(Date.now());
    queuedRef.current = false;
  }, [dataStamp]);

  const refresh = useCallback(() => {
    if (revalidatorRef.current.state === "idle") {
      revalidatorRef.current.revalidate();
    }
  }, []);

  const attemptTick = useCallback(() => {
    if (pausedRef.current || document.visibilityState === "hidden") {
      queuedRef.current = true;
      return;
    }
    refresh();
  }, [refresh]);

  useEffect(() => {
    const ms = isTodayView ? TODAY_INTERVAL_MS : DEFAULT_INTERVAL_MS;
    const id = window.setInterval(attemptTick, ms);
    return () => window.clearInterval(id);
  }, [isTodayView, attemptTick]);

  // Unpause → fire the queued tick (if the tab is also visible).
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && queuedRef.current && document.visibilityState !== "hidden") {
      queuedRef.current = false;
      refresh();
    }
  }, [paused, refresh]);

  // Resume on focus: a tick that landed while the tab was hidden fires now.
  useEffect(() => {
    const onVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        queuedRef.current &&
        !pausedRef.current
      ) {
        queuedRef.current = false;
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  const ageSec = Math.max(0, Math.floor((Date.now() - lastUpdatedAt) / 1000));
  const lastUpdatedLabel =
    ageSec < 60
      ? "Updated just now"
      : ageSec < 3600
        ? `Updated ${Math.floor(ageSec / 60)} min ago`
        : `Updated at ${new Date(lastUpdatedAt).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })}`;

  return {
    lastUpdatedLabel,
    refresh,
    isRefreshing: revalidator.state === "loading",
  };
}
