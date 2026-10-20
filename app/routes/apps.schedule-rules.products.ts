// App proxy endpoint that returns the products of one collection through the Storefront API,
// for the storefront's "Show more" pagination. Needs SHOPIFY_STOREFRONT_ACCESS_TOKEN; without
// it only this route fails.

import type { LoaderFunctionArgs } from "react-router";

import { verifyAppProxySignature } from "../lib/verify-app-proxy.server";
import { apiVersion } from "../shopify.server";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 24;

type Money = { amount: string; currencyCode: string };

type ProductEdge = {
  cursor: string;
  node: {
    id: string;
    title: string;
    handle: string;
    availableForSale: boolean;
    priceRange?: { minVariantPrice?: Money | null } | null;
    compareAtPriceRange?: { minVariantPrice?: Money | null } | null;
    featuredImage?: { url: string; altText: string | null; width: number; height: number } | null;
  };
};

// Storefront (not Admin) GraphQL: only returns products actually published +
// purchasable on this sales channel, so no manual draft/archived/inventory
// filtering is needed here the way the old Admin-API version required.
const PRODUCTS_QUERY = `#graphql
  query CollectionProducts($handle: String!, $first: Int!, $after: String) {
    collections(first: 1, query: $handle) {
      nodes {
        products(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            cursor
            node {
              id
              title
              handle
              availableForSale
              priceRange {
                minVariantPrice {
                  amount
                  currencyCode
                }
              }
              compareAtPriceRange {
                minVariantPrice {
                  amount
                  currencyCode
                }
              }
              featuredImage {
                url
                altText
                width
                height
              }
            }
          }
        }
      }
    }
  }
`;

async function queryStorefront(shop: string, variables: Record<string, unknown>) {
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("SHOPIFY_STOREFRONT_ACCESS_TOKEN is not configured");
  }

  // The merchant's token rotation (2026-08-25) issued a public-style Storefront
  // token (32-hex, admin custom app), which authenticates via the public header;
  // a Headless-channel private token (shpat_-prefixed) still gets the private
  // header, so either kind of token can be dropped into the secret.
  const tokenHeader = token.startsWith("shpat")
    ? "Shopify-Storefront-Private-Token"
    : "X-Shopify-Storefront-Access-Token";

  const response = await fetch(`https://${shop}/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [tokenHeader]: token,
    },
    body: JSON.stringify({ query: PRODUCTS_QUERY, variables }),
  });

  return response.json();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Verifying the signature by hand (instead of authenticate.public.appProxy)
  // means this route never touches session storage (Neon/Prisma) — that's
  // the point: this endpoint only serves public catalog data, so it shouldn't
  // pay for a DB round-trip on every cold start.
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !verifyAppProxySignature(url, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shop = url.searchParams.get("shop");
  const handle = url.searchParams.get("collection");
  const cursor = url.searchParams.get("cursor") || null;
  const rawLimit = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : Math.min(rawLimit, MAX_LIMIT);
  // `offset` lets the theme skip the products already server-rendered by Liquid
  // (cursor-based GraphQL has no numeric offset, so we over-fetch then slice).
  // Only honored on the first load (when there is no cursor yet).
  const rawOffset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset = !cursor && Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(rawOffset, MAX_LIMIT) : 0;

  if (!shop) {
    return Response.json({ error: "Missing shop" }, { status: 400 });
  }

  if (!handle) {
    return Response.json({ error: "Missing required param: collection" }, { status: 400 });
  }

  const fetchCount = Math.min(offset + limit, 250);

  let data;
  try {
    data = await queryStorefront(shop, {
      handle: `handle:${handle}`,
      first: fetchCount,
      after: cursor,
    });
  } catch {
    return Response.json({ error: "Storefront API request failed" }, { status: 502 });
  }

  if (data?.errors) {
    return Response.json({ error: "Storefront API request failed" }, { status: 502 });
  }

  const collection = data?.data?.collections?.nodes?.[0];

  if (!collection) {
    return Response.json({ error: "Collection not found" }, { status: 404 });
  }

  const edges: ProductEdge[] = collection.products.edges ?? [];
  const apiHasNextPage = collection.products.pageInfo?.hasNextPage ?? false;

  // Resume from the cursor of the LAST item we actually returned (not the last
  // fetched), so the next batch doesn't skip or duplicate products.
  const afterOffset = offset > 0 ? edges.slice(offset) : edges;

  // Trim to the requested `limit` (we over-fetched by `offset` to skip
  // products already server-rendered by Liquid).
  const pageEdges = afterOffset.slice(0, limit);
  const trimmed = afterOffset.length > limit;

  // There's a next page if we trimmed items off this batch, or if the API
  // itself reports more pages beyond what we fetched.
  const hasNextPage = trimmed || apiHasNextPage;
  const nextCursor = hasNextPage && pageEdges.length > 0
    ? pageEdges[pageEdges.length - 1].cursor
    : null;

  const products = pageEdges.map((e) => {
    const p = e.node;
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      availableForSale: p.availableForSale,
      priceRange: { minVariantPrice: p.priceRange?.minVariantPrice ?? null },
      compareAtPriceRange: { minVariantPrice: p.compareAtPriceRange?.minVariantPrice ?? null },
      featuredImage: p.featuredImage,
    };
  });

  return Response.json(
    {
      products,
      nextCursor,
      hasNextPage,
    },
    {
      headers: { "Cache-Control": "public, max-age=60" },
    }
  );
};
