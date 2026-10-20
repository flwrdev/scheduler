// Modal for cancelling the selected orders (the `cancel` bulk action). Asks for the reason and
// whether to restock the items and notify the customers by email.

import { flag } from "../../lib/web-component-props";
import { AppModal } from "../ui/AppModal";

export interface CancelModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  cancelReason: string;
  setCancelReason: (value: string) => void;
  cancelRestock: boolean;
  setCancelRestock: (value: boolean) => void;
  cancelNotify: boolean;
  setCancelNotify: (value: boolean) => void;
  cancelStaffNote: string;
  setCancelStaffNote: (value: string) => void;
  onConfirm: () => void;
}

const CANCEL_REASON_OPTIONS = [
  { label: "Customer request", value: "CUSTOMER" },
  { label: "Insufficient inventory", value: "INVENTORY" },
  { label: "Payment declined", value: "DECLINED" },
  { label: "Fraud", value: "FRAUD" },
  { label: "Staff error", value: "STAFF" },
  { label: "Other", value: "OTHER" },
];

// Shows a warning and the cancel options. The parent keeps the form values.
export function CancelModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  cancelReason,
  setCancelReason,
  cancelRestock,
  setCancelRestock,
  cancelNotify,
  setCancelNotify,
  cancelStaffNote,
  setCancelStaffNote,
  onConfirm,
}: CancelModalProps) {
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Cancel orders?"
      primaryAction={{
        content: isSubmitting
          ? "Cancelling…"
          : `Cancel ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`,
        onAction: onConfirm,
        destructive: true,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Keep orders", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-stack gap="base">
        <s-banner tone="critical">
          {selectedCount} {selectedCount === 1 ? "order" : "orders"} will be
          cancelled. You can’t undo this.
        </s-banner>
        <s-select
          label="Reason"
          value={cancelReason}
          onInput={(e) => setCancelReason(e.currentTarget.value)}
        >
          {CANCEL_REASON_OPTIONS.map((option) => (
            <s-option key={option.value} value={option.value}>
              {option.label}
            </s-option>
          ))}
        </s-select>
        <s-checkbox
          label="Restock items"
          checked={flag(cancelRestock)}
          onInput={(e) => setCancelRestock(e.currentTarget.checked)}
        />
        <s-checkbox
          label="Notify customers by email"
          checked={flag(cancelNotify)}
          onInput={(e) => setCancelNotify(e.currentTarget.checked)}
        />
        <s-text-field
          label="Staff note (optional)"
          autocomplete="off"
          maxLength={255}
          value={cancelStaffNote}
          onInput={(e) => setCancelStaffNote(e.currentTarget.value)}
        />
      </s-stack>
    </AppModal>
  );
}
