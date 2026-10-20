// Modal for fulfilling the selected orders, with an optional tracking URL and a choice to notify
// the customers (the `markFulfilled` bulk action).

import { flag } from "../../lib/web-component-props";
import { AppModal } from "../ui/AppModal";

export interface MarkFulfilledModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  fulfillTrackingUrl: string;
  setFulfillTrackingUrl: (value: string) => void;
  fulfillNotify: boolean;
  setFulfillNotify: (value: boolean) => void;
  onConfirm: () => void;
}

// Shows the tracking URL field and the notify checkbox. The parent keeps the form values.
export function MarkFulfilledModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  fulfillTrackingUrl,
  setFulfillTrackingUrl,
  fulfillNotify,
  setFulfillNotify,
  onConfirm,
}: MarkFulfilledModalProps) {
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Mark orders as fulfilled?"
      primaryAction={{
        content: isSubmitting
          ? "Fulfilling…"
          : `Mark ${selectedCount} ${selectedCount === 1 ? "order" : "orders"} fulfilled`,
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-stack gap="base">
        <s-banner tone="warning">
          This creates a Shopify fulfillment for {selectedCount}{" "}
          {selectedCount === 1 ? "order" : "orders"}.
        </s-banner>
        <s-text-field
          label="Tracking URL (optional)"
          placeholder="https://tracking.example.com/…"
          autocomplete="off"
          value={fulfillTrackingUrl}
          onInput={(e) => setFulfillTrackingUrl(e.currentTarget.value)}
        />
        <s-checkbox
          label="Notify customer by email"
          checked={flag(fulfillNotify)}
          onInput={(e) => setFulfillNotify(e.currentTarget.checked)}
        />
      </s-stack>
    </AppModal>
  );
}
