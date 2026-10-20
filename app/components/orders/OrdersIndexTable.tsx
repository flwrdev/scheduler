// The Orders list: view tabs, search, sort and filters, a bar of bulk actions when rows are
// selected, and one row per order with its delivery date, time slot, payment and fulfilment
// status and tags. It only shows data; every change is reported to the route through callbacks
// that update the URL parameters.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  type Order,
  formatDeliveryDate,
  formatMoney,
  financialStatusTone,
  fulfillmentBadge,
  isOpenDeliverableOrder,
  formatStatusLabel,
  tagDisplayLabel,
  getMeaningfulTags,
  getDeliveryRelativeLabel,
  isDeliveryOverdue,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getCustomerName,
  getCity,
  getInstructionValue,
  getItemImages,
} from "../../lib/order-utils";
import {
  buildMessengerInboxUrl,
  getMessengerPsid,
  isMessengerSourced,
} from "../../lib/messenger-conversation";
import { isCompleteIsoDate } from "../../lib/date-field";
import type { SelectAllState } from "../../lib/row-selection";
import { flag } from "../../lib/web-component-props";
import { useWebComponentEvent } from "../../hooks/useWebComponentEvent";
import type { BulkModalName } from "../../hooks/useBulkActions";
import { ControlledCheckbox } from "../ui/ControlledCheckbox";

const BULK_MENU_ID = "orders-bulk-menu";

export interface OrdersTabDef {
  id: string;
  label: string;
  /**
   * Count derived from the loaded page, or null to render the label without
   * one — the route passes null when the loaded page is too small to be
   * representative (25-row server-filtered views) or unknowable (Archived).
   */
  count: number | null;
  /** True when further server pages exist — the count renders as "N+". */
  approximate?: boolean;
}

const TIME_SLOT_CHOICES = [
  { label: "9AM–12PM", value: "9AM-12PM" },
  { label: "12PM–3PM", value: "12PM-3PM" },
  { label: "3PM–6PM", value: "3PM-6PM" },
  { label: "6PM–11PM", value: "6PM-11PM" },
];

const SORT_OPTIONS = [
  { label: "Order date · Newest first", value: "orderDate desc" },
  { label: "Order date · Oldest first", value: "orderDate asc" },
  { label: "Delivery date · Earliest first", value: "deliveryDate asc" },
  { label: "Delivery date · Latest first", value: "deliveryDate desc" },
];

export interface OrdersIndexTableProps {
  orders: Order[];
  todayISO: string;
  /** Meta Page ID for the Messenger inbox deep link; "" hides the link. */
  metaPageId?: string;
  loading: boolean;
  isSubmitting: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNextPage: () => void;
  onPreviousPage: () => void;
  tabs: OrdersTabDef[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  queryValue: string;
  onQueryChange: (value: string) => void;
  onQueryClear: () => void;
  deliveryDateFilter: string;
  onDeliveryDateChange: (value: string) => void;
  timeWindow: string;
  onTimeWindowChange: (value: string) => void;
  sortSelected: string;
  onSortChange: (value: string) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
  selectedResources: string[];
  selectAllState: SelectAllState;
  onSelectRow: (orderId: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onOpenOrder: (orderId: string) => void;
  onShowTags: (orderId: string) => void;
  onOpenBulkModal: (name: BulkModalName) => void;
  // Orders that appeared or changed schedule since the last refresh of the same view. They
  // get a small badge until the notice banner is dismissed.
  newOrderIds?: ReadonlySet<string>;
  changedOrderIds?: ReadonlySet<string>;
}

// A table row that calls `onActivate` when the merchant clicks it. A click inside an element
// marked with `data-row-ignore` (a checkbox or a link) is left alone.
function ClickableRow({
  onActivate,
  children,
}: {
  onActivate: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElementTagNameMap["s-table-row"]>(null);
  useWebComponentEvent(ref, "click", (event) => {
    const ignored = event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement && node.dataset.rowIgnore !== undefined,
      );
    if (!ignored) onActivate();
  });
  return <s-table-row ref={ref}>{children}</s-table-row>;
}

export function OrdersIndexTable({
  orders,
  todayISO,
  metaPageId = "",
  loading,
  isSubmitting,
  hasNextPage,
  hasPreviousPage,
  onNextPage,
  onPreviousPage,
  tabs,
  activeTab,
  onTabChange,
  queryValue,
  onQueryChange,
  onQueryClear,
  deliveryDateFilter,
  onDeliveryDateChange,
  timeWindow,
  onTimeWindowChange,
  sortSelected,
  onSortChange,
  onClearFilters,
  hasActiveFilters,
  selectedResources,
  selectAllState,
  onSelectRow,
  onSelectAll,
  onOpenOrder,
  onShowTags,
  onOpenBulkModal,
  newOrderIds,
  changedOrderIds,
}: OrdersIndexTableProps) {
  const tableRef = useRef<HTMLElementTagNameMap["s-table"]>(null);
  useWebComponentEvent(tableRef, "nextpage", () => onNextPage());
  useWebComponentEvent(tableRef, "previouspage", () => onPreviousPage());

  // Local copy of the delivery-date filter. The field can send half-typed text, so the filter
  // only changes when the field is empty or holds a finished date.
  const [dateDraft, setDateDraft] = useState(deliveryDateFilter);
  useEffect(() => {
    setDateDraft(deliveryDateFilter);
  }, [deliveryDateFilter]);
  const handleDateDraftChange = (value: string) => {
    setDateDraft(value);
    if (value === "" || isCompleteIsoDate(value)) {
      onDeliveryDateChange(value);
    }
  };

  // Sends the search text to the route. An empty box clears the search straight away.
  const handleSearchInput = (value: string) => {
    if (value === "") onQueryClear();
    else onQueryChange(value);
  };

  const selectedCount = selectedResources.length;

  // The row of view tabs (All, Today, Unpaid, ...).
  const tabsMarkup = (
    <s-stack direction="inline" gap="small-300">
      {tabs.map((tab) => (
        <s-button
          key={tab.id}
          variant={tab.id === activeTab ? "secondary" : "tertiary"}
          aria-pressed={tab.id === activeTab}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.count !== null && tab.count > 0
            ? `${tab.label} (${tab.count}${tab.approximate ? "+" : ""})`
            : tab.label}
        </s-button>
      ))}
    </s-stack>
  );

  // Search, delivery date, time slot and sort controls.
  const filtersMarkup = (
    <s-stack gap="small-200">
      {tabsMarkup}
      <s-grid
        gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))"
        gap="small-200"
        alignItems="end"
      >
        <s-search-field
          label="Search orders"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search by order, customer, phone, city"
          value={queryValue}
          onInput={(e) => handleSearchInput(e.currentTarget.value)}
        />
        <s-date-field
          label="Delivery date"
          value={dateDraft}
          onInput={(e) => handleDateDraftChange(e.currentTarget.value)}
        />
        <s-select
          label="Time slot"
          value={timeWindow}
          onInput={(e) => onTimeWindowChange(e.currentTarget.value)}
        >
          <s-option value="">All time slots</s-option>
          {TIME_SLOT_CHOICES.map((choice) => (
            <s-option key={choice.value} value={choice.value}>
              {choice.label}
            </s-option>
          ))}
        </s-select>
        <s-select
          label="Sort"
          value={sortSelected}
          onInput={(e) => {
            if (e.currentTarget.value) onSortChange(e.currentTarget.value);
          }}
        >
          {SORT_OPTIONS.map((option) => (
            <s-option key={option.value} value={option.value}>
              {option.label}
            </s-option>
          ))}
        </s-select>
      </s-grid>
      {hasActiveFilters && (
        <s-stack direction="inline">
          <s-button variant="tertiary" onClick={onClearFilters}>
            Clear filters
          </s-button>
        </s-stack>
      )}
    </s-stack>
  );

  // The bar shown instead of the filters while rows are selected.
  const bulkBarMarkup = (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-text fontWeight="semibold">{selectedCount} selected</s-text>
      <s-button
        disabled={flag(isSubmitting)}
        onClick={() => onOpenBulkModal("reschedule")}
      >
        Update delivery slot
      </s-button>
      <s-button
        disabled={flag(isSubmitting)}
        onClick={() => onOpenBulkModal("markFulfilled")}
      >
        Mark as fulfilled
      </s-button>
      <s-button
        disabled={flag(isSubmitting)}
        onClick={() => onOpenBulkModal("markAsPaid")}
      >
        Mark as paid
      </s-button>
      <s-button
        disabled={flag(isSubmitting)}
        onClick={() => onOpenBulkModal("addTags")}
      >
        Add tags
      </s-button>
      <s-button
        disabled={flag(isSubmitting)}
        onClick={() => onOpenBulkModal("removeTags")}
      >
        Remove tags
      </s-button>
      <s-button commandFor={BULK_MENU_ID} disabled={flag(isSubmitting)}>
        More actions
      </s-button>
      <s-menu id={BULK_MENU_ID} accessibilityLabel="More bulk actions">
        <s-button onClick={() => onOpenBulkModal("archive")}>
          Archive orders
        </s-button>
        <s-button onClick={() => onOpenBulkModal("unarchive")}>
          Unarchive orders
        </s-button>
        <s-button tone="critical" onClick={() => onOpenBulkModal("cancel")}>
          Cancel orders
        </s-button>
      </s-menu>
    </s-stack>
  );

  const rowMarkup = orders.map((order) => {
    const customerName =
      getCustomerName(order) === "—" ? "Guest" : getCustomerName(order);
    const instructionText = getInstructionValue(order);
    const rawDeliveryDate = getDeliveryDateValue(order);
    const deliveryDateDisplay =
      rawDeliveryDate !== "—" ? formatDeliveryDate(rawDeliveryDate) : "—";
    const timeWindowValue = getDeliveryTimeValue(order);
    const isOpenOrder = isOpenDeliverableOrder(order);
    const ffBadge = fulfillmentBadge(order);
    const deliveryRelative =
      rawDeliveryDate !== "—" && isOpenOrder
        ? getDeliveryRelativeLabel(rawDeliveryDate, todayISO)
        : "";
    const deliveryOverdue =
      rawDeliveryDate !== "—" &&
      isOpenOrder &&
      isDeliveryOverdue(rawDeliveryDate, todayISO);
    const total = order.currentTotalPriceSet
      ? formatMoney(
          order.currentTotalPriceSet.shopMoney.amount,
          order.currentTotalPriceSet.shopMoney.currencyCode,
        )
      : "—";
    const items = order.lineItems?.edges || [];
    const itemCount = items.length;
    const totalQty = items.reduce(
      (sum, item) => sum + (item.node.quantity || 0),
      0,
    );
    const itemsText =
      itemCount === 0
        ? "—"
        : itemCount === 1
          ? `×${totalQty}`
          : itemCount >= 10
            ? "10+ items"
            : `${itemCount} items`;
    const itemImages = getItemImages(order);
    const meaningfulTags = getMeaningfulTags(order.tags || []);
    const shownTags = meaningfulTags.slice(0, 2);
    const extraTags = meaningfulTags.length - shownTags.length;

    return (
      <ClickableRow key={order.id} onActivate={() => onOpenOrder(order.id)}>
        <s-table-cell>
          <s-stack direction="inline" gap="small-200" alignItems="start">
            <div data-row-ignore="true">
              <ControlledCheckbox
                checked={selectedResources.includes(order.id)}
                accessibilityLabel={`Select order ${order.name}`}
                onToggle={(checked) => onSelectRow(order.id, checked)}
              />
            </div>
            <s-stack gap="small-500">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-clickable accessibilityLabel={`Open order ${order.name}`}>
                  <s-text fontWeight="semibold">{order.name}</s-text>
                </s-clickable>
                {newOrderIds?.has(order.id) ? (
                  <s-badge tone="success">New</s-badge>
                ) : changedOrderIds?.has(order.id) ? (
                  <s-badge tone="caution">Updated</s-badge>
                ) : null}
                {instructionText !== "—" && (
                  <span
                    title={instructionText}
                    aria-label={`Note: ${instructionText}`}
                    role="img"
                    style={{ display: "inline-flex", color: "#8a8a8a" }}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
                      <line x1="3.5" y1="4.5" x2="10.5" y2="4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                      <line x1="3.5" y1="7" x2="10.5" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                      <line x1="3.5" y1="9.5" x2="7.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </span>
                )}
              </s-stack>
              {order.createdAt && (
                <s-text color="subdued" fontSize="small">
                  {new Date(order.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </s-text>
              )}
            </s-stack>
          </s-stack>
        </s-table-cell>

        <s-table-cell>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {itemImages.length > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                <span
                  style={{
                    position: "relative",
                    zIndex: 1,
                    display: "inline-flex",
                    borderRadius: "8px",
                    boxShadow: "0 0 0 2px #fff",
                  }}
                >
                  <s-thumbnail
                    src={itemImages[0].url}
                    alt={itemImages[0].altText}
                    size="small"
                  />
                </span>
                {itemImages[1] && (
                  <span
                    style={{
                      position: "relative",
                      zIndex: 0,
                      display: "inline-flex",
                      marginLeft: "-20px",
                    }}
                  >
                    <s-thumbnail
                      src={itemImages[1].url}
                      alt={itemImages[1].altText}
                      size="small"
                    />
                  </span>
                )}
              </span>
            )}
            <s-text>{itemsText}</s-text>
          </s-stack>
        </s-table-cell>

        <s-table-cell>
          <s-stack gap="small-500">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text fontWeight="semibold">{customerName}</s-text>
              {metaPageId && isMessengerSourced(order) && (
                <span data-row-ignore="true">
                  <s-link
                    href={
                      buildMessengerInboxUrl(
                        metaPageId,
                        getMessengerPsid(order),
                      ) ?? undefined
                    }
                    target="_blank"
                  >
                    Messenger
                  </s-link>
                </span>
              )}
            </s-stack>
            {order.customer?.defaultEmailAddress?.emailAddress && (
              <s-text color="subdued" fontSize="small">
                {order.customer.defaultEmailAddress.emailAddress}
              </s-text>
            )}
          </s-stack>
        </s-table-cell>

        <s-table-cell>
          <s-text>{getCity(order)}</s-text>
        </s-table-cell>

        <s-table-cell>
          <s-stack gap="small-500" alignItems="start">
            {rawDeliveryDate !== "—" ? (
              <s-text fontWeight="semibold">{deliveryDateDisplay}</s-text>
            ) : (
              <s-text color="subdued">{deliveryDateDisplay}</s-text>
            )}
            {deliveryRelative &&
              (deliveryOverdue ? (
                <s-badge tone="critical">{deliveryRelative}</s-badge>
              ) : (
                <s-badge>{deliveryRelative}</s-badge>
              ))}
          </s-stack>
        </s-table-cell>

        <s-table-cell>
          {timeWindowValue === "—" ? (
            <s-text color="subdued">{timeWindowValue}</s-text>
          ) : (
            <s-text>{timeWindowValue}</s-text>
          )}
        </s-table-cell>

        <s-table-cell>
          <s-badge tone={financialStatusTone(order.displayFinancialStatus)}>
            {formatStatusLabel(order.displayFinancialStatus)}
          </s-badge>
        </s-table-cell>

        <s-table-cell>
          <s-badge tone={ffBadge.tone}>{ffBadge.label}</s-badge>
        </s-table-cell>

        <s-table-cell>
          <s-text>{total}</s-text>
        </s-table-cell>

        <s-table-cell>
          {meaningfulTags.length === 0 ? (
            <s-text color="subdued">—</s-text>
          ) : (
            <s-stack direction="inline" gap="small-300" alignItems="center">
              {shownTags.map((tag) => (
                <s-badge key={tag}>
                  {tag.trim().toLowerCase() === "resched" &&
                  order.rescheduleBadgeLabel
                    ? order.rescheduleBadgeLabel
                    : tagDisplayLabel(tag)}
                </s-badge>
              ))}
              {extraTags > 0 && (
                <span data-row-ignore="true">
                  <s-button
                    variant="tertiary"
                    onClick={() => onShowTags(order.id)}
                  >
                    {`+${extraTags}`}
                  </s-button>
                </span>
              )}
            </s-stack>
          )}
        </s-table-cell>
      </ClickableRow>
    );
  });

  return (
    <>
      <s-table
        ref={tableRef}
        paginate
        loading={flag(loading)}
        hasNextPage={flag(hasNextPage)}
        hasPreviousPage={flag(hasPreviousPage)}
      >
        <div slot="filters">
          {selectedCount > 0 ? bulkBarMarkup : filtersMarkup}
        </div>
        <s-table-header-row>
          <s-table-header listSlot="primary">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <ControlledCheckbox
                checked={selectAllState === "all"}
                indeterminate={selectAllState === "some"}
                disabled={orders.length === 0}
                accessibilityLabel="Select all orders on this page"
                onToggle={onSelectAll}
              />
              Order
            </s-stack>
          </s-table-header>
          <s-table-header>Items</s-table-header>
          <s-table-header listSlot="secondary">Customer</s-table-header>
          <s-table-header>City</s-table-header>
          <s-table-header>Delivery date</s-table-header>
          <s-table-header>Time slot</s-table-header>
          <s-table-header>Payment</s-table-header>
          <s-table-header>Fulfillment</s-table-header>
          <s-table-header format="currency">Total</s-table-header>
          <s-table-header>Tags</s-table-header>
        </s-table-header-row>
        <s-table-body>{rowMarkup}</s-table-body>
      </s-table>
      {orders.length === 0 && !loading && (
        <s-box padding="large">
          <s-empty-state
            heading={
              hasActiveFilters ? "No orders match this view" : "No orders found"
            }
          >
            <s-paragraph>
              {hasActiveFilters
                ? "Try changing the filters or search term."
                : "Orders will appear here after customers place them."}
            </s-paragraph>
            {hasActiveFilters && (
              <s-button onClick={onClearFilters}>Clear filters</s-button>
            )}
          </s-empty-state>
        </s-box>
      )}
    </>
  );
}
