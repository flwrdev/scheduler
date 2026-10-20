// Admin order action that shows the order's reschedule status (status, date, slot and when it
// was requested). It
// is read-only: it reads the order metafields through the Admin API and changes nothing.

import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { formatRescheduledAt } from "./format-timestamp";

export default async () => {
  const orderId = shopify.data.selected?.[0]?.id;
  if (!orderId) {
    render(<NoOrderSelected />, document.body);
    return;
  }

  const info = await fetchRescheduleInfo(orderId);
  render(<RescheduleStatusAction info={info} />, document.body);
};

async function fetchRescheduleInfo(id) {
  // This admin action is a read-only status view, so it queries the order metafields
  // directly instead of duplicating any reschedule logic inside the extension itself.
  const res = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    body: JSON.stringify({
      // `shop { ianaTimezone }` is read so the reschedule timestamp can be
      // shown in the shop's day rather than raw UTC — see format-timestamp.js.
      query:
        "query GetReschedule($id: ID!) { shop { ianaTimezone } order(id: $id) { rescheduleStatus: metafield(namespace: \"$app\", key: \"reschedule_status\") { value } rescheduleDate: metafield(namespace: \"custom\", key: \"date\") { value } rescheduleTimeSlot: metafield(namespace: \"custom\", key: \"time_slot\") { value } requestedAt: metafield(namespace: \"$app\", key: \"reschedule_requested_at\") { value } } }",
      variables: { id },
    }),
  });
  const json = await res.json();
  const o = json.data?.order ?? null;
  if (!o) return null;
  return {
    status: o.rescheduleStatus?.value ?? null,
    date: o.rescheduleDate?.value ?? null,
    timeSlot: o.rescheduleTimeSlot?.value ?? null,
    requestedAt: o.requestedAt?.value ?? null,
    shopTimezone: json.data?.shop?.ianaTimezone ?? null,
  };
}

function NoOrderSelected() {
  return (
    <s-admin-action heading="Reschedule Status">
      <s-text>No order selected.</s-text>
      <s-button slot="secondary-actions" onClick={shopify.close}>
        Close
      </s-button>
    </s-admin-action>
  );
}

function RescheduleStatusAction({ info }) {
  if (!info || !info.status) {
    return (
      <s-admin-action heading="Reschedule Status">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            No reschedule has been recorded for this order.
          </s-text>
        </s-stack>
        <s-button slot="secondary-actions" onClick={shopify.close}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  if (info.status === "confirmed") {
    return (
      <s-admin-action heading="Reschedule Status">
        <s-stack direction="block" gap="base">
          <s-banner tone="success">
            This delivery was rescheduled and confirmed automatically.
          </s-banner>
          {info.date && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Delivery date</s-text>
              <s-text>{info.date}</s-text>
            </s-stack>
          )}
          {info.timeSlot && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Time slot</s-text>
              <s-text>{info.timeSlot}</s-text>
            </s-stack>
          )}
          {info.requestedAt && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Rescheduled at</s-text>
              <s-text>
                {formatRescheduledAt(info.requestedAt, info.shopTimezone)}
              </s-text>
            </s-stack>
          )}
        </s-stack>
        <s-button slot="secondary-actions" onClick={shopify.close}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  if (info.status === "rejected") {
    return (
      <s-admin-action heading="Reschedule Status">
        <s-stack direction="block" gap="base">
          <s-banner tone="critical">
            This reschedule request was rejected.
          </s-banner>
          {info.date && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Requested date</s-text>
              <s-text>{info.date}</s-text>
            </s-stack>
          )}
          {info.timeSlot && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Requested time slot</s-text>
              <s-text>{info.timeSlot}</s-text>
            </s-stack>
          )}
          {info.requestedAt && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Updated at</s-text>
              <s-text>
                {formatRescheduledAt(info.requestedAt, info.shopTimezone)}
              </s-text>
            </s-stack>
          )}
        </s-stack>
        <s-button slot="secondary-actions" onClick={shopify.close}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  if (info.status === "pending") {
    return (
      <s-admin-action heading="Reschedule Status">
        <s-stack direction="block" gap="base">
          <s-text>
            This order still has a legacy pending reschedule status. Pending approval is no longer supported.
          </s-text>
          {info.date && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Requested date</s-text>
              <s-text>{info.date}</s-text>
            </s-stack>
          )}
          {info.timeSlot && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Requested time slot</s-text>
              <s-text>{info.timeSlot}</s-text>
            </s-stack>
          )}
          {info.requestedAt && (
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Requested at</s-text>
              <s-text>
                {formatRescheduledAt(info.requestedAt, info.shopTimezone)}
              </s-text>
            </s-stack>
          )}
        </s-stack>
        <s-button slot="secondary-actions" onClick={shopify.close}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  return (
    <s-admin-action heading="Reschedule Status">
      <s-stack direction="block" gap="base">
        <s-text color="subdued">Current reschedule status: {info.status}.</s-text>
      </s-stack>
      <s-button slot="secondary-actions" onClick={shopify.close}>
        Close
      </s-button>
    </s-admin-action>
  );
}
