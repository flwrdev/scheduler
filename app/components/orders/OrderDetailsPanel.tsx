// Side panel with everything about one order: delivery details, items and a timeline, plus the
// actions menu (reschedule, send email, edit details, tags). Opened with the `?order=` URL
// parameter and loaded lazily.

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  type Order,
  formatMoney,
  financialStatusTone,
  fulfillmentBadge,
  formatStatusLabel,
  tagDisplayLabel,
  getMeaningfulTags,
  getCustomerName,
  getRescheduleTimelineEvents,
} from "../../lib/order-utils";
import { MAX_ORDER_TAG_LENGTH } from "../../lib/order-tags";
import type { MailboxMessage } from "../../lib/email-replies";
import type { QuickReply } from "../../lib/quick-replies";
import { buildMessengerInboxUrl, getMessengerPsid } from "../../lib/messenger-conversation";
import { flag } from "../../lib/web-component-props";
import { DeliverySection } from "./panel/DeliverySection";
import { DeliveryTimeline } from "./panel/DeliveryTimeline";
import { ItemsSection } from "./panel/ItemsSection";

const ACTIONS_MENU_ID = "odp-actions-menu";

export interface OrderDetailsPanelProps {
  order: Order;
  /** SHOP-local today (YYYY-MM-DD) from the loader — drives the Today/Overdue chips. */
  todayISO: string;
  onClose: () => void;
  // §6: the order dropped out of the loaded result set after a background
  // revalidate — the panel is showing its last-known snapshot.
  notInView?: boolean;
  // A modal is stacked over the panel — it owns Escape; the panel's own
  // Esc-to-close must stand down or one Esc closes both (and the ?order=
  // param with it, unmounting the modal mid-compose).
  escDisabled?: boolean;
  // Phase 4: opens the merchant "Update delivery slot" modal for this order.
  onReschedule?: () => void;
  // Customer Email: opens the in-app compose modal for this order.
  onSendEmail?: () => void;
  // Edit details: opens the shipping-address edit modal for this order.
  onEditDetails?: () => void;
  /** Opens a mailbox email from the timeline in the View email modal. */
  onViewEmail?: (message: MailboxMessage, quickReplies: QuickReply[]) => void;
  /** Meta Page ID for the "Open Messenger conversation" action; "" hides it. */
  metaPageId?: string;
}

/**
 * Right-docked panel with the details of one order. The open order comes from the `?order=`
 * URL parameter, and the route decides when the panel opens or closes. The only change it can
 * make is adding a tag, through the `tagsAdd` action of the Orders route.
 */
export function OrderDetailsPanel({
  order,
  todayISO,
  onClose,
  notInView = false,
  escDisabled = false,
  onReschedule,
  onSendEmail,
  onEditDetails,
  onViewEmail,
  metaPageId = "",
}: OrderDetailsPanelProps) {
  const tagFetcher = useFetcher<{
    ok: boolean;
    message?: string;
    summary?: { ok: number; failed: number };
  }>();
  const [tagInput, setTagInput] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const orderId = order.id.split("/").pop() || order.id;
  const customerName = getCustomerName(order);
  const customerEmail =
    order.customer?.defaultEmailAddress?.emailAddress ?? null;
  const total = order.currentTotalPriceSet
    ? formatMoney(
        order.currentTotalPriceSet.shopMoney.amount,
        order.currentTotalPriceSet.shopMoney.currencyCode,
      )
    : "—";
  const meaningfulTags = getMeaningfulTags(order.tags || []);
  const rescheduleCount = getRescheduleTimelineEvents(order).length;
  const placedAt = new Date(order.createdAt);
  const placedLabel = Number.isNaN(placedAt.getTime())
    ? "—"
    : placedAt.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !escDisabled && !e.defaultPrevented) onClose();
    };

    // Lock body scroll while the panel is open; focus it for keyboard users
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [onClose, escDisabled]);

  useEffect(() => {
    if (tagFetcher.state === "idle" && tagFetcher.data?.ok) {
      setTagInput("");
    }
  }, [tagFetcher.state, tagFetcher.data]);

  const adminUrl = `shopify://admin/orders/${orderId}`;
  const statusPageUrl = order.statusPageUrl ?? null;
  const messengerPsid = getMessengerPsid(order);
  const messengerUrl =
    metaPageId && messengerPsid ? buildMessengerInboxUrl(metaPageId, messengerPsid) : null;
  const tagBusy = tagFetcher.state !== "idle";

  // Sends the typed tag to the Orders route. Nothing is sent when the field is empty.
  const submitTag = () => {
    if (!tagInput.trim() || tagBusy) return;
    tagFetcher.submit(
      { _action: "tagsAdd", orderId: order.id, tags: tagInput },
      { method: "post" },
    );
  };

  return (
    <>
      <div className="odp-backdrop" onClick={onClose} aria-hidden="true" />

      <div
        className="odp-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${order.name} details`}
        ref={panelRef}
        tabIndex={-1}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="odp-head">
          <s-stack gap="small-300">
            <s-stack
              direction="inline"
              justifyContent="space-between"
              alignItems="start"
              gap="small-200"
            >
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading>{order.name}</s-heading>
                <s-badge tone={financialStatusTone(order.displayFinancialStatus)}>
                  {formatStatusLabel(order.displayFinancialStatus)}
                </s-badge>
                <s-badge tone={fulfillmentBadge(order).tone}>
                  {fulfillmentBadge(order).label}
                </s-badge>
              </s-stack>
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-button commandFor={ACTIONS_MENU_ID}>Actions</s-button>
                <s-menu id={ACTIONS_MENU_ID} accessibilityLabel="Order actions">
                  <s-button disabled={flag(!onReschedule)} onClick={() => onReschedule?.()}>
                    Update delivery slot
                  </s-button>
                  <s-button disabled={flag(!onEditDetails)} onClick={() => onEditDetails?.()}>
                    Edit details
                  </s-button>
                  <s-button
                    disabled={flag(!customerEmail || !onSendEmail)}
                    onClick={() => onSendEmail?.()}
                  >
                    Send email
                  </s-button>
                  <s-button href="https://web.lalamove.com/" target="_blank">
                    Lalabook
                  </s-button>
                  <s-button
                    disabled={flag(!statusPageUrl)}
                    href={statusPageUrl ?? undefined}
                    target="_blank"
                  >
                    View order status page
                  </s-button>
                  <s-button href={adminUrl}>Open in Shopify Admin</s-button>
                  <s-button
                    disabled={flag(!messengerUrl)}
                    href={messengerUrl ?? undefined}
                    target="_blank"
                  >
                    Open Messenger conversation
                  </s-button>
                </s-menu>
                <button
                  type="button"
                  className="odp-close"
                  onClick={onClose}
                  aria-label="Close order details"
                >
                  ×
                </button>
              </s-stack>
            </s-stack>
            <s-text color="subdued" fontSize="small">
              {customerName}
              {order.customer?.numberOfOrders != null &&
                order.customer.numberOfOrders > 0 &&
                ` · ${order.customer.numberOfOrders} orders`}
            </s-text>
            <s-paragraph fontSize="large" fontWeight="semibold">
              {total}
            </s-paragraph>
          </s-stack>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div className="odp-body">
          {notInView && (
            <s-paragraph color="subdued" fontSize="small">
              This order is no longer in this view. Showing the last loaded
              details.
            </s-paragraph>
          )}
          <DeliverySection order={order} todayISO={todayISO} />

          <s-divider />
          <ItemsSection order={order} />

          <s-divider />

          {/* Order history */}
          <s-stack gap="small">
            <s-heading>Order history</s-heading>
            <s-stack gap="small-300">
              <s-text color="subdued" fontSize="small">
                Placed
              </s-text>
              <s-text>{placedLabel}</s-text>
              {rescheduleCount > 0 && (
                <s-text color="subdued" fontSize="small">
                  Rescheduled {rescheduleCount}×
                </s-text>
              )}
            </s-stack>
            <s-stack direction="inline" gap="small">
              <s-button
                variant="tertiary"
                href={statusPageUrl ?? undefined}
                disabled={flag(!statusPageUrl)}
                target="_blank"
              >
                Order status page
              </s-button>
              <s-button variant="tertiary" href={adminUrl}>
                Open in Shopify Admin
              </s-button>
            </s-stack>
          </s-stack>

          <s-divider />

          {/* Tags */}
          <s-stack gap="small">
            <s-heading>Tags</s-heading>
            {meaningfulTags.length === 0 ? (
              <s-paragraph color="subdued">No tags</s-paragraph>
            ) : (
              <s-stack direction="inline" gap="small-300">
                {meaningfulTags.map((tag) => (
                  <s-chip key={tag}>{tagDisplayLabel(tag)}</s-chip>
                ))}
              </s-stack>
            )}
            <s-stack
              direction="inline"
              gap="small-300"
              alignItems="end"
            >
              <div
                style={{ flex: "1 1 auto" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitTag();
                  }
                }}
              >
                <s-text-field
                  label="Add a tag"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Add a tag…"
                  value={tagInput}
                  disabled={flag(tagBusy)}
                  maxLength={MAX_ORDER_TAG_LENGTH}
                  autocomplete="off"
                  onInput={(e) => setTagInput(e.currentTarget.value)}
                />
              </div>
              <s-button
                disabled={flag(!tagInput.trim() || tagBusy)}
                loading={flag(tagBusy)}
                onClick={submitTag}
              >
                Add
              </s-button>
            </s-stack>
            {tagFetcher.state === "idle" &&
              tagFetcher.data &&
              !tagFetcher.data.ok && (
                <s-text tone="critical" fontSize="small">
                  {tagFetcher.data.message ?? "Failed to add tag."}
                </s-text>
              )}
          </s-stack>

          {/* The timeline shows its own divider and heading only when the order has activity. */}
          <DeliveryTimeline order={order} onViewEmail={onViewEmail} />
        </div>
      </div>
    </>
  );
}
