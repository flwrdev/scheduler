// Thin redirect stub (Scheduler V2 §7): the old editor URL now lands on the
// merged /app/scheduler page. Embedded query params (host/shop/…) are
// preserved so App Bridge keeps its context. Old #section-* anchors are hash
// state the server never sees — the merged page's cards cover the same ground.

import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const query = url.searchParams.toString();
  return redirect(`/app/scheduler${query ? `?${query}` : ""}`);
};

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) =>
  boundary.headers(headersArgs);
