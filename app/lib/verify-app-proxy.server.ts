// Verifies the signature Shopify adds to app proxy requests (an HMAC-SHA256 of the sorted query
// parameters, signed with the app secret) and rejects signatures older than five minutes.
// Used by app proxy routes that answer without loading a session.

import crypto from "node:crypto";

// Shopify signs app proxy requests with an HMAC-SHA256 hex digest of every
// query param except `signature` itself, sorted by key and concatenated with
// no separator (per https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies).
// Verifying this manually (instead of authenticate.public.appProxy) lets a
// route skip the session-storage lookup entirely.
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

export function verifyAppProxySignature(url: URL, secret: string): boolean {
  const params = new URLSearchParams(url.search);
  const signature = params.get("signature");
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  params.delete("signature");

  const sortedParams = [...new Set(params.keys())]
    .sort()
    .map((key) => `${key}=${params.getAll(key).join(",")}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(sortedParams).digest("hex");

  const signatureBuffer = Buffer.from(signature, "hex");
  const digestBuffer = Buffer.from(digest, "hex");
  if (signatureBuffer.length !== digestBuffer.length) return false;
  if (!crypto.timingSafeEqual(signatureBuffer, digestBuffer)) return false;

  const timestamp = Number(params.get("timestamp"));
  if (!Number.isFinite(timestamp)) return false;
  const ageSeconds = Date.now() / 1000 - timestamp;
  return ageSeconds >= 0 && ageSeconds <= MAX_SIGNATURE_AGE_SECONDS;
}
