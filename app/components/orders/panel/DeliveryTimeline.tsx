// Timeline in the order panel: reschedules, fulfilment, delivery, emails sent by the app and
// emails from the mailbox, newest first. Loads the mailbox conversation on demand from
// /app/orders/email-thread.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { MailboxMessage } from "../../../lib/email-replies";
import type { QuickReply } from "../../../lib/quick-replies";
import type { EmailThreadData } from "../../../routes/app.orders_.email-thread";
import {
  type Order,
  type RescheduleTimelineEvent,
  getAttr,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getRescheduleTimelineEvents,
  hasRescheduleTag,
  getFulfilledAt,
  getDeliveredAt,
  getEmailSentEvents,
  formatTimelineDay,
  formatTimelineDelivery,
  formatTimelineTime,
  formatTimelineStatus,
} from "../../../lib/order-utils";

function TimelineRow({ time, children }: { time: string; children: ReactNode }) {
  return (
    <div className="odp-timeline-row">
      <div className="odp-timeline-body">{children}</div>
      <span className="odp-timeline-time">
        <s-text color="subdued" fontSize="small-100">
          {time}
        </s-text>
      </span>
    </div>
  );
}

function sourceLabel(source: string): string | null {
  const s = source.trim().toLowerCase();
  if (s === "customer") return "Customer";
  if (s === "merchant") return "Merchant";
  return null;
}

type ActivityEvent =
  | { kind: "reschedule"; timestamp: string; event: RescheduleTimelineEvent }
  | { kind: "fulfilled"; timestamp: string }
  | { kind: "delivered"; timestamp: string }
  | { kind: "email"; timestamp: string; to: string }
  | { kind: "mail"; timestamp: string; message: MailboxMessage };

const EMAIL_LOG_MATCH_WINDOW_MS = 2 * 60 * 1000;

function timeValue(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  // Pushes events with an unparseable/missing timestamp (the reschedule
  // history's "—" sentinel) to the bottom, matching the prior sort behavior.
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

// An app send exists twice: as an EmailSendLog row and as its BCC copy in
// INBOX. The mailbox copy carries the subject and text, so the log row is the
// one dropped. The two-minute window absorbs SMTP delivery delay.
function isCoveredByMailbox(
  sentAt: string,
  to: string,
  mailbox: ReadonlyArray<MailboxMessage>,
): boolean {
  const ts = Date.parse(sentAt);
  if (Number.isNaN(ts)) return false;
  const recipient = to.trim().toLowerCase();
  return mailbox.some(
    (m) =>
      m.direction === "outbound" &&
      m.toAddresses.includes(recipient) &&
      Math.abs(Date.parse(m.date) - ts) <= EMAIL_LOG_MATCH_WINDOW_MS,
  );
}

function buildActivityEvents(
  order: Order,
  mailbox: ReadonlyArray<MailboxMessage>,
): ActivityEvent[] {
  const events: ActivityEvent[] = getRescheduleTimelineEvents(order).map(
    (event) => ({ kind: "reschedule", timestamp: event.requestedAt, event }),
  );

  const fulfilledAt = getFulfilledAt(order);
  if (fulfilledAt) events.push({ kind: "fulfilled", timestamp: fulfilledAt });

  const deliveredAt = getDeliveredAt(order);
  if (deliveredAt) events.push({ kind: "delivered", timestamp: deliveredAt });

  for (const { sentAt, to } of getEmailSentEvents(order)) {
    if (isCoveredByMailbox(sentAt, to, mailbox)) continue;
    events.push({ kind: "email", timestamp: sentAt, to });
  }

  for (const message of mailbox) {
    events.push({ kind: "mail", timestamp: message.date, message });
  }

  return events.sort(
    (a, b) => timeValue(b.timestamp) - timeValue(a.timestamp),
  );
}

// Events arrive sorted newest first, so each day's events are already
// adjacent and one pass is enough.
function groupByDay(events: ActivityEvent[], now: Date) {
  const groups: { label: string; events: ActivityEvent[] }[] = [];
  for (const event of events) {
    const label = formatTimelineDay(event.timestamp, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(event);
    else groups.push({ label, events: [event] });
  }
  return groups;
}

function RescheduleItem({ event }: { event: RescheduleTimelineEvent }) {
  const [open, setOpen] = useState(false);
  const from = formatTimelineDelivery(event.fromDate, event.fromTimeSlot);
  const to = formatTimelineDelivery(event.date, event.timeSlot);
  const source = sourceLabel(event.source);
  return (
    <TimelineRow time={formatTimelineTime(event.requestedAt)}>
      <s-text>
        Rescheduled to {to}
        {source && (
          <>
            {" "}
            <s-badge tone={source === "Merchant" ? "info" : undefined}>
              {source}
            </s-badge>
          </>
        )}
      </s-text>
      {open && (
        <>
          {from !== "—" && (
            <s-text color="subdued" fontSize="small">
              From {from}
            </s-text>
          )}
          <s-text color="subdued" fontSize="small">
            {formatTimelineStatus(event.status)}
          </s-text>
        </>
      )}
      <span>
        <s-button variant="tertiary" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide details" : "Details"}
        </s-button>
      </span>
    </TimelineRow>
  );
}

function MailItem({
  message,
  onView,
}: {
  message: MailboxMessage;
  onView?: (message: MailboxMessage) => void;
}) {
  const inbound = message.direction === "inbound";
  return (
    <TimelineRow time={formatTimelineTime(message.date)}>
      <s-text>
        {inbound ? "Customer emailed" : `Email sent to ${message.toAddresses.join(", ")}`}
        {inbound && message.verdict === "fail" && (
          <>
            {" "}
            <s-badge tone="warning">Unverified sender</s-badge>
          </>
        )}
      </s-text>
      <div className="odp-ellipsis">
        <s-text color="subdued" fontSize="small">
          {message.subject}
        </s-text>
      </div>
      {onView && (
        <span>
          <s-button onClick={() => onView(message)}>View email</s-button>
        </span>
      )}
    </TimelineRow>
  );
}

function ActivityItem({
  item,
  onView,
}: {
  item: ActivityEvent;
  onView?: (message: MailboxMessage) => void;
}) {
  switch (item.kind) {
    case "reschedule":
      return <RescheduleItem event={item.event} />;
    case "mail":
      return <MailItem message={item.message} onView={onView} />;
    case "fulfilled":
      return (
        <TimelineRow time={formatTimelineTime(item.timestamp)}>
          <s-text>Marked fulfilled</s-text>
        </TimelineRow>
      );
    case "delivered":
      return (
        <TimelineRow time={formatTimelineTime(item.timestamp)}>
          <s-text>Delivered</s-text>
        </TimelineRow>
      );
    case "email":
      return (
        <TimelineRow time={formatTimelineTime(item.timestamp)}>
          <s-text>Email sent to {item.to}</s-text>
        </TimelineRow>
      );
  }
}

function itemKey(item: ActivityEvent, index: number): string {
  switch (item.kind) {
    case "reschedule":
      return `reschedule-${item.event.requestedAt}-${item.event.date}-${item.event.timeSlot}-${index}`;
    case "mail":
      return `mail-${item.message.key}`;
    case "email":
      return `email-${item.timestamp}-${item.to}`;
    default:
      return `${item.kind}-${item.timestamp}`;
  }
}

export interface DeliveryTimelineProps {
  order: Order;
  onViewEmail?: (message: MailboxMessage, quickReplies: QuickReply[]) => void;
}

export function DeliveryTimeline({ order, onViewEmail }: DeliveryTimelineProps) {
  const threadFetcher = useFetcher<EmailThreadData>();
  const threadUrl = `/app/orders/email-thread?orderId=${encodeURIComponent(order.id)}`;
  const loadThread = threadFetcher.load;
  // Each load is an IMAP login, so a new `load` identity alone must not refetch.
  const loadedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedUrlRef.current === threadUrl) return;
    loadedUrlRef.current = threadUrl;
    loadThread(threadUrl);
  }, [threadUrl, loadThread]);
  // Right after switching orders the fetcher still holds the previous order's thread.
  const threadData =
    threadFetcher.data && threadFetcher.data.orderId === order.id
      ? threadFetcher.data
      : null;
  const mailbox = threadData?.ok ? threadData.messages : [];
  const quickReplies = threadData?.ok ? threadData.quickReplies : [];
  const threadLoading = threadFetcher.state !== "idle" && !threadData;
  const threadError = threadData && !threadData.ok ? threadData.error : null;

  const events = getRescheduleTimelineEvents(order);
  const activityEvents = buildActivityEvents(order, mailbox);
  const historyMissing = hasRescheduleTag(order) && events.length === 0;
  const hasActivity =
    events.length > 0 ||
    historyMissing ||
    activityEvents.length > 0 ||
    threadLoading ||
    threadError !== null;
  if (!hasActivity) return null;

  const attrs = order.customAttributes || [];
  // The reschedule write path overwrites the Delivery Date/Time
  // customAttributes as a legacy mirror, so once an order has been
  // rescheduled the attributes no longer hold the ORIGINAL schedule — the
  // oldest history event's `from` does (events sort newest-first). The
  // attributes stay as the fallback for history-less orders.
  const oldestEvent = events.length > 0 ? events[events.length - 1] : null;
  const originalFromHistory = oldestEvent
    ? formatTimelineDelivery(oldestEvent.fromDate, oldestEvent.fromTimeSlot)
    : "—";
  const originalDelivery =
    originalFromHistory !== "—"
      ? originalFromHistory
      : formatTimelineDelivery(
          getAttr(attrs, "Delivery Date"),
          getAttr(attrs, "Delivery Time"),
        );
  const currentDelivery = formatTimelineDelivery(
    getDeliveryDateValue(order),
    getDeliveryTimeValue(order),
  );
  const currentStatus = order.rescheduleStatus?.value?.trim() || "";
  const showOriginalSchedule = originalDelivery !== currentDelivery;

  const onView = onViewEmail
    ? (message: MailboxMessage) => onViewEmail(message, quickReplies)
    : undefined;
  const days = groupByDay(activityEvents, new Date());

  return (
    <>
      <s-divider />
      <s-stack gap="small">
        <s-heading>Delivery timeline</s-heading>
        <div className="odp-timeline-summary">
          <s-stack gap="small-300">
            <s-stack gap="small-500">
              <s-text color="subdued" fontSize="small">
                Current schedule{currentStatus ? ` · ${currentStatus}` : ""}
              </s-text>
              <s-text fontWeight="medium">{currentDelivery}</s-text>
            </s-stack>
            {showOriginalSchedule && (
              <s-text color="subdued" fontSize="small">
                Original: {originalDelivery}
              </s-text>
            )}
            {historyMissing && (
              <s-text color="subdued" fontSize="small">
                Rescheduled — history not yet recorded
              </s-text>
            )}
          </s-stack>
        </div>
        {threadLoading && (
          <s-paragraph color="subdued" fontSize="small">
            Checking emails…
          </s-paragraph>
        )}
        {threadError && (
          <s-paragraph color="subdued" fontSize="small">
            Emails not shown: {threadError}
          </s-paragraph>
        )}
        {days.map((day) => (
          <s-stack key={day.label} gap="small-200">
            <s-text color="subdued" fontSize="small" fontWeight="medium">
              {day.label}
            </s-text>
            <ul className="odp-timeline">
              {day.events.map((item, index) => (
                <li
                  key={itemKey(item, index)}
                  className={`odp-timeline-item${
                    item.kind === "mail" && item.message.direction === "inbound"
                      ? " odp-timeline-item--reply"
                      : ""
                  }`}
                >
                  <ActivityItem item={item} onView={onView} />
                </li>
              ))}
            </ul>
          </s-stack>
        ))}
      </s-stack>
    </>
  );
}
