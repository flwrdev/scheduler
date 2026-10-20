// A modal dialog built on the Polaris `<s-modal>` element. The parent keeps a simple `open`
// flag. This component shows and hides the dialog to match the flag, and calls `onClose` when
// the merchant closes it with the X button, the Escape key or a click outside the dialog.
// Each dialog gets its own id, because Shopify admin finds a dialog by its id when it shows or
// hides it.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useWebComponentEvent } from "../../hooks/useWebComponentEvent";
import { flag } from "../../lib/web-component-props";

// One button in the footer of the modal.
export interface AppModalAction {
  content: string;
  onAction: () => void;
  disabled?: boolean;
  loading?: boolean;
  destructive?: boolean;
}

export interface AppModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  primaryAction?: AppModalAction;
  secondaryActions?: AppModalAction[];
  size?: "small" | "base" | "large";
  children: ReactNode;
}

// Shows the dialog while `open` is true. The content is only rendered while the dialog is open
// or still fading out, so each time it opens its fields start fresh.
export function AppModal({
  open,
  onClose,
  title,
  primaryAction,
  secondaryActions,
  size,
  children,
}: AppModalProps) {
  const modalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  // The id of this dialog. React's generated ids contain colons, so those are removed.
  const modalId = `app-modal-${useId().replace(/:/g, "")}`;
  const openRef = useRef(open);
  const wasOpenRef = useRef(false);
  const [contentMounted, setContentMounted] = useState(open);

  // Opens or closes the dialog element when the `open` flag changes.
  useEffect(() => {
    openRef.current = open;
    if (open) setContentMounted(true);
    if (!open && !wasOpenRef.current) return;
    wasOpenRef.current = open;

    const element = modalRef.current;
    if (!element) return;
    let cancelled = false;
    customElements.whenDefined("s-modal").then(() => {
      if (cancelled) return;
      if (open) element.showOverlay();
      else element.hideOverlay();
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // The dialog starts to hide. If the parent did not ask for it, the merchant closed it.
  useWebComponentEvent(modalRef, "hide", () => {
    if (openRef.current) onClose();
  });

  // The hide animation is done, so the content can be removed.
  useWebComponentEvent(modalRef, "afterhide", () => {
    if (!openRef.current) setContentMounted(false);
  });

  const showContent = open || contentMounted;

  return (
    <s-modal ref={modalRef} id={modalId} heading={title} size={size}>
      {showContent && children}
      {showContent && primaryAction && (
        <s-button
          slot="primary-action"
          variant="primary"
          tone={primaryAction.destructive ? "critical" : undefined}
          loading={flag(primaryAction.loading)}
          disabled={flag(primaryAction.disabled)}
          onClick={primaryAction.onAction}
        >
          {primaryAction.content}
        </s-button>
      )}
      {showContent &&
        secondaryActions?.map((action) => (
          <s-button
            key={action.content}
            slot="secondary-actions"
            loading={flag(action.loading)}
            disabled={flag(action.disabled)}
            onClick={action.onAction}
          >
            {action.content}
          </s-button>
        ))}
    </s-modal>
  );
}
