// Delivery details in the order panel: date, time slot, receiver, address and instructions,
// each with a copy button, and a status chip (Today, Overdue) based on the shop-local date.

import type { ReactNode } from "react";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  type Order,
  formatDeliveryDate,
  financialStatusTone,
  fulfillmentBadge,
  isOpenDeliverableOrder,
  formatStatusLabel,
  getDeliveryRelativeLabel,
  isDeliveryOverdue,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getDeliveryStatus,
  getOrderPhone,
  getReceiverPhone,
  getCity,
  getFullShippingAddress,
  buildDeliveryInfoText,
  findAttrValue,
  getAttr,
} from "../../../lib/order-utils";

function CopyableValue({
  fieldKey,
  value,
  copied,
  onCopy,
}: {
  fieldKey: string;
  value: string;
  copied: boolean;
  onCopy: (fieldKey: string, value: string) => void;
}) {
  if (value === "—") {
    return <s-text color="subdued">—</s-text>;
  }
  return (
    <span
      className={`odp-copyable${copied ? " odp-copyable--copied" : ""}`}
      role="button"
      tabIndex={0}
      title="Click to copy"
      onClick={() => onCopy(fieldKey, value)}
      onKeyDown={(e) => e.key === "Enter" && onCopy(fieldKey, value)}
    >
      <s-text>{copied ? "Copied" : value}</s-text>
    </span>
  );
}

export function DeliverySection({
  order,
  todayISO,
}: {
  order: Order;
  /** SHOP-local today from the route loader — never the browser clock. */
  todayISO: string;
}) {
  const { copied, fieldCopied, copyText, copyField } = useCopyToClipboard();

  const rawDate = getDeliveryDateValue(order);
  const deliveryDate = rawDate !== "—" ? formatDeliveryDate(rawDate) : "—";
  const isOpenOrder = isOpenDeliverableOrder(order);
  const ffBadge = fulfillmentBadge(order);
  const deliveryRelative =
    rawDate !== "—" && isOpenOrder
      ? getDeliveryRelativeLabel(rawDate, todayISO)
      : "";
  const deliveryOverdue =
    rawDate !== "—" && isOpenOrder && isDeliveryOverdue(rawDate, todayISO);
  const timeWindow = getDeliveryTimeValue(order);
  const deliveryStatus = getDeliveryStatus(order);
  const fullAddress = getFullShippingAddress(order);
  const city = getCity(order);
  const province = order.shippingAddress?.province ?? null;
  const attrs = order.customAttributes || [];
  const cardMessage = getAttr(attrs, "Card Message", "card_message");
  // Attribute-sourced instructions only — order.note renders separately below
  // as "Customer notes" so the same text never shows twice.
  const instruction =
    findAttrValue(
      attrs,
      "Instruction",
      "Delivery Instruction",
      "Special Instruction",
      "Special Instructions",
      "delivery_instruction",
      "instruction",
    ) ?? "—";
  const customerNote = order.note?.trim() || "—";
  const senderPhone = getOrderPhone(order);
  const receiverPhone = getReceiverPhone(order);

  const rows: Array<{ label: string; content: ReactNode }> = [
    {
      label: "Delivery date",
      content: (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text fontWeight="medium">{deliveryDate}</s-text>
          {deliveryRelative && (
            <s-badge
              tone={
                deliveryOverdue
                  ? "critical"
                  : deliveryRelative === "Today"
                    ? "caution"
                    : undefined
              }
            >
              {deliveryOverdue ? `Overdue · ${deliveryRelative}` : deliveryRelative}
            </s-badge>
          )}
        </s-stack>
      ),
    },
    {
      label: "Time slot",
      content: <s-text>{timeWindow}</s-text>,
    },
    {
      label: "Delivery status",
      content: (
        <s-badge tone={deliveryStatus.tone}>
          {deliveryStatus.label === "Rescheduled" && order.rescheduleBadgeLabel
            ? order.rescheduleBadgeLabel
            : deliveryStatus.label}
        </s-badge>
      ),
    },
    {
      label: "Fulfillment",
      content: (
        <s-badge tone={ffBadge.tone}>{ffBadge.label}</s-badge>
      ),
    },
    {
      label: "Payment",
      content: (
        <s-badge tone={financialStatusTone(order.displayFinancialStatus)}>
          {formatStatusLabel(order.displayFinancialStatus)}
        </s-badge>
      ),
    },
    {
      label: "Address",
      content: (
        <CopyableValue
          fieldKey="address"
          value={fullAddress}
          copied={fieldCopied === "address"}
          onCopy={copyField}
        />
      ),
    },
    {
      label: "City",
      content: (
        <CopyableValue
          fieldKey="city"
          value={city}
          copied={fieldCopied === "city"}
          onCopy={copyField}
        />
      ),
    },
  ];

  if (province) {
    rows.push({
      label: "Province",
      content: (
        <CopyableValue
          fieldKey="province"
          value={province}
          copied={fieldCopied === "province"}
          onCopy={copyField}
        />
      ),
    });
  }

  // Receiver = the person at the shipping address; distinct from "Sender
  // phone" below (customer record, which only falls back to this number).
  rows.push({
    label: "Receiver phone",
    content: (
      <CopyableValue
        fieldKey="receiverPhone"
        value={receiverPhone}
        copied={fieldCopied === "receiverPhone"}
        onCopy={copyField}
      />
    ),
  });

  rows.push(
    {
      label: "Card message",
      content: (
        <div className={cardMessage !== "—" ? "odp-dd--scrollable" : undefined}>
          <CopyableValue
            fieldKey="cardMessage"
            value={cardMessage}
            copied={fieldCopied === "cardMessage"}
            onCopy={copyField}
          />
        </div>
      ),
    },
    {
      label: "Instructions",
      content: (
        <div className={instruction !== "—" ? "odp-dd--scrollable" : undefined}>
          <CopyableValue
            fieldKey="instruction"
            value={instruction}
            copied={fieldCopied === "instruction"}
            onCopy={copyField}
          />
        </div>
      ),
    },
    {
      label: "Sender phone",
      content: <s-text>{senderPhone}</s-text>,
    },
    {
      label: "Customer notes",
      content: (
        <div className={customerNote !== "—" ? "odp-dd--scrollable" : undefined}>
          <s-text color={customerNote === "—" ? "subdued" : undefined}>
            {customerNote}
          </s-text>
        </div>
      ),
    },
  );

  return (
    <s-stack gap="small">
      <s-heading>Delivery</s-heading>
      <dl className="odp-dl">
        {rows.map((row) => (
          <div style={{ display: "contents" }} key={row.label}>
            <dt className="odp-dt">
              <s-text color="subdued" fontSize="small">
                {row.label}
              </s-text>
            </dt>
            <dd className="odp-dd">{row.content}</dd>
          </div>
        ))}
      </dl>
      <s-stack direction="inline">
        <s-button onClick={() => copyText(buildDeliveryInfoText(order))}>
          {copied ? "Copied" : "Copy delivery info"}
        </s-button>
      </s-stack>
    </s-stack>
  );
}
