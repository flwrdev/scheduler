// Block on the admin order page showing the order's delivery date, time slot and reschedule
// status. Reads the order metafields (and legacy attributes for older orders) through the
// Admin API; read-only.

import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { formatRescheduledAt } from "./format-timestamp";

export default async () => {
  const orderId = shopify.data.selected?.[0]?.id;
  if (!orderId) { render(<EmptyBlock />, document.body); return; }
  const order = await fetchOrderDelivery(orderId);
  render(<DeliveryBlock order={order} />, document.body);
};

async function fetchOrderDelivery(id) {
  // Read delivery data directly from Admin so the block shows the latest saved order
  // state without depending on storefront or customer-account caching behavior.
  const res = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    body: JSON.stringify({
      // `shop { ianaTimezone }` is read so the reschedule timestamp can be
      // shown in the shop's day rather than raw UTC — see format-timestamp.js.
      query: "query GetOrderDelivery($id: ID!) { shop { ianaTimezone } order(id: $id) { customAttributes { key value } deliveryDate: metafield(namespace: \"custom\", key: \"date\") { value } timeSlot: metafield(namespace: \"custom\", key: \"time_slot\") { value } rescheduleRequestedAt: metafield(namespace: \"$app\", key: \"reschedule_requested_at\") { value } rescheduleStatus: metafield(namespace: \"$app\", key: \"reschedule_status\") { value } } }",
      variables: { id },
    }),
  });
  const json = await res.json();
  const o = json.data?.order ?? null;
  if (!o) return null;
  // Fall back to legacy order attributes so older orders still render in admin while
  // newer orders use the metafield-based delivery contract.
  const attr = (key) => o.customAttributes?.find((a) => a.key === key)?.value ?? null;
  return {
    deliveryDate: o.deliveryDate?.value ?? attr("Delivery Date"),
    timeSlot: o.timeSlot?.value ?? attr("Delivery Time"),
    rescheduleRequestedAt: o.rescheduleRequestedAt?.value ?? null,
    rescheduleStatus: o.rescheduleStatus?.value ?? null,
    shopTimezone: json.data?.shop?.ianaTimezone ?? null,
  };
}

function EmptyBlock() {
  return (
    <s-admin-block heading="Delivery Schedule">
      <s-text color="subdued">No order selected.</s-text>
    </s-admin-block>
  );
}

function DeliveryBlock({ order }) {
  if (!order || (!order.deliveryDate && !order.timeSlot)) {
    return (
      <s-admin-block heading="Delivery Schedule">
        <s-text color="subdued">No delivery schedule set for this order.</s-text>
      </s-admin-block>
    );
  }
  return (
    <s-admin-block heading="Delivery Schedule">
      <s-stack direction="block" gap="base">
        {order.deliveryDate && (
          <s-stack direction="block" gap="small">
            <s-text color="subdued">Delivery date</s-text>
            <s-text type="strong">{order.deliveryDate}</s-text>
          </s-stack>
        )}
        {order.timeSlot && (
          <s-stack direction="block" gap="small">
            <s-text color="subdued">Time slot</s-text>
            <s-text>{order.timeSlot}</s-text>
          </s-stack>
        )}
        {order.rescheduleStatus === "confirmed" && order.rescheduleRequestedAt && (
          <s-stack direction="block" gap="small">
            <s-text color="subdued">Rescheduled at</s-text>
            <s-text>
              {formatRescheduledAt(order.rescheduleRequestedAt, order.shopTimezone)}
            </s-text>
          </s-stack>
        )}
      </s-stack>
    </s-admin-block>
  );
}

