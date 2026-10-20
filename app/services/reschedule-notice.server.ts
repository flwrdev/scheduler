// Builds and sends the email that tells a customer their delivery was rescheduled by the
// merchant. Uses the same SMTP path and EmailSendLog row as any other customer email. The
// recipient comes from the order read from Shopify, never from the request.

import prisma from "../db.server";
import { sendCustomerEmail } from "./send-customer-email.server";

// Customer notice after a MERCHANT reschedule (2026-09-04). Rides the existing
// SMTP path (customer-email-design.md): same transport, same From, same
// BCC-self copy, same EmailSendLog row for the panel timeline — no worker, no
// new table, no Shopify order write. The customer's own self-service
// reschedule is not noticed here: they just did it themselves in the modal.
//
// Recipient trust (E-4): the address comes from the order state the executor
// already read via Admin GraphQL, never from the request.

export interface RescheduleNoticeInput {
  orderId: string;
  orderName: string | null;
  to: string | null;
  firstName: string | null;
  fromDate: string | null;
  fromTimeSlot: string | null;
  toDate: string;
  toTimeSlot: string;
}

export type RescheduleNoticeResult =
  | { status: "sent"; to: string }
  | { status: "skipped_no_email" }
  | { status: "failed"; error: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "Mon, Sep 28, 2026" from "2026-09-28"; anything else passes through. */
export function formatNoticeDate(iso: string | null | undefined): string {
  if (!iso || !ISO_DATE_RE.test(iso)) return iso ?? "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function scheduleLabel(date: string | null | undefined, slot: string | null | undefined): string {
  return [formatNoticeDate(date), slot?.trim() || ""].filter(Boolean).join(", ");
}

function brandName(): string {
  return process.env.EMAIL_FROM_NAME?.trim() || "The Flowercart";
}

export function buildRescheduleNotice(
  input: RescheduleNoticeInput,
): { subject: string; textBody: string } {
  const orderLabel = input.orderName?.trim() || "your order";
  const toLabel = scheduleLabel(input.toDate, input.toTimeSlot);
  const fromLabel = scheduleLabel(input.fromDate, input.fromTimeSlot);
  const greeting = input.firstName?.trim() ? `Hi ${input.firstName.trim()},` : "Hi there,";
  const lines = [
    greeting,
    "",
    `We've updated the delivery schedule for ${
      orderLabel === "your order" ? "your order" : `your order ${orderLabel}`
    }.`,
    "",
    `New delivery: ${toLabel}`,
  ];
  if (fromLabel && fromLabel !== toLabel) {
    lines.push(`Previous: ${fromLabel}`);
  }
  lines.push(
    "",
    "If this new schedule doesn't work for you, just reply to this email and we'll sort it out.",
    "",
    "Thank you,",
    brandName(),
  );
  return {
    subject: `Order ${orderLabel === "your order" ? "update" : orderLabel}: new delivery schedule - ${toLabel}`,
    textBody: lines.join("\n"),
  };
}

export async function sendRescheduleNotice(
  shop: string,
  input: RescheduleNoticeInput,
): Promise<RescheduleNoticeResult> {
  const to = input.to?.trim() || "";
  if (!to) return { status: "skipped_no_email" };

  const { subject, textBody } = buildRescheduleNotice(input);
  let sent: Awaited<ReturnType<typeof sendCustomerEmail>>;
  try {
    sent = await sendCustomerEmail({ to, subject, textBody });
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Failed to send the email.",
    };
  }
  if (!sent.ok) return { status: "failed", error: sent.error };

  // Panel-timeline log only (E-5 revisit) — the send already succeeded, so a
  // logging failure must never turn it into a failure report.
  try {
    await prisma.emailSendLog.create({
      data: { shop, shopifyOrderId: input.orderId, to, subject },
    });
  } catch (error) {
    console.warn(
      `[reschedule-notice] EmailSendLog write failed for ${input.orderId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { status: "sent", to };
}
