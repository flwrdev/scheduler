// A checkbox whose ticked and half-ticked state always follows the props. The Polaris
// `<s-checkbox>` keeps its own state after the merchant clicks it, so this component also sets
// the state on the element itself every time it renders. That way a selection cleared by the
// parent (after a bulk action or a tab change) is shown correctly.

import { useEffect, useRef } from "react";
import { flag } from "../../lib/web-component-props";

export interface ControlledCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  onToggle: (checked: boolean) => void;
}

export function ControlledCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  accessibilityLabel,
  onToggle,
}: ControlledCheckboxProps) {
  const ref = useRef<HTMLElementTagNameMap["s-checkbox"]>(null);

  // Pushes the latest ticked and half-ticked state onto the element.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    customElements.whenDefined("s-checkbox").then(() => {
      element.checked = checked;
      element.indeterminate = indeterminate;
    });
  }, [checked, indeterminate]);

  return (
    <s-checkbox
      ref={ref}
      accessibilityLabel={accessibilityLabel}
      checked={flag(checked)}
      indeterminate={flag(indeterminate)}
      disabled={flag(disabled)}
      onInput={(e) => onToggle(e.currentTarget.checked)}
    />
  );
}
