import { describe, expect, it } from "vitest";

import {
  type MailboxMessage,
  type MatchedReply,
  buildPreview,
  isSelfAddress,
  isValidMessageId,
  parseOrderNumber,
  replySubject,
  selectUnseenReplies,
  senderVerdict,
  sortThread,
  stripQuotedReply,
} from "../app/lib/email-replies";

function message(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    key: "inbox:1",
    messageId: "<a@example.com>",
    subject: "Re: Order #4539: new delivery schedule - Wed, Dec 23, 2026, 6PM-11PM",
    fromAddress: "customer@example.com",
    fromName: "Juan Dela Cruz",
    toAddresses: ["jhay@flowercart.store"],
    date: "2026-09-28T02:37:00.000Z",
    text: "Pwede po ba sa Friday?",
    direction: "inbound",
    verdict: "pass",
    ...overrides,
  };
}

function matched(
  msg: MailboxMessage,
  seenAt: string | null = null,
  orderId = "gid://shopify/Order/1",
): MatchedReply {
  return {
    message: msg,
    order: { orderId, legacyId: "1", name: "#4539", customerName: "Juan", seenAt },
    matchedBy: "subject",
  };
}

describe("parseOrderNumber", () => {
  it("reads the order number from reply and original subjects", () => {
    expect(parseOrderNumber("Re: Order #4539: new delivery schedule")).toBe("#4539");
    expect(parseOrderNumber("Order #4539")).toBe("#4539");
    expect(parseOrderNumber("RE: RE: about order # 10452")).toBe("#10452");
  });

  it("returns null without an order number", () => {
    expect(parseOrderNumber("Hello po")).toBeNull();
    expect(parseOrderNumber("#12")).toBeNull();
    expect(parseOrderNumber(undefined)).toBeNull();
  });
});

describe("isSelfAddress", () => {
  it("compares case-insensitively and never matches empty", () => {
    expect(isSelfAddress("JHAY@flowercart.store", "jhay@flowercart.store")).toBe(true);
    expect(isSelfAddress("", "")).toBe(false);
    expect(isSelfAddress("a@b.c", "jhay@flowercart.store")).toBe(false);
  });
});

describe("stripQuotedReply", () => {
  it("cuts a Gmail attribution wrapped over two lines", () => {
    const text = [
      "Pwede po ba sa Friday?",
      "",
      "On Sun, Sep 27, 2026 at 3:30 PM The Flowercart <",
      "jhay@flowercart.store> wrote:",
      "> Hi Juan,",
      "> Your order has a new delivery schedule.",
    ].join("\n");
    expect(stripQuotedReply(text)).toBe("Pwede po ba sa Friday?");
  });

  it("cuts a Filipino-locale Gmail attribution", () => {
    const text = [
      "Salamat po!",
      "",
      "Noong Linggo, Set 27, 2026 nang 3:30 PM, sumulat si The Flowercart <",
      "jhay@flowercart.store>:",
      "> Hi Juan,",
    ].join("\n");
    expect(stripQuotedReply(text)).toBe("Salamat po!");
  });

  it("cuts an Outlook header block", () => {
    const text = [
      "Okay lang po.",
      "",
      "From: The Flowercart <jhay@flowercart.store>",
      "Sent: Sunday, September 27, 2026 3:30 PM",
      "To: Juan",
      "Subject: Order #4539",
    ].join("\r\n");
    expect(stripQuotedReply(text)).toBe("Okay lang po.");
  });

  it("drops the signature block", () => {
    expect(stripQuotedReply("Noted po\n-- \nJuan\n09171234567")).toBe("Noted po");
  });

  it("keeps the full text when everything is quoted", () => {
    const text = "> quoted\nmy inline answer";
    expect(stripQuotedReply(text)).toBe(text);
  });
});

describe("buildPreview", () => {
  it("flattens whitespace and truncates with an ellipsis", () => {
    expect(buildPreview("a\n\n b   c")).toBe("a b c");
    const long = "x".repeat(200);
    const preview = buildPreview(long, 20);
    expect(preview).toHaveLength(20);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("senderVerdict", () => {
  it("uses DMARC when present", () => {
    expect(
      senderVerdict(
        "asp-relay-pe.jellyfish.systems; dkim=pass header.d=flowercart.store; spf=pass; dmarc=pass (policy=none)",
      ),
    ).toBe("pass");
    expect(senderVerdict("mx; spf=pass; dkim=pass; dmarc=fail")).toBe("fail");
  });

  it("falls back to SPF and DKIM", () => {
    expect(senderVerdict("mx; spf=fail; dkim=none")).toBe("fail");
    expect(senderVerdict("mx; spf=softfail; dkim=pass")).toBe("pass");
    expect(senderVerdict("mx; spf=neutral")).toBe("unknown");
    expect(senderVerdict(null)).toBe("unknown");
  });
});

describe("replySubject", () => {
  it("adds one Re: prefix", () => {
    expect(replySubject("Order #4539")).toBe("Re: Order #4539");
    expect(replySubject("RE: Order #4539")).toBe("RE: Order #4539");
  });
});

describe("isValidMessageId", () => {
  it("accepts a single <id@host>", () => {
    expect(isValidMessageId("<4f0e9135-93eb@flowercart.store>")).toBe(true);
  });

  it("rejects header injection and malformed ids", () => {
    expect(isValidMessageId("<a@b>\r\nBcc: x@y.z")).toBe(false);
    expect(isValidMessageId("<a@b> <c@d>")).toBe(false);
    expect(isValidMessageId("a@b")).toBe(false);
    expect(isValidMessageId(`<${"a".repeat(1000)}@b>`)).toBe(false);
    expect(isValidMessageId("")).toBe(false);
  });
});

describe("selectUnseenReplies", () => {
  it("returns one row per order with the newest reply and the unseen count", () => {
    const older = message({ key: "inbox:1", date: "2026-09-28T01:00:00.000Z", text: "first" });
    const newer = message({ key: "inbox:2", date: "2026-09-28T02:00:00.000Z", text: "second" });
    const rows = selectUnseenReplies([matched(older), matched(newer)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toBe("second");
    expect(rows[0].unseenCount).toBe(2);
    expect(rows[0].receivedAt).toBe("2026-09-28T02:00:00.000Z");
  });

  it("hides replies at or before the seen timestamp but resurfaces newer ones", () => {
    const seen = "2026-09-28T02:00:00.000Z";
    const atSeen = message({ key: "inbox:1", date: seen });
    expect(selectUnseenReplies([matched(atSeen, seen)])).toEqual([]);

    const later = message({ key: "inbox:2", date: "2026-09-28T03:00:00.000Z" });
    const rows = selectUnseenReplies([matched(atSeen, seen), matched(later, seen)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].unseenCount).toBe(1);
  });

  it("ignores outbound messages and sorts orders newest first", () => {
    const own = message({ key: "inbox:1", direction: "outbound" });
    const a = message({ key: "inbox:2", date: "2026-09-28T01:00:00.000Z" });
    const b = message({ key: "inbox:3", date: "2026-09-28T05:00:00.000Z" });
    const rows = selectUnseenReplies([
      matched(own),
      matched(a, null, "gid://shopify/Order/1"),
      matched(b, null, "gid://shopify/Order/2"),
    ]);
    expect(rows.map((r) => r.orderId)).toEqual([
      "gid://shopify/Order/2",
      "gid://shopify/Order/1",
    ]);
  });
});

describe("sortThread", () => {
  it("de-duplicates by Message-ID and sorts newest first", () => {
    const a = message({ key: "inbox:1", messageId: "<x@y>", date: "2026-09-28T01:00:00.000Z" });
    const dup = message({ key: "sent:9", messageId: "<x@y>", date: "2026-09-28T01:00:00.000Z" });
    const b = message({ key: "inbox:2", messageId: "<z@y>", date: "2026-09-28T02:00:00.000Z" });
    expect(sortThread([a, dup, b]).map((m) => m.key)).toEqual(["inbox:2", "inbox:1"]);
  });
});
