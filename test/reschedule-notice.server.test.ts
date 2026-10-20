import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Customer notice after a merchant reschedule (2026-09-04): pins the copy,
// the recipient rule, the log row, and the "never a failure" posture.

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("../app/services/send-customer-email.server", () => ({
  sendCustomerEmail: sendMock,
}));

const prismaMock = vi.hoisted(() => ({
  emailSendLog: { create: vi.fn() },
}));
vi.mock("../app/db.server", () => ({ default: prismaMock }));

import {
  buildRescheduleNotice,
  formatNoticeDate,
  sendRescheduleNotice,
  type RescheduleNoticeInput,
} from "../app/services/reschedule-notice.server";

const SHOP = "hsrwva-nr.myshopify.com";

const input = (over: Partial<RescheduleNoticeInput> = {}): RescheduleNoticeInput => ({
  orderId: "gid://shopify/Order/7201903673531",
  orderName: "#4292",
  to: "omeetahi411@gmail.com",
  firstName: "DAVID",
  fromDate: "2026-09-04",
  fromTimeSlot: "9AM-12PM",
  toDate: "2026-09-28",
  toTimeSlot: "9AM-12PM",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockResolvedValue({ ok: true });
  prismaMock.emailSendLog.create.mockResolvedValue({});
  process.env.EMAIL_FROM_NAME = "The Flowercart";
});

afterEach(() => {
  delete process.env.EMAIL_FROM_NAME;
});

describe("buildRescheduleNotice", () => {
  it("formats the schedule change in plain text with the brand signature", () => {
    expect(formatNoticeDate("2026-09-28")).toBe("Mon, Sep 28, 2026");
    const { subject, textBody } = buildRescheduleNotice(input());
    expect(subject).toBe(
      "Order #4292: new delivery schedule - Mon, Sep 28, 2026, 9AM-12PM",
    );
    expect(textBody).toBe(
      [
        "Hi DAVID,",
        "",
        "We've updated the delivery schedule for your order #4292.",
        "",
        "New delivery: Mon, Sep 28, 2026, 9AM-12PM",
        "Previous: Fri, Sep 4, 2026, 9AM-12PM",
        "",
        "If this new schedule doesn't work for you, just reply to this email and we'll sort it out.",
        "",
        "Thank you,",
        "The Flowercart",
      ].join("\n"),
    );
  });

  it("degrades gracefully without a first name, order name, or previous schedule", () => {
    const { subject, textBody } = buildRescheduleNotice(
      input({ firstName: null, orderName: null, fromDate: null, fromTimeSlot: null }),
    );
    expect(subject).toBe("Order update: new delivery schedule - Mon, Sep 28, 2026, 9AM-12PM");
    expect(textBody.startsWith("Hi there,")).toBe(true);
    expect(textBody).toContain("for your order.");
    expect(textBody).not.toContain("Previous:");
  });
});

describe("sendRescheduleNotice", () => {
  it("sends to the order's customer and logs the send for the panel timeline", async () => {
    const result = await sendRescheduleNotice(SHOP, input());
    expect(result).toEqual({ status: "sent", to: "omeetahi411@gmail.com" });
    expect(sendMock).toHaveBeenCalledWith({
      to: "omeetahi411@gmail.com",
      subject: "Order #4292: new delivery schedule - Mon, Sep 28, 2026, 9AM-12PM",
      textBody: expect.stringContaining("New delivery: Mon, Sep 28, 2026, 9AM-12PM"),
    });
    expect(prismaMock.emailSendLog.create).toHaveBeenCalledWith({
      data: {
        shop: SHOP,
        shopifyOrderId: "gid://shopify/Order/7201903673531",
        to: "omeetahi411@gmail.com",
        subject: "Order #4292: new delivery schedule - Mon, Sep 28, 2026, 9AM-12PM",
      },
    });
  });

  it("skips (no send, no log) when the order has no customer email", async () => {
    expect(await sendRescheduleNotice(SHOP, input({ to: "   " }))).toEqual({
      status: "skipped_no_email",
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(prismaMock.emailSendLog.create).not.toHaveBeenCalled();
  });

  it("reports SMTP failures and throws as a status, never an exception, and does not log them", async () => {
    sendMock.mockResolvedValueOnce({ ok: false, error: "Mailbox rejected the message." });
    expect(await sendRescheduleNotice(SHOP, input())).toEqual({
      status: "failed",
      error: "Mailbox rejected the message.",
    });
    sendMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await sendRescheduleNotice(SHOP, input())).toEqual({
      status: "failed",
      error: "socket hang up",
    });
    expect(prismaMock.emailSendLog.create).not.toHaveBeenCalled();
  });

  it("a log-write failure does not turn a sent email into a failure", async () => {
    prismaMock.emailSendLog.create.mockRejectedValueOnce(new Error("neon cold start"));
    expect(await sendRescheduleNotice(SHOP, input())).toEqual({
      status: "sent",
      to: "omeetahi411@gmail.com",
    });
  });
});
