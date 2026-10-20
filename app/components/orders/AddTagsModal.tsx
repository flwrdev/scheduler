// Modal to add tags to the selected orders. The parent submits the `tagsAdd` bulk action.

import { AppModal } from "../ui/AppModal";

export interface AddTagsModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  addTagsInput: string;
  setAddTagsInput: (value: string) => void;
  onConfirm: () => void;
}

// Shows one text field where the merchant types the tags, separated by commas.
export function AddTagsModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  addTagsInput,
  setAddTagsInput,
  onConfirm,
}: AddTagsModalProps) {
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Add tags to selected orders"
      primaryAction={{
        content: isSubmitting ? "Adding…" : "Add tags",
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || !addTagsInput.trim() || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-stack gap="base">
        <s-paragraph>
          Add the tags below to {selectedCount}{" "}
          {selectedCount === 1 ? "order" : "orders"}.
        </s-paragraph>
        <s-text-field
          label="Tags (comma-separated)"
          placeholder="e.g. priority, vip, holiday"
          autocomplete="off"
          value={addTagsInput}
          onInput={(e) => setAddTagsInput(e.currentTarget.value)}
        />
      </s-stack>
    </AppModal>
  );
}
