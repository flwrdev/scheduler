// Hook that listens for a custom event on a Polaris web component (for example `hide` on
// `<s-modal>` or `nextpage` on `<s-table>`). React 18 does not wire up `onHide`-style props on
// web components, so the listener is added to the element directly.

import { useEffect, useRef, type RefObject } from "react";

// Adds a listener for `eventName` to the element in `ref` while the component is mounted.
// The latest `handler` is always the one that runs, so callers do not need to memoise it.
export function useWebComponentEvent(
  ref: RefObject<HTMLElement | null>,
  eventName: string,
  handler: (event: Event) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (event: Event) => handlerRef.current(event);
    element.addEventListener(eventName, listener);
    return () => element.removeEventListener(eventName, listener);
  }, [ref, eventName]);
}
