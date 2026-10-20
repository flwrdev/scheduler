// Small helpers for passing props to the Polaris web components (the `<s-*>` elements).

// Turns a true/false value into `true` or `undefined`. React writes `disabled={false}` on a web
// component as the text "false", which the element may read as "on". Passing `undefined`
// leaves the attribute off, so the element stays in its normal state.
export function flag(value: boolean | null | undefined): true | undefined {
  return value ? true : undefined;
}
