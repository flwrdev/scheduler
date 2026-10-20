// Confirmation modal for marking the selected orders as paid (the `markAsPaid` bulk action).

import { AppModal } from "../ui/AppModal";

export interface MarkAsPaidModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

// Asks the merchant to confirm before the selected orders are marked as paid.
export function MarkAsPaidModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  onConfirm,
}: MarkAsPaidModalProps) {
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Mark orders as paid?"
      primaryAction={{
        content: isSubmitting
          ? "Marking as paid…"
          : `Mark ${selectedCount} ${selectedCount === 1 ? "order" : "orders"} as paid`,
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-banner tone="warning">
        {selectedCount} {selectedCount === 1 ? "order" : "orders"} will be
        marked as paid. You can’t undo this here.
      </s-banner>
    </AppModal>
  );
}
