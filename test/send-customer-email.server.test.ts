import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Customer Email (customer-email-design.md §6): pins the service param
// mapping (incl. the BCC-self invariant E-3), the config gating, and the
// sendEmail op's validation + recipient-lock (E-4) behavior.

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

const prismaMock = vi.hoisted(() => ({
  emailSendLog: { create: vi.fn() },
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));

import {
  _resetEmailTransportForTests,
  EMAIL_NOT_CONFIGURED_MESSAGE,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_PHOTO_BYTES,
  MAX_EMAIL_PHOTOS,
  MAX_EMAIL_SUBJECT_LENGTH,
  handleSendEmailOp,
  sendCustomerEmail,
} from "../app/services/send-customer-email.server";

const USER = "shop@flowercart.test";
const SHOP = "flowercart-dev.myshopify.com";

function stubEmailEnv() {
  vi.stubEnv("EMAIL_SMTP_HOST", "mail.privateemail.com");
  vi.stubEnv("EMAIL_SMTP_PORT", "465");
  vi.stubEnv("EMAIL_SMTP_USER", USER);
  vi.stubEnv("EMAIL_SMTP_PASSWORD", "s3cret");
  vi.stubEnv("EMAIL_FROM_NAME", "The Flowercart");
}

beforeEach(() => {
  _resetEmailTransportForTests();
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "test" });
  createTransportMock.mockClear();
  prismaMock.emailSendLog.create.mockReset();
  prismaMock.emailSendLog.create.mockResolvedValue({});
  stubEmailEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin(payload: unknown) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> =
    [];
  const admin = {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ): Promise<Response> => {
      calls.push({ query, variables: options?.variables });
      return jsonResponse(payload);
    },
  };
  return { admin, calls };
}

function orderPayload(email: string | null) {
  return {
    data: {
      order: {
        id: "gid://shopify/Order/123",
        customer: email
          ? { defaultEmailAddress: { emailAddress: email } }
          : null,
      },
    },
  };
}

function makeFd(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("_action", "sendEmail");
  fd.set("orderId", "gid://shopify/Order/123");
  fd.set("subject", "Order #1009");
  fd.set("body", "Hello! Your delivery is on the way.");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

describe("sendCustomerEmail", () => {
  it("builds the transport from env and pins From/To/BCC/subject/text (E-3 BCC-self)", async () => {
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "Order #1009",
      textBody: "Hello!",
    });

    expect(result).toEqual({ ok: true });
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock).toHaveBeenCalledWith({
      host: "mail.privateemail.com",
      port: 465,
      secure: true,
      auth: { user: USER, pass: "s3cret" },
      logger: false,
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith({
      from: { name: "The Flowercart", address: USER },
      to: "cust@example.com",
      bcc: USER,
      subject: "Order #1009",
      text: "Hello!",
    });
  });

  it("reuses one transport across sends (lazy singleton)", async () => {
    await sendCustomerEmail({ to: "a@x.com", subject: "s", textBody: "b" });
    await sendCustomerEmail({ to: "b@x.com", subject: "s", textBody: "b" });
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it("port 587 fallback uses STARTTLS (secure: false)", async () => {
    vi.stubEnv("EMAIL_SMTP_PORT", "587");
    await sendCustomerEmail({ to: "a@x.com", subject: "s", textBody: "b" });
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false }),
    );
  });

  it("config gating: missing user/password → clear error, no transport", async () => {
    vi.stubEnv("EMAIL_SMTP_USER", "");
    vi.stubEnv("EMAIL_SMTP_PASSWORD", "");
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
    });
    expect(result).toEqual({ ok: false, error: EMAIL_NOT_CONFIGURED_MESSAGE });
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("maps EAUTH to a human sign-in message", async () => {
    sendMailMock.mockRejectedValueOnce({
      code: "EAUTH",
      message: "535 5.7.8 authentication failed",
    });
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rejected the sign-in");
    }
  });

  it("surfaces provider rejections (SMTP response code) with server wording", async () => {
    sendMailMock.mockRejectedValueOnce({
      responseCode: 550,
      message: "hourly sending limit exceeded",
    });
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rejected the message");
      expect(result.error).toContain("hourly sending limit exceeded");
    }
  });
});

describe("handleSendEmailOp", () => {
  it("happy path: re-reads the customer email and ignores any client-supplied recipient (E-4)", async () => {
    const { admin, calls } = makeAdmin(orderPayload("cust@example.com"));
    // A spoofed "to" field must have zero effect on the recipient.
    const fd = makeFd({ to: "evil@attacker.test" });

    const res = await handleSendEmailOp(admin, fd, SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };

    expect(res.status).toBe(200);
    expect(j).toEqual({ ok: true, message: "Email sent to cust@example.com." });
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ id: "gid://shopify/Order/123" });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "cust@example.com", bcc: USER }),
    );
    expect(prismaMock.emailSendLog.create).toHaveBeenCalledWith({
      data: {
        shop: SHOP,
        shopifyOrderId: "gid://shopify/Order/123",
        to: "cust@example.com",
        subject: "Order #1009",
      },
    });
  });

  it("threads a reply with In-Reply-To and References", async () => {
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd({
      subject: "Re: Order #1009",
      inReplyTo: "<r1@example.com>",
    });
    const res = await handleSendEmailOp(admin, fd, SHOP);
    expect(res.status).toBe(200);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: "<r1@example.com>",
        references: ["<r1@example.com>"],
      }),
    );
  });

  it("400 on a malformed reply reference, before any send", async () => {
    const { admin, calls } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd({ inReplyTo: "<a@b>\r\nBcc: evil@attacker.test" });
    const res = await handleSendEmailOp(admin, fd, SHOP);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("does not log to EmailSendLog when the send fails", async () => {
    sendMailMock.mockRejectedValueOnce({ code: "EAUTH", message: "535" });
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    await handleSendEmailOp(admin, makeFd(), SHOP);
    expect(prismaMock.emailSendLog.create).not.toHaveBeenCalled();
  });

  it("a log-write failure never fails the already-successful send response", async () => {
    prismaMock.emailSendLog.create.mockRejectedValueOnce(new Error("db down"));
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd(), SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(200);
    expect(j).toEqual({ ok: true, message: "Email sent to cust@example.com." });
  });

  it.each([
    ["missing", ""],
    ["numeric", "123"],
    ["non-order gid", "gid://shopify/Product/123"],
  ])("rejects a %s orderId without touching the API", async (_label, id) => {
    const { admin, calls } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd({ orderId: id }), SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j.ok).toBe(false);
    expect(j.message).toBe("Invalid order ID.");
    expect(calls).toHaveLength(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it.each([
    ["empty subject", { subject: "   " }, "Enter a subject."],
    [
      "oversized subject",
      { subject: "x".repeat(MAX_EMAIL_SUBJECT_LENGTH + 1) },
      `Subject must be ${MAX_EMAIL_SUBJECT_LENGTH} characters or fewer.`,
    ],
    ["empty body", { body: "  " }, "Enter a message."],
    [
      "oversized body",
      { body: "x".repeat(MAX_EMAIL_BODY_LENGTH + 1) },
      `Message must be ${MAX_EMAIL_BODY_LENGTH} characters or fewer.`,
    ],
  ])("rejects %s with a 400", async (_label, overrides, message) => {
    const { admin, calls } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd(overrides), SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j).toEqual({ ok: false, message });
    expect(calls).toHaveLength(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("400 when the order has no customer email", async () => {
    const { admin } = makeAdmin(orderPayload(null));
    const res = await handleSendEmailOp(admin, makeFd(), SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j).toEqual({
      ok: false,
      message: "This order has no customer email.",
    });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("404 when the order does not exist", async () => {
    const { admin } = makeAdmin({ data: { order: null } });
    const res = await handleSendEmailOp(admin, makeFd(), SHOP);
    expect(res.status).toBe(404);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j).toEqual({ ok: false, message: "Order not found." });
  });

  // Upstream failures come back as 200 + ok:false, NEVER 5xx — Cloudflare
  // replaces origin 502/504 bodies with its branded HTML error page, which
  // breaks the fetcher JSON contract (observed live via the dev tunnel).
  it("200 + ok:false when the order read returns GraphQL errors", async () => {
    const { admin } = makeAdmin({ errors: [{ message: "boom" }] });
    const res = await handleSendEmailOp(admin, makeFd(), SHOP);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j.ok).toBe(false);
    expect(j.message).toContain("Couldn't read the order: boom");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("200 + ok:false with the humanized message when the send fails", async () => {
    sendMailMock.mockRejectedValueOnce({ code: "EAUTH", message: "535" });
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd(), SHOP);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j.ok).toBe(false);
    expect(j.message).toContain("rejected the sign-in");
  });

  it("200 + ok:false with the not-configured message when env is absent (config gating)", async () => {
    vi.stubEnv("EMAIL_SMTP_USER", "");
    vi.stubEnv("EMAIL_SMTP_PASSWORD", "");
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd(), SHOP);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j).toEqual({ ok: false, message: EMAIL_NOT_CONFIGURED_MESSAGE });
    expect(createTransportMock).not.toHaveBeenCalled();
  });
});

// Photo attachments (customer-email-design.md §2a, E-8/E-9): photos ride the
// customer send only; the merchant copy is a separate photo-less send that
// lists the filenames — merchant decision 2026-07-14 to protect the Private
// Email mailbox quota.

function makePhoto(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("sendCustomerEmail with attachments (E-9)", () => {
  const ATTACHMENTS = [
    {
      filename: "bouquet.jpg",
      content: Buffer.from("fake-jpeg"),
      contentType: "image/jpeg",
    },
    {
      filename: "ribbon.png",
      content: Buffer.from("fake-png"),
      contentType: "image/png",
    },
  ];

  it("sends TWO messages: customer WITH photos + no BCC, then a photo-less self-copy listing the filenames", async () => {
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "Order #1009",
      textBody: "Here is your bouquet!",
      attachments: ATTACHMENTS,
    });

    expect(result).toEqual({ ok: true });
    expect(sendMailMock).toHaveBeenCalledTimes(2);

    const customerSend = sendMailMock.mock.calls[0][0];
    expect(customerSend.to).toBe("cust@example.com");
    expect(customerSend.bcc).toBeUndefined();
    expect(customerSend.attachments).toEqual(ATTACHMENTS);

    const selfCopy = sendMailMock.mock.calls[1][0];
    expect(selfCopy.to).toBe(USER);
    expect(selfCopy.attachments).toBeUndefined();
    expect(selfCopy.bcc).toBeUndefined();
    expect(selfCopy.subject).toBe("Order #1009");
    expect(selfCopy.text).toContain("Here is your bouquet!");
    expect(selfCopy.text).toContain(
      "[2 photo(s) sent to the customer: bouquet.jpg, ribbon.png — not attached to this copy]",
    );
  });

  it("self-copy failure is best-effort: still ok, flagged copyFailed", async () => {
    sendMailMock
      .mockResolvedValueOnce({ messageId: "customer" })
      .mockRejectedValueOnce({ code: "ETIMEDOUT", message: "timeout" });
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
      attachments: [ATTACHMENTS[0]],
    });
    expect(result).toEqual({ ok: true, copyFailed: true });
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it("customer-send failure fails the op — no self-copy attempted", async () => {
    sendMailMock.mockRejectedValueOnce({ code: "EAUTH", message: "535" });
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
      attachments: [ATTACHMENTS[0]],
    });
    expect(result.ok).toBe(false);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("empty attachments array keeps the original single send + BCC (E-3)", async () => {
    await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
      attachments: [],
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ bcc: USER }),
    );
  });
});

describe("handleSendEmailOp photo validation (E-8)", () => {
  it("happy path: photo reaches the customer send as a Buffer attachment", async () => {
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd();
    fd.append("photo", makePhoto("bouquet.jpg", "image/jpeg", 1024));

    const res = await handleSendEmailOp(admin, fd, SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };

    expect(res.status).toBe(200);
    expect(j).toEqual({ ok: true, message: "Email sent to cust@example.com." });
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const customerSend = sendMailMock.mock.calls[0][0];
    expect(customerSend.attachments).toHaveLength(1);
    expect(customerSend.attachments[0].filename).toBe("bouquet.jpg");
    expect(customerSend.attachments[0].contentType).toBe("image/jpeg");
    expect(Buffer.isBuffer(customerSend.attachments[0].content)).toBe(true);
    expect(customerSend.attachments[0].content.length).toBe(1024);
  });

  it("success message notes a failed self-copy (copyFailed)", async () => {
    sendMailMock
      .mockResolvedValueOnce({ messageId: "customer" })
      .mockRejectedValueOnce({ code: "ETIMEDOUT", message: "timeout" });
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd();
    fd.append("photo", makePhoto("bouquet.jpg", "image/jpeg", 1024));

    const res = await handleSendEmailOp(admin, fd, SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j.ok).toBe(true);
    expect(j.message).toBe(
      "Email sent to cust@example.com. (Couldn't save a copy to your mailbox.)",
    );
  });

  it("rejects more than the photo cap with a 400, before any send", async () => {
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd();
    for (let i = 0; i <= MAX_EMAIL_PHOTOS; i++) {
      fd.append("photo", makePhoto(`p${i}.jpg`, "image/jpeg", 10));
    }
    const res = await handleSendEmailOp(admin, fd, SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j).toEqual({
      ok: false,
      message: `Attach up to ${MAX_EMAIL_PHOTOS} photos.`,
    });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("rejects a non-image type with a 400", async () => {
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd();
    fd.append("photo", makePhoto("notes.pdf", "application/pdf", 10));
    const res = await handleSendEmailOp(admin, fd, SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j.message).toContain('"notes.pdf" is not a supported photo type');
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized photo with a 400", async () => {
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd();
    fd.append(
      "photo",
      makePhoto("huge.jpg", "image/jpeg", MAX_EMAIL_PHOTO_BYTES + 1),
    );
    const res = await handleSendEmailOp(admin, fd, SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j.message).toContain('"huge.jpg" is larger than 8 MB');
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("rejects photos over the total cap with a 400", async () => {
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd();
    fd.append("photo", makePhoto("a.jpg", "image/jpeg", MAX_EMAIL_PHOTO_BYTES));
    fd.append("photo", makePhoto("b.jpg", "image/jpeg", MAX_EMAIL_PHOTO_BYTES));
    const res = await handleSendEmailOp(admin, fd, SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j.message).toBe("Photos are 15 MB max in total.");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("ignores empty photo entries — behaves as a photo-less send (single send + BCC)", async () => {
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const fd = makeFd();
    fd.append("photo", makePhoto("empty.jpg", "image/jpeg", 0));
    const res = await handleSendEmailOp(admin, fd, SHOP);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j).toEqual({ ok: true, message: "Email sent to cust@example.com." });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ bcc: USER }),
    );
  });
});
