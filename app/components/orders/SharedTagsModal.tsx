// Modal titled "Attributes" that lists the tags passed to it.

import { tagDisplayLabel } from "../../lib/order-utils";
import { AppModal } from "../ui/AppModal";

export interface SharedTagsModalProps {
  open: boolean;
  onClose: () => void;
  tags: string[];
}

// One modal shared by every table row. It shows the tags of the row the merchant picked.
export function SharedTagsModal({ open, onClose, tags }: SharedTagsModalProps) {
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Attributes"
      primaryAction={{ content: "Close", onAction: onClose }}
    >
      {tags.length === 0 ? (
        <s-paragraph color="subdued">No tags on this order.</s-paragraph>
      ) : (
        <s-stack direction="inline" gap="small-300">
          {tags.map((tag) => (
            <s-chip key={tag}>{tagDisplayLabel(tag)}</s-chip>
          ))}
        </s-stack>
      )}
    </AppModal>
  );
}
