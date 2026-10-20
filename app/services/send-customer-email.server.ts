// Sends an email to a customer from the merchant's business mailbox (nodemailer over SMTP).
// Supports up to three photo attachments, replies in the customer's thread, a copy to the
// sender, and records a row in EmailSendLog. handleSendEmailOp is the `sendEmail` action of
// the Orders page. Sending never writes to the Shopify order.

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { AdminGraphQLClient } from "./order-delivery-metafields.server";
import prisma from "../db.server";
import { isValidMessageId } from "../lib/email-replies";

// Customer Email (customer-email-design.md): in-app compose, sent server-side
// through the merchant's business mailbox on Namecheap Private Email via
// plain SMTP AUTH (E-1). Written reusable beyond the orders panel — the
// planned Communications page calls the same entry points (E-2). Sending
// writes NOTHING to the Shopify order (E-5): this module is an outbound side
// effect only.

export const MAX_EMAIL_SUBJECT_LENGTH = 200;
export const MAX_EMAIL_BODY_LENGTH = 5000;

// Photo attachments (E-8): caps keep the multipart request under Cloud Run's
// 32 MB limit and the base64-encoded message under provider size limits.
export const MAX_EMAIL_PHOTOS = 3;
export const MAX_EMAIL_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_EMAIL_PHOTOS_TOTAL_BYTES = 15 * 1024 * 1024;
export const ALLOWED_EMAIL_PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const EMAIL_NOT_CONFIGURED_MESSAGE =
  "Email sending is not configured on this environment.";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendCustomerEmailInput {
  to: string;
  subject: string;
  textBody: string;
  attachments?: EmailAttachment[];
  /** Without In-Reply-To/References the customer's client files the reply as a new conversation. */
  inReplyTo?: string;
}

export type SendCustomerEmailResult =
  | { ok: true; copyFailed?: boolean }
  | { ok: false; error: string };

// Response shape of the `sendEmail` op (app.orders.tsx action) — read by the
// SendEmailModal fetcher.
export interface SendEmailResponse {
  ok: boolean;
  message: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromName: string;
}

function smtpConfig(): SmtpConfig {
  return {
    host: process.env.EMAIL_SMTP_HOST?.trim() || "mail.privateemail.com",
    port: Number(process.env.EMAIL_SMTP_PORT?.trim() || "465"),
    user: process.env.EMAIL_SMTP_USER?.trim() || "",
    password: process.env.EMAIL_SMTP_PASSWORD || "",
    fromName: process.env.EMAIL_FROM_NAME?.trim() || "",
  };
}

// Module-level lazy singleton — Cloud Run instances are reused; do not
// rebuild the connection pool per send.
let cachedTransport: Transporter | null = null;

export function _resetEmailTransportForTests(): void {
  cachedTransport = null;
}

function getTransport(cfg: SmtpConfig): Transporter {
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      // 465 = implicit SSL; the 587 fallback uses STARTTLS (secure: false).
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.password },
      // §5: credentials and message content never reach the logs.
      logger: false,
    });
  }
  return cachedTransport;
}

function humanizeSmtpError(e: unknown): string {
  const err = e as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  const responseCode =
    typeof err?.responseCode === "number" ? err.responseCode : null;
  const message = typeof err?.message === "string" ? err.message : "";
  if (code === "EAUTH") {
    return "The mail server rejected the sign-in — check the SMTP email/password configuration.";
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    code === "ECONNECTION" ||
    code === "EDNS"
  ) {
    return "Couldn't reach the mail server. Try again in a moment.";
  }
  if (responseCode !== null && responseCode >= 400) {
    // Provider rejections (e.g. the hourly sending limit) arrive as SMTP
    // response codes — surface the server's own wording.
    return `The mail server rejected the message${message ? `: ${message}` : "."}`;
  }
  return message || "Failed to send the email.";
}

export async function sendCustomerEmail({
  to,
  subject,
  textBody,
  attachments,
  inReplyTo,
}: SendCustomerEmailInput): Promise<SendCustomerEmailResult> {
  const cfg = smtpConfig();
  if (!cfg.user || !cfg.password) {
    return { ok: false, error: EMAIL_NOT_CONFIGURED_MESSAGE };
  }
  const from = cfg.fromName
    ? { name: cfg.fromName, address: cfg.user }
    : cfg.user;
  const hasPhotos = Boolean(attachments && attachments.length > 0);
  const threading = inReplyTo ? { inReplyTo, references: [inReplyTo] } : {};
  try {
    await getTransport(cfg).sendMail({
      from,
      to,
      // E-3: photo-less sends BCC the sender mailbox — Private Email SMTP
      // sends do not land in the webmail Sent folder, so this is the
      // merchant's copy. With photos the copy is a separate photo-less send
      // below (E-9): a BCC would carry the attachment bytes into the mailbox
      // and eat its storage quota.
      ...(hasPhotos ? {} : { bcc: cfg.user }),
      subject,
      text: textBody,
      ...threading,
      ...(hasPhotos ? { attachments } : {}),
    });
  } catch (e: unknown) {
    return { ok: false, error: humanizeSmtpError(e) };
  }
  if (hasPhotos) {
    // E-9: merchant self-copy without the photo bytes, best-effort — the
    // customer already has the real message, so a failed copy must not fail
    // the op.
    const names = (attachments ?? []).map((a) => a.filename).join(", ");
    const marker = `[${attachments!.length} photo(s) sent to the customer: ${names} — not attached to this copy]`;
    try {
      await getTransport(cfg).sendMail({
        from,
        to: cfg.user,
        subject,
        text: `${textBody}\n\n${marker}`,
        ...threading,
      });
    } catch {
      return { ok: true, copyFailed: true };
    }
  }
  return { ok: true };
}

// ─── The `sendEmail` op (dispatched from the app.orders.tsx action) ─────────

const ORDER_CUSTOMER_EMAIL_QUERY = `#graphql
  query OrderCustomerEmailForSend($id: ID!) {
    order(id: $id) {
      id
      customer {
        defaultEmailAddress {
          emailAddress
        }
      }
    }
  }
`;

const SHOPIFY_ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

// Upstream failures (order read, SMTP send) return 200 + ok:false, NOT 5xx:
// Cloudflare replaces origin 502/504 bodies with its branded HTML error page
// (observed live through the dev tunnel 2026-07-13), which breaks the
// fetcher's JSON contract and blows up the embedded iframe. Same shape as the
// bulk ops, which also report failures inside a 200 payload. Validation stays
// 4xx — Cloudflare passes those through untouched.
function opJson(payload: SendEmailResponse, status = 200): Response {
  return Response.json(payload, status === 200 ? undefined : { status });
}

export async function handleSendEmailOp(
  admin: AdminGraphQLClient,
  fd: FormData,
  shop: string,
): Promise<Response> {
  const orderId = String(fd.get("orderId") || "");
  const subject = String(fd.get("subject") || "").trim();
  const body = String(fd.get("body") || "").trim();
  const inReplyTo = String(fd.get("inReplyTo") || "").trim();

  if (!SHOPIFY_ORDER_GID_RE.test(orderId)) {
    return opJson({ ok: false, message: "Invalid order ID." }, 400);
  }
  if (inReplyTo && !isValidMessageId(inReplyTo)) {
    return opJson({ ok: false, message: "Invalid reply reference." }, 400);
  }
  if (!subject) {
    return opJson({ ok: false, message: "Enter a subject." }, 400);
  }
  if (subject.length > MAX_EMAIL_SUBJECT_LENGTH) {
    return opJson(
      {
        ok: false,
        message: `Subject must be ${MAX_EMAIL_SUBJECT_LENGTH} characters or fewer.`,
      },
      400,
    );
  }
  if (!body) {
    return opJson({ ok: false, message: "Enter a message." }, 400);
  }
  if (body.length > MAX_EMAIL_BODY_LENGTH) {
    return opJson(
      {
        ok: false,
        message: `Message must be ${MAX_EMAIL_BODY_LENGTH} characters or fewer.`,
      },
      400,
    );
  }

  // E-8: optional photo attachments — server-side validation is authoritative
  // (the modal's checks are UX only). Repeated `photo` multipart fields.
  const photoEntries = fd
    .getAll("photo")
    .filter((v): v is File => v instanceof File && v.size > 0);
  if (photoEntries.length > MAX_EMAIL_PHOTOS) {
    return opJson(
      { ok: false, message: `Attach up to ${MAX_EMAIL_PHOTOS} photos.` },
      400,
    );
  }
  for (const photo of photoEntries) {
    if (
      !(ALLOWED_EMAIL_PHOTO_TYPES as readonly string[]).includes(photo.type)
    ) {
      return opJson(
        {
          ok: false,
          message: `"${photo.name}" is not a supported photo type — use JPEG, PNG, or WebP.`,
        },
        400,
      );
    }
    if (photo.size > MAX_EMAIL_PHOTO_BYTES) {
      return opJson(
        {
          ok: false,
          message: `"${photo.name}" is larger than ${Math.round(MAX_EMAIL_PHOTO_BYTES / 1024 / 1024)} MB.`,
        },
        400,
      );
    }
  }
  const totalPhotoBytes = photoEntries.reduce((sum, p) => sum + p.size, 0);
  if (totalPhotoBytes > MAX_EMAIL_PHOTOS_TOTAL_BYTES) {
    return opJson(
      {
        ok: false,
        message: `Photos are ${Math.round(MAX_EMAIL_PHOTOS_TOTAL_BYTES / 1024 / 1024)} MB max in total.`,
      },
      400,
    );
  }

  // E-4: the recipient is NEVER client-supplied — re-read the customer email
  // from the order, so the op cannot be used as an arbitrary-recipient relay.
  let email: string | null = null;
  try {
    const res = await admin.graphql(ORDER_CUSTOMER_EMAIL_QUERY, {
      variables: { id: orderId },
    });
    const j = (await res.json()) as {
      data?: {
        order?: {
          customer?: {
            defaultEmailAddress?: { emailAddress?: string | null } | null;
          } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (j.errors?.length) {
      return opJson({
        ok: false,
        message: `Couldn't read the order: ${j.errors.map((e) => e.message).join("; ")}`,
      });
    }
    if (!j.data?.order) {
      return opJson({ ok: false, message: "Order not found." }, 404);
    }
    email =
      j.data.order.customer?.defaultEmailAddress?.emailAddress?.trim() || null;
  } catch (e: unknown) {
    return opJson({
      ok: false,
      message: e instanceof Error ? e.message : "Couldn't read the order.",
    });
  }
  if (!email) {
    return opJson(
      { ok: false, message: "This order has no customer email." },
      400,
    );
  }

  const attachments: EmailAttachment[] = [];
  for (const photo of photoEntries) {
    attachments.push({
      filename: photo.name,
      content: Buffer.from(await photo.arrayBuffer()),
      contentType: photo.type,
    });
  }

  const sent = await sendCustomerEmail({
    to: email,
    subject,
    textBody: body,
    attachments,
    ...(inReplyTo ? { inReplyTo } : {}),
  });
  if (!sent.ok) {
    return opJson({ ok: false, message: sent.error });
  }

  // Panel-timeline log only (E-5 revisit) — the send already succeeded, so a
  // logging failure here must never turn a successful send into an error
  // response. Same guarded-write posture as mirrorLalamoveOrderStatus.
  try {
    await prisma.emailSendLog.create({
      data: { shop, shopifyOrderId: orderId, to: email, subject },
    });
  } catch (error) {
    console.warn(
      `[send-customer-email] EmailSendLog write failed for ${orderId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return opJson({
    ok: true,
    message: sent.copyFailed
      ? `Email sent to ${email}. (Couldn't save a copy to your mailbox.)`
      : `Email sent to ${email}.`,
  });
}
