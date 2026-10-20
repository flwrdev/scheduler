// Helpers for building URLs inside the embedded app. Shopify passes `host` and `shop` query
// parameters that App Bridge needs, so links must carry them. sanitizeEmbeddedAppReturnTo only
// accepts paths under /app, which prevents open redirects through `returnTo`.

const EMBEDDED_ROUTE_PARAM_KEYS = ["host", "shop"];
const EMBEDDED_APP_ROOT = "/app";

function toSearchParams(currentSearchParams) {
  return currentSearchParams instanceof URLSearchParams
    ? currentSearchParams
    : new URLSearchParams(currentSearchParams ?? "");
}

export function buildEmbeddedAppPath(path, currentSearchParams) {
  const targetUrl = new URL(path, "https://embedded-app.local");
  const sourceParams = toSearchParams(currentSearchParams);

  for (const key of EMBEDDED_ROUTE_PARAM_KEYS) {
    const value = sourceParams.get(key);
    if (value && !targetUrl.searchParams.has(key)) {
      targetUrl.searchParams.set(key, value);
    }
  }

  const query = targetUrl.searchParams.toString();
  return `${targetUrl.pathname}${query ? `?${query}` : ""}${targetUrl.hash}`;
}

export function sanitizeEmbeddedAppReturnTo(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const targetUrl = new URL(value, "https://embedded-app.local");
    if (
      targetUrl.origin !== "https://embedded-app.local" ||
      !targetUrl.pathname.startsWith(`${EMBEDDED_APP_ROOT}/`)
    ) {
      return null;
    }

    const query = targetUrl.searchParams.toString();
    return `${targetUrl.pathname}${query ? `?${query}` : ""}${targetUrl.hash}`;
  } catch {
    return null;
  }
}

export function buildEmbeddedBootstrapPath(pathname, currentSearchParams, shop) {
  const sourceParams = toSearchParams(currentSearchParams);
  const returnToParams = new URLSearchParams(sourceParams);

  for (const key of [...EMBEDDED_ROUTE_PARAM_KEYS, "returnTo"]) {
    returnToParams.delete(key);
  }

  const returnTo = sanitizeEmbeddedAppReturnTo(
    `${pathname}${returnToParams.toString() ? `?${returnToParams}` : ""}`,
  );
  const bootstrapParams = new URLSearchParams();

  if (shop) {
    bootstrapParams.set("shop", shop);
  }

  if (returnTo && returnTo !== EMBEDDED_APP_ROOT) {
    bootstrapParams.set("returnTo", returnTo);
  }

  const query = bootstrapParams.toString();
  return `${EMBEDDED_APP_ROOT}${query ? `?${query}` : ""}`;
}
