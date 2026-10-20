// Reads and saves the merchant's quick email replies as a JSON shop metafield ($app.quick_replies).

import type { AdminGraphQLClient } from "./order-delivery-metafields.server";
import { type QuickReply, parseQuickReplies } from "../lib/quick-replies";

export const QUICK_REPLIES_METAFIELD = {
  namespace: "$app",
  key: "quick_replies",
  type: "json",
} as const;

const READ_QUICK_REPLIES_QUERY = `#graphql
  query QuickReplies {
    shop {
      id
      quickReplies: metafield(namespace: "$app", key: "quick_replies") {
        value
      }
    }
  }
`;

const SET_QUICK_REPLIES_MUTATION = `#graphql
  mutation SetQuickReplies($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { value }
      userErrors { field message code }
    }
  }
`;

export type QuickRepliesResult =
  | { ok: true; replies: QuickReply[] }
  | { ok: false; message: string };

interface ShopQuickReplies {
  id: string;
  quickReplies?: { value?: string | null } | null;
}

async function readShop(admin: AdminGraphQLClient): Promise<ShopQuickReplies> {
  const res = await admin.graphql(READ_QUICK_REPLIES_QUERY);
  const body = (await res.json()) as {
    data?: { shop?: ShopQuickReplies };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data?.shop?.id) throw new Error("Shop not found.");
  return body.data.shop;
}

export async function readQuickReplies(
  admin: AdminGraphQLClient,
): Promise<QuickRepliesResult> {
  try {
    const shop = await readShop(admin);
    return { ok: true, replies: parseQuickReplies(shop.quickReplies?.value) };
  } catch (e) {
    return {
      ok: false,
      message: `Couldn't load quick replies: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// metafieldsSet needs the owner's GID, and the session only carries the
// shop domain, so the shop id is read first.
export async function saveQuickReplies(
  admin: AdminGraphQLClient,
  replies: QuickReply[],
): Promise<QuickRepliesResult> {
  try {
    const shop = await readShop(admin);
    const res = await admin.graphql(SET_QUICK_REPLIES_MUTATION, {
      variables: {
        metafields: [
          {
            ownerId: shop.id,
            ...QUICK_REPLIES_METAFIELD,
            value: JSON.stringify(replies),
          },
        ],
      },
    });
    const body = (await res.json()) as {
      data?: {
        metafieldsSet?: {
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    const errors = [
      ...(body.errors?.map((e) => e.message) ?? []),
      ...(body.data?.metafieldsSet?.userErrors?.map((e) => e.message) ?? []),
    ];
    if (errors.length > 0) {
      return { ok: false, message: `Couldn't save quick replies: ${errors.join("; ")}` };
    }
    return { ok: true, replies };
  } catch (e) {
    return {
      ok: false,
      message: `Couldn't save quick replies: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
