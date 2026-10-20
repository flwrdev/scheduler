// A Polaris `<s-banner>` that can be closed with its X button and can show one action button.
// React 18 does not pass the banner's `dismiss` event to `onDismiss`, so the event is wired here.

import { useRef, type ReactNode } from "react";
import { useWebComponentEvent } from "../../hooks/useWebComponentEvent";

export interface DismissibleBannerProps {
  heading: string;
  tone: "info" | "success" | "warning" | "critical";
  onDismiss?: () => void;
  action?: { content: string; onAction: () => void };
  children?: ReactNode;
}

export function DismissibleBanner({
  heading,
  tone,
  onDismiss,
  action,
  children,
}: DismissibleBannerProps) {
  const ref = useRef<HTMLElementTagNameMap["s-banner"]>(null);

  useWebComponentEvent(ref, "dismiss", () => onDismiss?.());

  return (
    <s-banner
      ref={ref}
      heading={heading}
      tone={tone}
      dismissible={onDismiss ? true : undefined}
    >
      {children}
      {action && (
        <s-button slot="secondary-actions" onClick={action.onAction}>
          {action.content}
        </s-button>
      )}
    </s-banner>
  );
}
