// The bell on the Orders page. Lists unseen customer email replies and recent customer
// reschedules, opens the related order or email, and lets the merchant mark items as seen.

import { useRef } from "react";
import { getShopLocalDate } from "../../lib/delivery-availability";
import type { EmailReplyNotification } from "../../lib/email-replies";
import {
  type RecentRescheduleItem,
  formatShopLocalTime,
  formatShortMonthDay,
  shiftISODate,
} from "../../lib/recent-reschedules";
import { useWebComponentEvent } from "../../hooks/useWebComponentEvent";

const BELL_POPOVER_ID = "orders-bell-popover";

export interface NotificationsBellProps {
  replies: EmailReplyNotification[];
  repliesLoading: boolean;
  repliesError: string | null;
  reschedules: RecentRescheduleItem[];
  /** Hidden while Seen is in flight so a clicked row doesn't linger for the round trip. */
  pendingReplySeenIds: ReadonlySet<string>;
  pendingRescheduleSeenIds: ReadonlySet<string>;
  seenErrorMessage?: string | null;
  timezone: string;
  todayISO: string;
  onOpen: () => void;
  onOpenReply: (item: EmailReplyNotification) => void;
  onReplySeen: (items: EmailReplyNotification[]) => void;
  onOpenReschedule: (item: RecentRescheduleItem) => void;
  onRescheduleSeen: (items: RecentRescheduleItem[]) => void;
}

type BellItem =
  | { kind: "reply"; at: number; item: EmailReplyNotification }
  | { kind: "reschedule"; at: number; item: RecentRescheduleItem };

// Turns a timestamp into "10:30 AM", "Yesterday · 10:30 AM" or "Oct 3 · 10:30 AM".
function whenLabel(iso: string, timezone: string, todayISO: string): string {
  const time = formatShopLocalTime(iso, timezone);
  const day = getShopLocalDate(timezone, new Date(iso));
  if (day === todayISO) return time;
  if (day === shiftISODate(todayISO, -1)) return `Yesterday · ${time}`;
  return `${formatShortMonthDay(day)} · ${time}`;
}

export function NotificationsBell({
  replies,
  repliesLoading,
  repliesError,
  reschedules,
  pendingReplySeenIds,
  pendingRescheduleSeenIds,
  seenErrorMessage,
  timezone,
  todayISO,
  onOpen,
  onOpenReply,
  onReplySeen,
  onOpenReschedule,
  onRescheduleSeen,
}: NotificationsBellProps) {
  const popoverRef = useRef<HTMLElementTagNameMap["s-popover"]>(null);

  const visibleReplies = replies.filter((r) => !pendingReplySeenIds.has(r.orderId));
  const visibleReschedules = reschedules.filter(
    (r) => !pendingRescheduleSeenIds.has(r.orderId),
  );
  const items: BellItem[] = [
    ...visibleReplies.map(
      (item): BellItem => ({ kind: "reply", at: Date.parse(item.receivedAt), item }),
    ),
    ...visibleReschedules.map(
      (item): BellItem => ({
        kind: "reschedule",
        at: Date.parse(item.requestedAt),
        item,
      }),
    ),
  ].sort((a, b) => b.at - a.at);
  const count = items.length;

  // Asks the parent to load the inbox each time the popover opens.
  useWebComponentEvent(popoverRef, "show", () => onOpen());

  return (
    <>
      <span className="orders-bell">
        <s-button
          variant="tertiary"
          icon="notification"
          commandFor={BELL_POPOVER_ID}
          accessibilityLabel={
            count > 0 ? `Notifications, ${count} unseen` : "Notifications"
          }
        />
        {count > 0 && (
          <span className="orders-bell-count" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </span>
      <s-popover id={BELL_POPOVER_ID} ref={popoverRef} minInlineSize="340px" maxInlineSize="420px">
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-heading>Notifications</s-heading>
              {count > 1 && (
                <s-button
                  variant="tertiary"
                  onClick={() => {
                    onReplySeen(visibleReplies);
                    onRescheduleSeen(visibleReschedules);
                  }}
                >
                  Mark all as seen
                </s-button>
              )}
            </s-stack>
            {repliesLoading && (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-spinner size="base" accessibilityLabel="Checking the inbox" />
                <s-text color="subdued">Checking the inbox…</s-text>
              </s-stack>
            )}
            {repliesError && <s-text tone="critical">{repliesError}</s-text>}
            {seenErrorMessage && (
              <s-text tone="critical">{seenErrorMessage}</s-text>
            )}
            {count === 0 && !repliesLoading && (
              <s-paragraph color="subdued">You're all caught up.</s-paragraph>
            )}
            {count > 0 && (
              <div className="orders-bell-list">
                <s-stack gap="small-200">
                  {items.map((entry, index) => (
                    <s-stack gap="small-200" key={`${entry.kind}-${entry.item.orderId}`}>
                      {index > 0 && <s-divider />}
                      {entry.kind === "reply" ? (
                        <ReplyRow
                          item={entry.item}
                          when={whenLabel(entry.item.receivedAt, timezone, todayISO)}
                          onOpen={() => onOpenReply(entry.item)}
                          onSeen={() => onReplySeen([entry.item])}
                        />
                      ) : (
                        <RescheduleRow
                          item={entry.item}
                          when={whenLabel(entry.item.requestedAt, timezone, todayISO)}
                          onOpen={() => onOpenReschedule(entry.item)}
                          onSeen={() => onRescheduleSeen([entry.item])}
                        />
                      )}
                    </s-stack>
                  ))}
                </s-stack>
              </div>
            )}
          </s-stack>
        </s-box>
      </s-popover>
    </>
  );
}

// The "Open order" and "Seen" buttons under each notification. "Open order" also closes the popover.
function RowActions({ onOpen, onSeen }: { onOpen: () => void; onSeen: () => void }) {
  return (
    <s-stack direction="inline" gap="small-200">
      <s-button command="--hide" commandFor={BELL_POPOVER_ID} onClick={onOpen}>
        Open order
      </s-button>
      <s-button variant="tertiary" onClick={onSeen}>
        Seen
      </s-button>
    </s-stack>
  );
}

// One notification for a new customer email reply: the icon on the left, the text on the right.
function ReplyRow({
  item,
  when,
  onOpen,
  onSeen,
}: {
  item: EmailReplyNotification;
  when: string;
  onOpen: () => void;
  onSeen: () => void;
}) {
  return (
    <s-grid gridTemplateColumns="auto 1fr" gap="small" alignItems="start">
      <s-icon type="chat" tone="info" />
      <s-stack gap="small-300">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text fontWeight="semibold">
            Customer replied to order {item.name}
          </s-text>
          {item.unseenCount > 1 && (
            <s-badge>{`${item.unseenCount} new`}</s-badge>
          )}
          {item.verdict === "fail" && (
            <s-badge tone="warning">Unverified sender</s-badge>
          )}
        </s-stack>
        {item.preview && <s-paragraph>“{item.preview}”</s-paragraph>}
        <s-text color="subdued">
          {when} · {item.fromName}
          {item.matchedBy === "sender" ? " · matched by sender email" : ""}
        </s-text>
        <RowActions onOpen={onOpen} onSeen={onSeen} />
      </s-stack>
    </s-grid>
  );
}

// One notification for an order the customer rescheduled: the icon on the left, the text on the
// right.
function RescheduleRow({
  item,
  when,
  onOpen,
  onSeen,
}: {
  item: RecentRescheduleItem;
  when: string;
  onOpen: () => void;
  onSeen: () => void;
}) {
  return (
    <s-grid gridTemplateColumns="auto 1fr" gap="small" alignItems="start">
      <s-icon type="calendar" tone="critical" />
      <s-stack gap="small-300">
        <s-text fontWeight="semibold">Order {item.name} rescheduled</s-text>
        <s-paragraph>New date: {item.to}</s-paragraph>
        <s-text color="subdued">
          {when}
          {item.customerName ? ` · ${item.customerName}` : ""}
        </s-text>
        <RowActions onOpen={onOpen} onSeen={onSeen} />
      </s-stack>
    </s-grid>
  );
}
