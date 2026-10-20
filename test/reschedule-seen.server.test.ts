import { describe, expect, it } from "vitest";

import {
  MAX_SEEN_ENTRIES,
  RESCHEDULE_SEEN_METAFIELD,
  handleMarkRescheduleSeenOp,
  parseMarkRescheduleSeenInput,
} from "../app/services/reschedule-seen.server";

type Call = { query: string; variables?: Record<string, unknown> };

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin(respond: (index: number) => unknown) {
  const calls: Call[] = [];
  const admin = {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ): Promise<Response> => {
      const index = calls.length;
      calls.push({ query, variables: options?.variables });
      const body = respond(index);
      if (body instanceof Error) throw body;
      return jsonResponse(body);
    },
  };
  return { admin, calls };
}

const OK_BODY = {
  data: { metafieldsSet: { metafields: [{ id: "m1" }], userErrors: [] } },
};

const form = (pairs: Array<[string, string]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of pairs) fd.append(k, v);
  return fd;
};

const single = (orderId = "gid://shopify/Order/7201903673531") =>
  form([
    ["orderId", orderId],
    ["requestedAt", "2026-09-04T00:47:01.792Z"],
  ]);

describe("parseMarkRescheduleSeenInput", () => {
  it("accepts one Order GID + timestamp pair and normalises to ISO", () => {
    expect(parseMarkRescheduleSeenInput(single())).toEqual({
      ok: true,
      entries: [
        {
          orderId: "gid://shopify/Order/7201903673531",
          seenAt: "2026-09-04T00:47:01.792Z",
        },
      ],
    });
  });

  it("accepts parallel pairs (Mark all seen) and dedupes repeated orders", () => {
    const parsed = parseMarkRescheduleSeenInput(
      form([
        ["orderId", "gid://shopify/Order/1"],
        ["orderId", "gid://shopify/Order/2"],
        ["orderId", "gid://shopify/Order/1"],
        ["requestedAt", "2026-09-04T00:00:00Z"],
        ["requestedAt", "2026-09-04T01:00:00Z"],
        ["requestedAt", "2026-09-04T02:00:00Z"],
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.entries.map((e) => e.orderId)).toEqual([
        "gid://shopify/Order/1",
        "gid://shopify/Order/2",
      ]);
    }
  });

  it("rejects a numeric id, a bad timestamp, mismatched pairs, and oversize input", () => {
    expect(
      parseMarkRescheduleSeenInput(
        form([
          ["orderId", "7201903673531"],
          ["requestedAt", "2026-09-04T00:47:01Z"],
        ]),
      ).ok,
    ).toBe(false);
    expect(
      parseMarkRescheduleSeenInput(
        form([
          ["orderId", "gid://shopify/Order/1"],
          ["requestedAt", "yesterday"],
        ]),
      ).ok,
    ).toBe(false);
    expect(
      parseMarkRescheduleSeenInput(
        form([
          ["orderId", "gid://shopify/Order/1"],
          ["orderId", "gid://shopify/Order/2"],
          ["requestedAt", "2026-09-04T00:00:00Z"],
        ]),
      ).ok,
    ).toBe(false);
    const tooMany: Array<[string, string]> = [];
    for (let i = 0; i < MAX_SEEN_ENTRIES + 1; i += 1) {
      tooMany.push(["orderId", `gid://shopify/Order/${i}`]);
      tooMany.push(["requestedAt", "2026-09-04T00:00:00Z"]);
    }
    expect(parseMarkRescheduleSeenInput(form(tooMany)).ok).toBe(false);
  });
});

describe("handleMarkRescheduleSeenOp", () => {
  it("writes $app.reschedule_seen_at with the acknowledged event's timestamp", async () => {
    const { admin, calls } = makeAdmin(() => OK_BODY);
    const response = await handleMarkRescheduleSeenOp(admin, single());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      action: "markRescheduleSeen",
      message: "Marked as seen.",
      orderIds: ["gid://shopify/Order/7201903673531"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({
      metafields: [
        {
          ownerId: "gid://shopify/Order/7201903673531",
          namespace: RESCHEDULE_SEEN_METAFIELD.namespace,
          key: RESCHEDULE_SEEN_METAFIELD.key,
          type: "date_time",
          value: "2026-09-04T00:47:01.792Z",
        },
      ],
    });
  });

  it("chunks Mark all seen into metafieldsSet calls of at most 25", async () => {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 30; i += 1) {
      pairs.push(["orderId", `gid://shopify/Order/${i}`]);
      pairs.push(["requestedAt", "2026-09-04T00:00:00Z"]);
    }
    const { admin, calls } = makeAdmin(() => OK_BODY);
    const response = await handleMarkRescheduleSeenOp(admin, form(pairs));
    expect((await response.json()).message).toBe("Marked 30 reschedules as seen.");
    expect(calls).toHaveLength(2);
    const sizes = calls.map(
      (c) => (c.variables?.metafields as unknown[]).length,
    );
    expect(sizes).toEqual([25, 5]);
  });

  it("answers 400 for invalid input without calling Shopify", async () => {
    const { admin, calls } = makeAdmin(() => OK_BODY);
    const response = await handleMarkRescheduleSeenOp(
      admin,
      form([["orderId", "nope"]]),
    );
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("turns userErrors and thrown upstream failures into 200 + ok:false (ADR-11)", async () => {
    const userError = makeAdmin(() => ({
      data: { metafieldsSet: { metafields: [], userErrors: [{ message: "nope" }] } },
    }));
    const r1 = await handleMarkRescheduleSeenOp(userError.admin, single("gid://shopify/Order/1"));
    expect(r1.status).toBe(200);
    expect((await r1.json()).ok).toBe(false);

    const thrown = makeAdmin(() => new Error("socket hang up"));
    const r2 = await handleMarkRescheduleSeenOp(thrown.admin, single("gid://shopify/Order/1"));
    expect(r2.status).toBe(200);
    expect((await r2.json()).ok).toBe(false);
  });
});
