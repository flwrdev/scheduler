// Copies text to the clipboard and tracks the "Copied" feedback, for one value or per field.

import { useState, useCallback } from "react";

export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const [fieldCopied, setFieldCopied] = useState<string | null>(null);

  // Copy arbitrary text; drives the "Copy all delivery info" button state
  const copyText = useCallback(async (value: string): Promise<void> => {
    if (!value || value === "—") return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // clipboard unavailable — silently skip
    }
  }, []);

  // Copy a named field; drives per-field "Copied!" feedback
  const copyField = useCallback(
    async (fieldKey: string, value: string): Promise<void> => {
      if (!value || value === "—") return;
      try {
        await navigator.clipboard.writeText(value);
        setFieldCopied(fieldKey);
        setTimeout(() => setFieldCopied(null), 1500);
      } catch {
        // clipboard unavailable — silently skip
      }
    },
    [],
  );

  return { copied, fieldCopied, copyText, copyField };
}
