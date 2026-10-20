// Entry point of the embedded app (/app). Authenticates, then redirects to the page named in
// `returnTo` or to /app/orders. Shows a short "Reconnecting" screen when the embedded `host`
// parameter is missing.

import { redirect, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { sanitizeEmbeddedAppReturnTo } from "../lib/embedded-route";

function buildInitialEmbeddedRedirectPath(destination, currentSearchParams) {
  const target = new URL(destination, "https://embedded-app.local");
  const nextSearchParams = new URLSearchParams(currentSearchParams);

  for (const [key, value] of target.searchParams.entries()) {
    nextSearchParams.set(key, value);
  }

  const query = nextSearchParams.toString();
  return query ? `${target.pathname}?${query}` : target.pathname;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const shop = session?.shop ?? url.searchParams.get("shop");
  const destination =
    sanitizeEmbeddedAppReturnTo(url.searchParams.get("returnTo")) ??
    "/app/orders";

  if (!host && shop) {
    return Response.json(
      {
        isReconnecting: true,
        destination,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return redirect(
    buildInitialEmbeddedRedirectPath(destination, url.searchParams),
  );
};

export default function Index() {
  const data = useLoaderData();

  if (!data?.isReconnecting) {
    return null;
  }

  return (
    <s-page heading="Reconnecting to Shopify">
      <s-section>
        <s-paragraph>
          Reinitializing the embedded app context. If this does not continue
          automatically, reopen the app from Shopify Admin.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export function ErrorBoundary() {
  const error = useRouteError();
  const isAuthError =
    error instanceof Response && (error.status === 401 || error.status === 403);

  return (
    <div
      style={{
        padding: "2rem",
        textAlign: "center",
        fontFamily: "sans-serif",
        color: "#333",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>Unable to load the app</h2>
      <p style={{ color: "#666", marginBottom: "1.25rem" }}>
        {isAuthError
          ? "Your session has expired or access was denied."
          : "Something went wrong while starting the app."}{" "}
        Please reload to try again.
      </p>
      <button
        onClick={() => window.location.reload()}
        style={{
          padding: "0.5rem 1.25rem",
          cursor: "pointer",
          borderRadius: "4px",
          border: "1px solid #ccc",
        }}
      >
        Reload
      </button>
    </div>
  );
}
