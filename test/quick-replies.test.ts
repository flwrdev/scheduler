import { describe, expect, it, vi } from "vitest";

import {
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_LABEL,
  parseQuickReplies,
  validateQuickReplies,
} from "../app/lib/quick-replies";
import {
  readQuickReplies,
  saveQuickReplies,
} from "../app/services/quick-replies.server";

function adminReturning(...responses: unknown[]) {
  const graphql = vi.fn();
  for (const r of responses) {
    graphql.mockResolvedValueOnce(new Response(JSON.stringify(r)));
  }
  return { graphql };
}

describe("validateQuickReplies", () => {
  it("trims and keeps the merchant's order", () => {
    const result = validateQuickReplies([
      { label: " Cancel ", message: " Your order is cancelled. " },
      { label: "Address", message: "Noted the new address." },
    ]);
    expect(result).toEqual({
      ok: true,
      replies: [
        { label: "Cancel", message: "Your order is cancelled." },
        { label: "Address", message: "Noted the new address." },
      ],
    });
  });

  it("accepts an empty list", () => {
    expect(validateQuickReplies([])).toEqual({ ok: true, replies: [] });
  });

  it("flags blank and too-long fields per row", () => {
    const result = validateQuickReplies([
      { label: "ok", message: "fine" },
      { label: "", message: "  " },
      { label: "x".repeat(MAX_QUICK_REPLY_LABEL + 1), message: "m" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors)).toEqual(["1", "2"]);
    expect(result.fieldErrors[1]).toEqual({
      label: "Enter a label.",
      message: "Enter a message.",
    });
    expect(result.fieldErrors[2].label).toBeDefined();
  });

  it("rejects non-lists and too many rows", () => {
    expect(validateQuickReplies({}).ok).toBe(false);
    const many = Array.from({ length: MAX_QUICK_REPLIES + 1 }, () => ({
      label: "a",
      message: "b",
    }));
    expect(validateQuickReplies(many).ok).toBe(false);
  });
});

describe("parseQuickReplies", () => {
  it("drops malformed entries and bad JSON", () => {
    expect(parseQuickReplies(null)).toEqual([]);
    expect(parseQuickReplies("not json")).toEqual([]);
    expect(parseQuickReplies('{"label":"a"}')).toEqual([]);
    expect(
      parseQuickReplies(
        JSON.stringify([
          { label: "a", message: "b", extra: 1 },
          { label: "", message: "b" },
          { label: "c" },
          null,
        ]),
      ),
    ).toEqual([{ label: "a", message: "b" }]);
  });
});

describe("quick replies shop metafield", () => {
  it("reads the replies from the shop", async () => {
    const admin = adminReturning({
      data: {
        shop: {
          id: "gid://shopify/Shop/1",
          quickReplies: { value: JSON.stringify([{ label: "a", message: "b" }]) },
        },
      },
    });
    expect(await readQuickReplies(admin)).toEqual({
      ok: true,
      replies: [{ label: "a", message: "b" }],
    });
  });

  it("writes the list as a json $app metafield on the shop", async () => {
    const admin = adminReturning(
      { data: { shop: { id: "gid://shopify/Shop/1", quickReplies: null } } },
      { data: { metafieldsSet: { metafields: [{ value: "[]" }], userErrors: [] } } },
    );
    const replies = [{ label: "Cancel", message: "Cancelled po." }];
    expect(await saveQuickReplies(admin, replies)).toEqual({ ok: true, replies });
    expect(admin.graphql.mock.calls[1][1].variables.metafields).toEqual([
      {
        ownerId: "gid://shopify/Shop/1",
        namespace: "$app",
        key: "quick_replies",
        type: "json",
        value: JSON.stringify(replies),
      },
    ]);
  });

  it("reports Shopify user errors", async () => {
    const admin = adminReturning(
      { data: { shop: { id: "gid://shopify/Shop/1" } } },
      { data: { metafieldsSet: { userErrors: [{ message: "Value is invalid" }] } } },
    );
    const result = await saveQuickReplies(admin, []);
    expect(result).toEqual({
      ok: false,
      message: "Couldn't save quick replies: Value is invalid",
    });
  });
});
