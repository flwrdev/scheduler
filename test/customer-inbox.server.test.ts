import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const imap = vi.hoisted(() => {
  const state = {
    mailboxes: {} as Record<string, Array<{ uid: number; source: string }>>,
    folders: [] as Array<{ path: string; specialUse?: string }>,
    searches: [] as Array<{ path: string; query: unknown }>,
    openedReadOnly: [] as boolean[],
    connectError: null as Error | null,
    loggedOut: 0,
  };
  class ImapFlow {
    private path = "";
    constructor(public options: unknown) {}
    on() {}
    async connect() {
      if (state.connectError) throw state.connectError;
    }
    async logout() {
      state.loggedOut += 1;
    }
    close() {}
    async list() {
      return state.folders;
    }
    async getMailboxLock(path: string, opts: { readOnly?: boolean }) {
      this.path = path;
      state.openedReadOnly.push(Boolean(opts?.readOnly));
      return { release() {} };
    }
    async search(query: unknown) {
      state.searches.push({ path: this.path, query });
      return (state.mailboxes[this.path] ?? []).map((m) => m.uid);
    }
    async *fetch(uids: number[]) {
      for (const m of state.mailboxes[this.path] ?? []) {
        if (!uids.includes(m.uid)) continue;
        yield { uid: m.uid, seq: m.uid, source: Buffer.from(m.source), envelope: envelopeOf(m.source) };
      }
    }
  }
  function header(source: string, name: string): string | undefined {
    const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
    return re.exec(source)?.[1]?.trim();
  }
  function address(value: string | undefined) {
    if (!value) return undefined;
    const m = /(?:"?([^"<]*)"?\s*)?<([^>]+)>/.exec(value);
    return m ? { name: m[1]?.trim(), address: m[2] } : { address: value };
  }
  function envelopeOf(source: string) {
    const from = address(header(source, "From"));
    const to = address(header(source, "To"));
    return {
      subject: header(source, "Subject"),
      messageId: header(source, "Message-ID"),
      date: header(source, "Date"),
      from: from ? [from] : [],
      to: to ? [to] : [],
    };
  }
  return { state, ImapFlow };
});

vi.mock("imapflow", () => ({ ImapFlow: imap.ImapFlow }));

import {
  EMAIL_REPLY_SEEN_OP,
  clearInboxCache,
  getOrderThread,
  listUnseenReplies,
} from "../app/services/customer-inbox.server";
import { handleMarkSeenOp } from "../app/services/reschedule-seen.server";

const USER = "jhay@flowercart.store";

function raw({
  from,
  to = USER,
  subject,
  date = "Mon, 28 Sep 2026 02:37:00 +0000",
  id,
  body,
  auth = "mx; dkim=pass; spf=pass; dmarc=pass",
}: {
  from: string;
  to?: string;
  subject: string;
  date?: string;
  id: string;
  body: string;
  auth?: string;
}): string {
  return [
    `Authentication-Results: ${auth}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${id}`,
    `Date: ${date}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
}

function adminReturning(...responses: unknown[]) {
  const graphql = vi.fn();
  for (const r of responses) {
    graphql.mockResolvedValueOnce(new Response(JSON.stringify(r)));
  }
  return { graphql };
}

beforeEach(() => {
  clearInboxCache();
  imap.state.mailboxes = {};
  imap.state.folders = [{ path: "INBOX" }, { path: "Sent", specialUse: "\\Sent" }];
  imap.state.searches = [];
  imap.state.openedReadOnly = [];
  imap.state.connectError = null;
  imap.state.loggedOut = 0;
  vi.stubEnv("EMAIL_SMTP_USER", USER);
  vi.stubEnv("EMAIL_SMTP_PASSWORD", "s3cret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("listUnseenReplies", () => {
  it("returns an error without mailbox credentials", async () => {
    vi.stubEnv("EMAIL_SMTP_PASSWORD", "");
    const result = await listUnseenReplies(adminReturning());
    expect(result.ok).toBe(false);
  });

  it("matches by subject, falls back to sender, and opens INBOX read-only", async () => {
    imap.state.mailboxes.INBOX = [
      {
        uid: 1,
        source: raw({
          from: "Juan <juan@example.com>",
          subject: "Re: Order #4539: new delivery schedule",
          id: "<r1@example.com>",
          body: "Pwede po ba Friday?\r\n\r\nOn Sun, Sep 27, 2026 The Flowercart <jhay@flowercart.store> wrote:\r\n> Hi",
        }),
      },
      {
        uid: 2,
        source: raw({
          from: "maria@example.com",
          subject: "Question",
          id: "<r2@example.com>",
          body: "Magkano po delivery?",
          date: "Mon, 28 Sep 2026 03:00:00 +0000",
        }),
      },
      {
        uid: 3,
        source: raw({
          from: "stranger@example.com",
          subject: "Hello",
          id: "<r3@example.com>",
          body: "no order",
        }),
      },
    ];
    const admin = adminReturning(
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/10",
                legacyResourceId: "10",
                name: "#4539",
                email: "juan@example.com",
                customer: { displayName: "Juan" },
                emailReplySeenAt: null,
              },
            ],
          },
        },
      },
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/20",
                legacyResourceId: "20",
                name: "#4600",
                email: "maria@example.com",
                customer: { displayName: "Maria" },
                emailReplySeenAt: null,
              },
            ],
          },
        },
      },
    );

    const result = await listUnseenReplies(admin, new Date("2026-09-28T04:00:00Z"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((r) => [r.name, r.matchedBy, r.preview])).toEqual([
      ["#4600", "sender", "Magkano po delivery?"],
      ["#4539", "subject", "Pwede po ba Friday?"],
    ]);
    expect(imap.state.openedReadOnly).toEqual([true]);
    expect(imap.state.searches[0].query).toMatchObject({ not: { from: USER } });
    expect(imap.state.loggedOut).toBe(1);

    const nameQuery = admin.graphql.mock.calls[0][1].variables.query;
    expect(nameQuery).toBe("name:4539");
    const emailQuery = admin.graphql.mock.calls[1][1].variables.query;
    expect(emailQuery).toContain('email:"maria@example.com"');
    expect(emailQuery).toContain('email:"stranger@example.com"');
    expect(emailQuery).toContain("status:open");
  });

  it("drops replies already covered by the seen timestamp", async () => {
    imap.state.mailboxes.INBOX = [
      {
        uid: 1,
        source: raw({
          from: "juan@example.com",
          subject: "Re: Order #4539",
          id: "<r1@example.com>",
          body: "ok",
        }),
      },
    ];
    const admin = adminReturning({
      data: {
        orders: {
          nodes: [
            {
              id: "gid://shopify/Order/10",
              name: "#4539",
              emailReplySeenAt: { value: "2026-09-28T02:37:00Z" },
            },
          ],
        },
      },
    });
    const result = await listUnseenReplies(admin, new Date("2026-09-28T04:00:00Z"));
    expect(result).toEqual({ ok: true, data: [] });
  });

  it("flags a reply whose DMARC check failed", async () => {
    imap.state.mailboxes.INBOX = [
      {
        uid: 1,
        source: raw({
          from: "juan@example.com",
          subject: "Re: Order #4539",
          id: "<r1@example.com>",
          body: "change address",
          auth: "mx; spf=fail; dkim=none; dmarc=fail",
        }),
      },
    ];
    const admin = adminReturning({
      data: { orders: { nodes: [{ id: "gid://shopify/Order/10", name: "#4539" }] } },
    });
    const result = await listUnseenReplies(admin, new Date("2026-09-28T04:00:00Z"));
    expect(result.ok && result.data[0].verdict).toBe("fail");
  });

  it("reports an unreachable mail server without throwing", async () => {
    imap.state.connectError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const result = await listUnseenReplies(adminReturning());
    expect(result).toEqual({
      ok: false,
      error: "Couldn't reach the mail server. Try again in a moment.",
    });
  });
});

describe("listUnseenReplies mailbox cache", () => {
  const NOW = new Date("2026-09-28T04:00:00Z");

  function oneReply() {
    imap.state.mailboxes.INBOX = [
      {
        uid: 1,
        source: raw({
          from: "juan@example.com",
          subject: "Re: Order #4539",
          id: "<r1@example.com>",
          body: "ok",
        }),
      },
    ];
  }

  function orderNode(seenAt: string | null) {
    return {
      data: {
        orders: {
          nodes: [
            {
              id: "gid://shopify/Order/10",
              name: "#4539",
              emailReplySeenAt: seenAt ? { value: seenAt } : null,
            },
          ],
        },
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the mailbox once for calls inside the TTL", async () => {
    oneReply();
    await listUnseenReplies(adminReturning(orderNode(null)), NOW);
    await listUnseenReplies(adminReturning(orderNode(null)), NOW);
    expect(imap.state.searches).toHaveLength(1);
    expect(imap.state.loggedOut).toBe(1);
  });

  it("reads the mailbox again once the TTL has passed", async () => {
    oneReply();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await listUnseenReplies(adminReturning(orderNode(null)), NOW);
    clock.mockReturnValue(1_000_000 + 61_000);
    await listUnseenReplies(adminReturning(orderNode(null)), NOW);
    expect(imap.state.searches).toHaveLength(2);
  });

  it("still applies the seen timestamp to cached messages", async () => {
    oneReply();
    const first = await listUnseenReplies(adminReturning(orderNode(null)), NOW);
    expect(first.ok && first.data).toHaveLength(1);
    const second = await listUnseenReplies(
      adminReturning(orderNode("2026-09-28T03:00:00Z")),
      NOW,
    );
    expect(second).toEqual({ ok: true, data: [] });
    expect(imap.state.searches).toHaveLength(1);
  });

  it("does not save a failed read", async () => {
    oneReply();
    imap.state.connectError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const failed = await listUnseenReplies(adminReturning(), NOW);
    expect(failed.ok).toBe(false);
    imap.state.connectError = null;
    const retried = await listUnseenReplies(adminReturning(orderNode(null)), NOW);
    expect(retried.ok && retried.data).toHaveLength(1);
  });

  it("lets calls that overlap share one mailbox read", async () => {
    oneReply();
    await Promise.all([
      listUnseenReplies(adminReturning(orderNode(null)), NOW),
      listUnseenReplies(adminReturning(orderNode(null)), NOW),
      listUnseenReplies(adminReturning(orderNode(null)), NOW),
    ]);
    expect(imap.state.searches).toHaveLength(1);
  });

  it("starts a new read after clearInboxCache", async () => {
    oneReply();
    await listUnseenReplies(adminReturning(orderNode(null)), NOW);
    clearInboxCache();
    await listUnseenReplies(adminReturning(orderNode(null)), NOW);
    expect(imap.state.searches).toHaveLength(2);
  });
});

describe("getOrderThread", () => {
  it("reads INBOX and Sent, keeps only this order, and de-duplicates", async () => {
    imap.state.mailboxes.INBOX = [
      {
        uid: 1,
        source: raw({
          from: "juan@example.com",
          subject: "Re: Order #4539",
          id: "<r1@example.com>",
          body: "reply",
          date: "Mon, 28 Sep 2026 02:00:00 +0000",
        }),
      },
      {
        uid: 2,
        source: raw({
          from: "juan@example.com",
          subject: "Re: Order #45391",
          id: "<other@example.com>",
          body: "other order",
        }),
      },
      {
        uid: 3,
        source: raw({
          from: `The Flowercart <${USER}>`,
          to: "juan@example.com",
          subject: "Order #4539: new delivery schedule",
          id: "<sent@flowercart.store>",
          body: "notice",
          date: "Sun, 27 Sep 2026 19:30:34 +0000",
        }),
      },
    ];
    imap.state.mailboxes.Sent = [
      {
        uid: 7,
        source: raw({
          from: USER,
          to: "juan@example.com",
          subject: "Order #4539: new delivery schedule",
          id: "<sent@flowercart.store>",
          body: "notice",
          date: "Sun, 27 Sep 2026 19:30:34 +0000",
        }),
      },
      {
        uid: 8,
        source: raw({
          from: USER,
          to: "juan@example.com",
          subject: "Sure, Friday works",
          id: "<webmail@flowercart.store>",
          body: "Sure",
          date: "Mon, 28 Sep 2026 03:00:00 +0000",
        }),
      },
    ];

    const result = await getOrderThread(
      { orderName: "#4539", customerEmail: "Juan@Example.com" },
      new Date("2026-09-28T04:00:00Z"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((m) => [m.messageId, m.direction])).toEqual([
      ["<webmail@flowercart.store>", "outbound"],
      ["<r1@example.com>", "inbound"],
      ["<sent@flowercart.store>", "outbound"],
    ]);
    expect(imap.state.searches.map((s) => s.path)).toEqual(["INBOX", "Sent"]);
    expect(imap.state.openedReadOnly).toEqual([true, true]);
  });

  it("keeps the full text only when quoted history was stripped", async () => {
    imap.state.mailboxes.INBOX = [
      {
        uid: 1,
        source: raw({
          from: "juan@example.com",
          subject: "Re: Order #4539",
          id: "<quoted@example.com>",
          body: "Friday po\r\n\r\nOn Sun, Sep 27, 2026 The Flowercart <jhay@flowercart.store> wrote:\r\n> Hi Juan",
        }),
      },
      {
        uid: 2,
        source: raw({
          from: "juan@example.com",
          subject: "Re: Order #4539",
          id: "<plain@example.com>",
          body: "Salamat",
        }),
      },
    ];
    const result = await getOrderThread(
      { orderName: "#4539", customerEmail: "juan@example.com" },
      new Date("2026-09-28T04:00:00Z"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const quoted = result.data.find((m) => m.messageId === "<quoted@example.com>");
    const plain = result.data.find((m) => m.messageId === "<plain@example.com>");
    expect(quoted?.text).toBe("Friday po");
    expect(quoted?.fullText).toContain("> Hi Juan");
    expect(plain?.fullText).toBeUndefined();
  });
});

describe("markEmailReplySeen op", () => {
  it("writes the reply's receivedAt to the email_reply_seen_at metafield", async () => {
    const admin = adminReturning({
      data: { metafieldsSet: { metafields: [{ id: "m" }], userErrors: [] } },
    });
    const fd = new FormData();
    fd.append("orderId", "gid://shopify/Order/10");
    fd.append("receivedAt", "2026-09-28T02:37:00.000Z");
    const response = await handleMarkSeenOp(admin, fd, EMAIL_REPLY_SEEN_OP);
    expect(await response.json()).toEqual({
      ok: true,
      action: "markEmailReplySeen",
      message: "Marked as seen.",
      orderIds: ["gid://shopify/Order/10"],
    });
    expect(admin.graphql.mock.calls[0][1].variables.metafields).toEqual([
      {
        ownerId: "gid://shopify/Order/10",
        namespace: "$app",
        key: "email_reply_seen_at",
        type: "date_time",
        value: "2026-09-28T02:37:00.000Z",
      },
    ]);
  });

  it("rejects a missing receivedAt", async () => {
    const fd = new FormData();
    fd.append("orderId", "gid://shopify/Order/10");
    const response = await handleMarkSeenOp(adminReturning(), fd, EMAIL_REPLY_SEEN_OP);
    expect(response.status).toBe(400);
  });
});
