// Layout route for every page under /app. Authenticates the merchant with authenticate.admin,
// loads App Bridge and the Polaris web components through AppProvider, renders the navigation
// menu (Order operations, Delivery Scheduler) and keeps the `host`/`shop` parameters on links.
// If `host` is missing it redirects through /app so App Bridge can re-initialise.

import {
  Link,
  Outlet,
  redirect,
  useLoaderData,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import {
  buildEmbeddedAppPath,
  buildEmbeddedBootstrapPath,
} from "../lib/embedded-route";
import { POLARIS_URL } from "../lib/polaris-url";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const shop = session?.shop ?? url.searchParams.get("shop");
  const isEmbeddedEntry = url.pathname === "/app" || url.pathname === "/app/";

  if (!host && shop && !isEmbeddedEntry) {
    return redirect(
      buildEmbeddedBootstrapPath(url.pathname, url.searchParams, shop),
    );
  }

  // Give the page the Shopify API key so the app can load inside the Shopify admin.
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const [searchParams] = useSearchParams();
  const ordersHref = buildEmbeddedAppPath("/app/orders", searchParams);
  const schedulerHref = buildEmbeddedAppPath("/app/scheduler", searchParams);

  return (
    <AppProvider apiKey={apiKey} polarisUrl={POLARIS_URL}>
      <ui-nav-menu>
        <Link to={ordersHref} rel="home">Order operations</Link>
        <Link to={schedulerHref}>Delivery Scheduler</Link>
      </ui-nav-menu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
