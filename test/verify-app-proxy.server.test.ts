import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyAppProxySignature } from "../app/lib/verify-app-proxy.server";

const SECRET = "hush";

// Mirrors Shopify's own reference algorithm (sort remaining query keys,
// concatenate "key=value" with no separator, HMAC-SHA256 hex digest) so tests
// build fixtures the same way a real Shopify-forwarded request would be signed.
// https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
function sign(params: URLSearchParams, secret: string): string {
  const sorted = [...new Set(params.keys())]
    .sort()
    .map((key) => `${key}=${params.getAll(key).join(",")}`)
    .join("");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

function buildSignedUrl(
  extraParams: Record<string, string>,
  { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {},
): URL {
  const params = new URLSearchParams({
    shop: "example.myshopify.com",
    path_prefix: "/apps/schedule-rules",
    timestamp: String(timestamp),
    ...extraParams,
  });
  params.set("signature", sign(params, secret));
  return new URL(`https://app.example.com/apps/schedule-rules/products?${params.toString()}`);
}

describe("verifyAppProxySignature", () => {
  it("accepts a correctly signed, freshly timestamped request", () => {
    const url = buildSignedUrl({ collection: "featured" });
    expect(verifyAppProxySignature(url, SECRET)).toBe(true);
  });

  it("accepts multi-value query params joined with a comma", () => {
    const params = new URLSearchParams();
    params.append("extra", "1");
    params.append("extra", "2");
    params.set("shop", "example.myshopify.com");
    params.set("timestamp", String(Math.floor(Date.now() / 1000)));
    params.set("signature", sign(params, SECRET));
    const url = new URL(`https://app.example.com/apps/schedule-rules/products?${params.toString()}`);
    expect(verifyAppProxySignature(url, SECRET)).toBe(true);
  });

  it("rejects a request signed with the wrong secret", () => {
    const url = buildSignedUrl({ collection: "featured" }, { secret: "wrong-secret" });
    expect(verifyAppProxySignature(url, SECRET)).toBe(false);
  });

  it("rejects a tampered query param (signature no longer matches)", () => {
    const url = buildSignedUrl({ collection: "featured" });
    url.searchParams.set("collection", "clearance");
    expect(verifyAppProxySignature(url, SECRET)).toBe(false);
  });

  it("rejects a request with no signature param", () => {
    const url = new URL("https://app.example.com/apps/schedule-rules/products?shop=example.myshopify.com");
    expect(verifyAppProxySignature(url, SECRET)).toBe(false);
  });

  it("rejects a non-hex signature value", () => {
    const url = buildSignedUrl({ collection: "featured" });
    url.searchParams.set("signature", "not-hex!!");
    expect(verifyAppProxySignature(url, SECRET)).toBe(false);
  });

  it("rejects a stale timestamp outside the freshness window", () => {
    const url = buildSignedUrl({ collection: "featured" }, { timestamp: 1317327555 });
    expect(verifyAppProxySignature(url, SECRET)).toBe(false);
  });

  it("rejects a timestamp from the future beyond the freshness window", () => {
    const farFuture = Math.floor(Date.now() / 1000) + 60 * 60;
    const url = buildSignedUrl({ collection: "featured" }, { timestamp: farFuture });
    expect(verifyAppProxySignature(url, SECRET)).toBe(false);
  });
});
