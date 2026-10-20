// Catch-all OAuth route (/auth/*). authenticate.admin handles the OAuth redirect, callback and
// token exchange, so the loader itself only returns null.

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
