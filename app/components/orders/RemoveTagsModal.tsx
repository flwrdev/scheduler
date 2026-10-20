// Modal to remove tags from the selected orders. The parent submits the `tagsRemove` bulk action.

import { tagDisplayLabel } from "../../lib/order-utils";
import { AppModal } from "../ui/AppModal";

export interface RemoveTagsModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  removeTagsInput: string;
  setRemoveTagsInput: (value: string) => void;
  suggestedTags: string[];
  onConfirm: () => void;
}

// Shows a text field for the tags to remove, plus the tags found on the selected orders.
// Clicking a suggested tag adds its exact name to the field.
export function RemoveTagsModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  removeTagsInput,
  setRemoveTagsInput,
  suggestedTags,
  onConfirm,
}: RemoveTagsModalProps) {
  // Adds a suggested tag to the field unless it is already there.
  const appendSuggestion = (tag: string) => {
    const current = removeTagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (current.includes(tag)) return;
    setRemoveTagsInput([...current, tag].join(", "));
  };

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Remove tags from selected orders"
      primaryAction={{
        content: isSubmitting ? "Removing…" : "Remove tags",
        onAction: onConfirm,
        loading: isSubmitting,
        disabled:
          isSubmitting || !removeTagsInput.trim() || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-stack gap="base">
        <s-paragraph>
          Remove the tags below from {selectedCount}{" "}
          {selectedCount === 1 ? "order" : "orders"}.
        </s-paragraph>
        <s-text-field
          label="Tags (comma-separated)"
          placeholder="e.g. priority, vip"
          autocomplete="off"
          value={removeTagsInput}
          onInput={(e) => setRemoveTagsInput(e.currentTarget.value)}
        />
        {suggestedTags.length > 0 && (
          <s-stack gap="small-200">
            <s-text color="subdued">
              Tags on the selected orders — click to add:
            </s-text>
            <s-stack direction="inline" gap="small-300">
              {suggestedTags.map((tag) => (
                <s-clickable-chip
                  key={tag}
                  accessibilityLabel={`Add tag ${tagDisplayLabel(tag)}`}
                  onClick={() => appendSuggestion(tag)}
                >
                  {tagDisplayLabel(tag)}
                </s-clickable-chip>
              ))}
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </AppModal>
  );
}
