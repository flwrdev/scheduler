// Delivery Schedule card for the Thank You page (purchase.thank-you.block.render).
// It shows the delivery date and time slot the customer picked at checkout.
// When there is no date and no slot, it shows nothing at all.

import '@shopify/ui-extensions/preact';
import {render} from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const appMetafields = shopify.appMetafields.value ?? [];
  const attributes = shopify.attributes.value ?? [];

  // Thank You extensions can read cart metafields directly; legacy checkout
  // attributes are only a backup for older orders that never received them.
  const deliveryDate =
    getCartMetafieldValue(appMetafields, 'custom', 'date') ??
    getAttributeValue(attributes, 'Delivery Date');
  const deliveryTime =
    getCartMetafieldValue(appMetafields, 'custom', 'time_slot') ??
    getAttributeValue(attributes, 'Delivery Time');
  const hasSchedule = Boolean(deliveryDate || deliveryTime);

  if (!hasSchedule) {
    return null;
  }

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-heading>Delivery Schedule</s-heading>
          {deliveryDate ? (
            <s-text>Date: {formatDisplayDate(deliveryDate)}</s-text>
          ) : null}
          {deliveryTime ? <s-text>Time slot: {deliveryTime}</s-text> : null}
        </s-stack>
      </s-stack>
    </s-box>
  );
}

function getCartMetafieldValue(appMetafields, namespace, key) {
  const entry = appMetafields.find(
    (appMetafield) =>
      appMetafield.target?.type === 'cart' &&
      appMetafield.metafield.namespace === namespace &&
      appMetafield.metafield.key === key,
  );

  return entry?.metafield?.value?.toString() ?? null;
}

function getAttributeValue(attributes, key) {
  const attribute = attributes.find((entry) => entry.key === key);
  return attribute?.value ?? null;
}

function formatDisplayDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return isoDate;
  }

  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);

  // Pinned to English per the brand's English-first voice (merchant decision
  // 2026-08-25) — a Filipino-locale browser would otherwise render "Biyernes".
  return date.toLocaleDateString('en-PH', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
