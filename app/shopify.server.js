// Shopify app setup and the single shared `shopify` object used by every route.
// Reads the API key, secret, scopes and app URL from environment variables, stores sessions
// in Postgres through PrismaSessionStorage, and runs as a single-merchant app.
// Also tells Shopify which Polaris script the pages load, so the browser can fetch it early.
// Exports authenticate (admin, webhook, public app proxy), login, unauthenticated and
// registerWebhooks. Routes call authenticate.* first; it rejects any request Shopify did not sign.

import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "./session-storage.server";
import prisma from "./db.server";
import { POLARIS_URL } from "./lib/polaris-url";

const prismaSessionStorage = new PrismaSessionStorage(prisma);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: prismaSessionStorage,
  distribution: AppDistribution.SingleMerchant,
  future: {
    expiringOfflineAccessTokens: true,
  },
  polarisUrl: POLARIS_URL,
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
