import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      admin: { graphql: vi.fn() },
      session: { shop: "test-shop.myshopify.com" },
    }),
  },
}));

vi.mock("../app/services/bulk-actions.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/services/bulk-actions.server")>();
  return { ...actual, executeBulkAction: executeMock };
});

import { action, type BulkActionResponse } from "../app/routes/app.orders";
import { MAX_SELECTED_ORDER_IDS } from "../app/services/bulk-actions.server";

function archiveRequest(count: number): Request {
  const fd = new FormData();
  fd.set("_action", "archive");
  for (let i = 0; i < count; i++) {
    fd.append("orderId", `gid://shopify/Order/${1000 + i}`);
  }
  return new Request("https://app.example.com/app/orders", {
    method: "POST",
    body: fd,
  });
}

async function callAction(request: Request): Promise<{ status: number; body: BulkActionResponse }> {
  const response = await action({ request } as never);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockImplementation(async (_admin, _shop, _params, ids: string[]) =>
    ids.map((orderId) => ({ orderId, success: true })),
  );
});

describe("/app/orders action — bulk selection limit", () => {
  it("caps a selection at 10 orders", () => {
    expect(MAX_SELECTED_ORDER_IDS).toBe(10);
  });

  it(`runs up to ${MAX_SELECTED_ORDER_IDS} orders inline through the executor`, async () => {
    const { status, body } = await callAction(archiveRequest(MAX_SELECTED_ORDER_IDS));
    expect(status).toBe(200);
    expect(body.summary).toEqual({ ok: MAX_SELECTED_ORDER_IDS, failed: 0 });
    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      "test-shop.myshopify.com",
      { op: "archive" },
      expect.arrayContaining(["gid://shopify/Order/1000"]),
    );
  });

  it(`rejects more than ${MAX_SELECTED_ORDER_IDS} orders without executing anything`, async () => {
    const { status, body } = await callAction(archiveRequest(MAX_SELECTED_ORDER_IDS + 1));
    expect(status).toBe(400);
    expect(body.message).toBe(`Select ${MAX_SELECTED_ORDER_IDS} or fewer orders at a time.`);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
