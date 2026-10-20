// Confirmation modal for unarchiving the selected orders (the `unarchive` bulk action).

import { AppModal } from "../ui/AppModal";

export interface UnarchiveModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

// Asks the merchant to confirm before the selected orders return to the main list.
export function UnarchiveModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  onConfirm,
}: UnarchiveModalProps) {
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Unarchive orders?"
      primaryAction={{
        content: isSubmitting
          ? "Unarchiving…"
          : `Unarchive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`,
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-banner tone="info">
        {selectedCount} {selectedCount === 1 ? "order" : "orders"} will show in
        the main list again.
      </s-banner>
    </AppModal>
  );
}
