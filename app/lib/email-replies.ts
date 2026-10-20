// Kept free of IMAP and Shopify imports so the matching and quote-stripping
// rules can be unit-tested directly and imported by client components.

export type EmailDirection = "inbound" | "outbound";

export type SenderVerdict = "pass" | "fail" | "unknown";

// Only these fields reach the browser; raw headers and HTML bodies stay on
// the server, so nothing a sender writes is ever rendered as markup.
export interface MailboxMessage {
  /** Prefixed with the mailbox because IMAP UIDs are only unique within one mailbox. */
  key: string;
  messageId: string | null;
  subject: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  /** Falls back to the IMAP internal date because some senders omit or mangle the Date header. */
  date: string;
  /** Quoted history is removed, otherwise every reply repeats our own email underneath it. */
  text: string;
  /** Present only when quote stripping removed something, to keep the thread payload small. */
  fullText?: string;
  direction: EmailDirection;
  verdict: SenderVerdict;
}

export interface ReplyOrderMatch {
  orderId: string;
  legacyId: string;
  name: string;
  customerName: string;
  seenAt: string | null;
}

// One row per order, not per message: Seen is stored per order as a
// timestamp, so acknowledging the newest reply covers the older ones too.
export interface EmailReplyNotification {
  orderId: string;
  legacyId: string;
  name: string;
  customerName: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  preview: string;
  receivedAt: string;
  unseenCount: number;
  matchedBy: "subject" | "sender";
  verdict: SenderVerdict;
}

export const EMAIL_REPLY_WINDOW_DAYS = 3;
export const EMAIL_THREAD_WINDOW_DAYS = 90;
export const EMAIL_PREVIEW_LENGTH = 140;
export const EMAIL_TEXT_MAX_LENGTH = 4000;

const ORDER_NUMBER_RE = /#\s?(\d{3,8})\b/;

// The subject is the main link back to an order: every email the app sends
// starts with "Order #NNNN", and mail clients keep the subject on reply.
export function parseOrderNumber(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const match = ORDER_NUMBER_RE.exec(subject);
  return match ? `#${match[1]}` : null;
}

export function normalizeEmail(address: string | null | undefined): string {
  return (address ?? "").trim().toLowerCase();
}

export function isSelfAddress(
  address: string | null | undefined,
  mailboxUser: string | null | undefined,
): boolean {
  const a = normalizeEmail(address);
  return a !== "" && a === normalizeEmail(mailboxUser);
}

// "Noong … sumulat si …:" is Gmail's attribution line in the Filipino locale.
const ATTRIBUTION_TAIL_RE = /(wrote|sumulat(?: si)?[^:]*|escribió|a écrit)\s*:\s*$/i;
const ORIGINAL_MESSAGE_RE = /^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}/i;
const OUTLOOK_RULE_RE = /^\s*_{10,}\s*$/;
const OUTLOOK_FROM_RE = /^\s*\*?from:\*?\s/i;
const OUTLOOK_META_RE = /^\s*\*?(sent|date|to|subject):\*?\s/i;
const SIGNATURE_RE = /^-- ?$/;

// Gmail wraps a long "On <date> <name> <address> wrote:" line, so the
// "wrote:" can land up to two lines after the "On".
function findQuoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ORIGINAL_MESSAGE_RE.test(line) || OUTLOOK_RULE_RE.test(line)) return i;
    if (SIGNATURE_RE.test(line)) return i;
    if (
      OUTLOOK_FROM_RE.test(line) &&
      lines.slice(i + 1, i + 5).some((l) => OUTLOOK_META_RE.test(l))
    ) {
      return i;
    }
    if (/^\s*(on|noong)\s/i.test(line)) {
      for (let j = i; j < Math.min(i + 3, lines.length); j += 1) {
        if (ATTRIBUTION_TAIL_RE.test(lines[j])) return i;
      }
    }
    if (/^\s*>/.test(line)) {
      // Unknown-locale attribution lines still end in ":" right above the
      // quote; a line ending in sentence punctuation is the customer's text.
      let start = i;
      let k = i - 1;
      while (k >= 0 && lines[k].trim() === "") k -= 1;
      if (k >= 0 && lines[k].trim().endsWith(":")) {
        start = k;
        if (k - 1 >= 0 && lines[k - 1].trim() !== "" && !/[.!?]$/.test(lines[k - 1].trim())) {
          start = k - 1;
        }
      }
      return start;
    }
  }
  return -1;
}

// Falls back to the full text when nothing is left above the quote, e.g. a
// customer who answered inline between quoted lines: too much beats nothing.
export function stripQuotedReply(text: string | null | undefined): string {
  const source = (text ?? "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const cut = findQuoteStart(lines);
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return capEmailText(kept || source.trim());
}

export function capEmailText(text: string): string {
  return text.length > EMAIL_TEXT_MAX_LENGTH
    ? `${text.slice(0, EMAIL_TEXT_MAX_LENGTH).trimEnd()}…`
    : text;
}

export function normalizeEmailText(text: string | null | undefined): string {
  return capEmailText((text ?? "").replace(/\r\n?/g, "\n").trim());
}

export function buildPreview(text: string, max = EMAIL_PREVIEW_LENGTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// Callers pass only the topmost Authentication-Results header: our receiving
// server adds it, while lower ones travel with the message and can be forged.
// Anyone can put "Order #4539" in a subject, so a failed check is surfaced.
export function senderVerdict(authResults: string | null | undefined): SenderVerdict {
  const value = (authResults ?? "").toLowerCase();
  if (!value) return "unknown";
  const dmarc = /\bdmarc=(\w+)/.exec(value)?.[1];
  if (dmarc === "pass") return "pass";
  if (dmarc === "fail") return "fail";
  const spf = /\bspf=(\w+)/.exec(value)?.[1];
  const dkim = /\bdkim=(\w+)/.exec(value)?.[1];
  if (spf === "fail" && dkim && dkim !== "pass") return "fail";
  if (spf === "pass" || dkim === "pass") return "pass";
  return "unknown";
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

const MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;

// The value is written into the In-Reply-To and References headers, so only a
// single <id@host> passes (no CR/LF header injection). 998 is RFC 5322's line limit.
export function isValidMessageId(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.length <= 998 && MESSAGE_ID_RE.test(value.trim());
}

function timeOf(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
}

export interface MatchedReply {
  message: MailboxMessage;
  order: ReplyOrderMatch;
  matchedBy: "subject" | "sender";
}

// Seen stores the acknowledged reply's own time, not the click time, so a
// reply that arrives after the click is still newer and resurfaces.
export function selectUnseenReplies(
  replies: ReadonlyArray<MatchedReply>,
): EmailReplyNotification[] {
  const byOrder = new Map<string, { latest: MatchedReply; count: number }>();
  for (const reply of replies) {
    if (reply.message.direction !== "inbound") continue;
    const ts = timeOf(reply.message.date);
    if (!Number.isFinite(ts)) continue;
    const seenTs = reply.order.seenAt ? Date.parse(reply.order.seenAt) : Number.NaN;
    if (!Number.isNaN(seenTs) && seenTs >= ts) continue;
    const entry = byOrder.get(reply.order.orderId);
    if (!entry) {
      byOrder.set(reply.order.orderId, { latest: reply, count: 1 });
      continue;
    }
    entry.count += 1;
    if (ts > timeOf(entry.latest.message.date)) entry.latest = reply;
  }

  return [...byOrder.values()]
    .sort((a, b) => timeOf(b.latest.message.date) - timeOf(a.latest.message.date))
    .map(({ latest, count }) => ({
      orderId: latest.order.orderId,
      legacyId: latest.order.legacyId,
      name: latest.order.name,
      customerName: latest.order.customerName,
      fromName: latest.message.fromName,
      fromAddress: latest.message.fromAddress,
      subject: latest.message.subject,
      preview: buildPreview(latest.message.text),
      receivedAt: new Date(timeOf(latest.message.date)).toISOString(),
      unseenCount: count,
      matchedBy: latest.matchedBy,
      verdict: latest.message.verdict,
    }));
}

// A message can sit in both INBOX and Sent (a webmail reply that also copied
// the mailbox), so the thread is de-duplicated by Message-ID.
export function sortThread(messages: ReadonlyArray<MailboxMessage>): MailboxMessage[] {
  const seen = new Set<string>();
  const unique: MailboxMessage[] = [];
  for (const message of messages) {
    const id = message.messageId ?? message.key;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(message);
  }
  return unique.sort((a, b) => timeOf(b.date) - timeOf(a.date));
}
