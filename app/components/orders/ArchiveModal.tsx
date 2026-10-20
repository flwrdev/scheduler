// Confirmation modal for archiving the selected orders (the `archive` bulk action).

import { AppModal } from "../ui/AppModal";

export interface ArchiveModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

// Asks the merchant to confirm before the selected orders move to Archived.
export function ArchiveModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  onConfirm,
}: ArchiveModalProps) {
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Archive orders?"
      primaryAction={{
        content: isSubmitting
          ? "Archiving…"
          : `Archive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`,
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-banner tone="warning">
        {selectedCount} {selectedCount === 1 ? "order" : "orders"} will move to
        Archived. You can unarchive them anytime.
      </s-banner>
    </AppModal>
  );
}
