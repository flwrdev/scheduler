// Reads customer emails from the shop's mailbox over IMAP (imapflow) and matches replies to
// orders. listUnseenReplies feeds the notifications bell; getOrderThread returns the
// conversation of one order. Mailboxes are opened read-only, so the app never changes the
// merchant's read/unread state. The recent-inbox read behind the bell is kept in memory for
// one minute, and callers that arrive at the same time share one read.

import { ImapFlow } from "imapflow";
import type { FetchMessageObject, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { AdminGraphQLClient } from "./order-delivery-metafields.server";
import {
  EMAIL_REPLY_WINDOW_DAYS,
  EMAIL_THREAD_WINDOW_DAYS,
  type EmailReplyNotification,
  type MailboxMessage,
  type MatchedReply,
  type ReplyOrderMatch,
  isSelfAddress,
  normalizeEmail,
  normalizeEmailText,
  parseOrderNumber,
  selectUnseenReplies,
  senderVerdict,
  sortThread,
  stripQuotedReply,
} from "../lib/email-replies";
import type { MarkSeenOpConfig, SeenMetafield } from "./reschedule-seen.server";

// One IMAP connection per request, never a kept-alive IDLE session: Cloud Run
// scales to zero and gives no CPU between requests, so a background
// connection would be dropped anyway. Mailboxes are opened read-only
// (EXAMINE) and bodies fetched with BODY.PEEK so the app never flips the
// merchant's read/unread state in webmail or on the phone.

export const EMAIL_REPLY_SEEN_METAFIELD = {
  namespace: "$app",
  key: "email_reply_seen_at",
  type: "date_time",
} as const satisfies SeenMetafield;

export const EMAIL_REPLY_SEEN_OP: MarkSeenOpConfig<"markEmailReplySeen"> = {
  action: "markEmailReplySeen",
  metafield: EMAIL_REPLY_SEEN_METAFIELD,
  timestampField: "receivedAt",
  noun: "replies",
};

export const INBOX_NOT_CONFIGURED_MESSAGE =
  "The email inbox is not configured on this environment.";

// Mail clients put the text part before attachments, so a capped download
// still gets the reply text without pulling a customer's photos over IMAP.
const SOURCE_MAX_BYTES = 64 * 1024;
const MAX_RECENT_MESSAGES = 50;
const MAX_THREAD_MESSAGES = 30;
const IMAP_CONNECT_TIMEOUT_MS = 8_000;
const IMAP_SOCKET_TIMEOUT_MS = 15_000;
const IMAP_DEADLINE_MS = 20_000;
// Used only when the server does not advertise a SPECIAL-USE \Sent folder.
const SENT_FOLDER_FALLBACKS = ["Sent", "INBOX.Sent", "Sent Items", "Sent Messages"];

interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

// IMAP and SMTP are the same Private Email account and server, so the SMTP
// settings are reused and no second credential has to be kept in sync.
function imapConfig(): ImapConfig {
  return {
    host:
      process.env.EMAIL_IMAP_HOST?.trim() ||
      process.env.EMAIL_SMTP_HOST?.trim() ||
      "mail.privateemail.com",
    port: Number(process.env.EMAIL_IMAP_PORT?.trim() || "993"),
    user: process.env.EMAIL_SMTP_USER?.trim() || "",
    password: process.env.EMAIL_SMTP_PASSWORD || "",
  };
}

export type InboxResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function humanizeImapError(e: unknown): string {
  const err = e as {
    code?: unknown;
    authenticationFailed?: unknown;
    message?: unknown;
  } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  if (err?.authenticationFailed === true || code === "AUTHENTICATIONFAILED") {
    return "The mail server rejected the sign-in — check the email/password configuration.";
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "NoConnection" ||
    code === "IMAP_DEADLINE"
  ) {
    return "Couldn't reach the mail server. Try again in a moment.";
  }
  return typeof err?.message === "string" && err.message
    ? `Couldn't read the inbox: ${err.message}`
    : "Couldn't read the inbox.";
}

// socketTimeout only fires on an idle socket; a server that keeps trickling
// bytes could still hold the request open, so the whole call gets a deadline.
async function withMailbox<T>(
  cfg: ImapConfig,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: IMAP_CONNECT_TIMEOUT_MS,
    greetingTimeout: IMAP_CONNECT_TIMEOUT_MS,
    socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
  });
  // An 'error' event with no listener crashes the Node process. The same
  // failure still rejects the pending connect/fetch, where it is handled.
  client.on("error", () => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.close();
      reject(Object.assign(new Error("IMAP deadline exceeded"), { code: "IMAP_DEADLINE" }));
    }, IMAP_DEADLINE_MS);
  });

  const run = async () => {
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  };

  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// How long the recent-inbox read stays in memory before the mailbox is read again.
const INBOX_CACHE_TTL_MS = 60_000;

interface InboxSnapshot {
  key: string;
  messages: MailboxMessage[];
  readAt: number;
}

// The last good read, and the read that is running right now (if any).
// Both live in this server instance only, and both are tied to one mailbox.
let inboxSnapshot: InboxSnapshot | null = null;
let inboxInFlight: { key: string; promise: Promise<MailboxMessage[]> } | null = null;

// Forgets the saved read, so the next call reads the mailbox again.
export function clearInboxCache(): void {
  inboxSnapshot = null;
  inboxInFlight = null;
}

// Returns the recent inbox messages. A read younger than the TTL is reused.
// If a read is already running, the caller waits for it instead of opening
// a second connection. A failed read is not saved, so the next call tries again.
async function readRecentInbox(cfg: ImapConfig, now: Date): Promise<MailboxMessage[]> {
  const key = `${cfg.user}@${cfg.host}:${cfg.port}`;
  if (
    inboxSnapshot?.key === key &&
    Date.now() - inboxSnapshot.readAt < INBOX_CACHE_TTL_MS
  ) {
    return inboxSnapshot.messages;
  }
  if (inboxInFlight?.key === key) return inboxInFlight.promise;

  const promise: Promise<MailboxMessage[]> = withMailbox(cfg, (client) =>
    readMailbox(
      client,
      "INBOX",
      "inbox",
      {
        since: daysAgo(EMAIL_REPLY_WINDOW_DAYS, now),
        // Skips the BCC copies of our own sends before they are downloaded.
        not: { from: cfg.user },
      },
      MAX_RECENT_MESSAGES,
      cfg.user,
    ),
  )
    .then((messages) => {
      inboxSnapshot = { key, messages, readAt: Date.now() };
      return messages;
    })
    .finally(() => {
      if (inboxInFlight?.promise === promise) inboxInFlight = null;
    });
  inboxInFlight = { key, promise };
  return promise;
}

// A repeated header comes back as an array in top-down order; the first entry
// is the one our receiving server added.
function firstHeader(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function toMailboxMessage(
  msg: FetchMessageObject,
  mailbox: "inbox" | "sent",
  mailboxUser: string,
): Promise<MailboxMessage> {
  const envelope = msg.envelope ?? {};
  const from = envelope.from?.[0];
  const fromAddress = normalizeEmail(from?.address);
  let text = "";
  let authResults: string | null = null;
  if (msg.source) {
    const parsed = await simpleParser(msg.source, {
      skipImageLinks: true,
      skipTextLinks: true,
      skipTextToHtml: true,
    });
    text = parsed.text ?? "";
    authResults = firstHeader(parsed.headers.get("authentication-results"));
  }
  // App sends are BCC'd to this mailbox, so our own messages also show up in INBOX.
  const outbound = mailbox === "sent" || isSelfAddress(fromAddress, mailboxUser);
  const stripped = stripQuotedReply(text);
  const full = normalizeEmailText(text);
  return {
    key: `${mailbox}:${msg.uid}`,
    messageId: envelope.messageId?.trim() || null,
    subject: envelope.subject?.trim() || "(no subject)",
    fromAddress,
    fromName: from?.name?.trim() || fromAddress,
    toAddresses: (envelope.to ?? [])
      .map((a) => normalizeEmail(a.address))
      .filter(Boolean),
    date:
      toIso(envelope.date) ?? toIso(msg.internalDate) ?? new Date(0).toISOString(),
    text: stripped,
    ...(full !== stripped ? { fullText: full } : {}),
    direction: outbound ? "outbound" : "inbound",
    verdict: outbound ? "pass" : senderVerdict(authResults),
  };
}

async function readMailbox(
  client: ImapFlow,
  path: string,
  mailbox: "inbox" | "sent",
  search: SearchObject,
  limit: number,
  mailboxUser: string,
): Promise<MailboxMessage[]> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const uids = await client.search(search, { uid: true });
    if (!uids || uids.length === 0) return [];
    // UIDs increase with arrival, so the highest ones are the newest messages.
    const newest = [...uids].sort((a, b) => a - b).slice(-limit);
    const fetched: FetchMessageObject[] = [];
    for await (const msg of client.fetch(
      newest,
      {
        uid: true,
        envelope: true,
        internalDate: true,
        source: { maxLength: SOURCE_MAX_BYTES },
      },
      { uid: true },
    )) {
      fetched.push(msg);
    }
    // Parsed after the fetch loop so slow mailparser work doesn't stall the
    // IMAP stream mid-FETCH and trip the socket timeout.
    const out: MailboxMessage[] = [];
    for (const msg of fetched) {
      out.push(await toMailboxMessage(msg, mailbox, mailboxUser));
    }
    return out;
  } finally {
    lock.release();
  }
}

async function findSentFolder(client: ImapFlow): Promise<string | null> {
  const folders = await client.list();
  const special = folders.find((f) => f.specialUse === "\\Sent");
  if (special) return special.path;
  for (const name of SENT_FOLDER_FALLBACKS) {
    const hit = folders.find((f) => f.path.toLowerCase() === name.toLowerCase());
    if (hit) return hit.path;
  }
  return null;
}

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// ─── Shopify order matching ────────────────────────────────────────────────

const ORDERS_FOR_REPLIES_QUERY = `#graphql
  query OrdersForEmailReplies($query: String!, $first: Int!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        legacyResourceId
        name
        email
        customer {
          displayName
          defaultEmailAddress {
            emailAddress
          }
        }
        emailReplySeenAt: metafield(namespace: "$app", key: "email_reply_seen_at") {
          value
        }
      }
    }
  }
`;

interface ReplyOrderNode {
  id: string;
  legacyResourceId?: string | null;
  name: string;
  email?: string | null;
  customer?: {
    displayName?: string | null;
    defaultEmailAddress?: { emailAddress?: string | null } | null;
  } | null;
  emailReplySeenAt?: { value?: string | null } | null;
}

// The sender address comes from the email itself and is placed into a Shopify
// search string; anything that could break out of the quoted term is skipped.
const SEARCHABLE_EMAIL_RE = /^[^\s"'\\()<>:,]+@[^\s"'\\()<>:,]+$/;

function toOrderMatch(node: ReplyOrderNode): ReplyOrderMatch {
  return {
    orderId: node.id,
    legacyId: node.legacyResourceId?.trim() || node.id.split("/").pop() || node.id,
    name: node.name,
    customerName: node.customer?.displayName?.trim() || "",
    seenAt: node.emailReplySeenAt?.value?.trim() || null,
  };
}

function orderEmails(node: ReplyOrderNode): string[] {
  return [node.email, node.customer?.defaultEmailAddress?.emailAddress]
    .map(normalizeEmail)
    .filter(Boolean);
}

async function queryOrders(
  admin: AdminGraphQLClient,
  query: string,
  first: number,
): Promise<ReplyOrderNode[]> {
  const res = await admin.graphql(ORDERS_FOR_REPLIES_QUERY, {
    variables: { query, first },
  });
  const body = (await res.json()) as {
    data?: { orders?: { nodes?: ReplyOrderNode[] } };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data?.orders?.nodes ?? [];
}

// The subject wins over the sender because customers often reply from a
// different address than the one on the order.
export async function matchRepliesToOrders(
  admin: AdminGraphQLClient,
  messages: ReadonlyArray<MailboxMessage>,
): Promise<MatchedReply[]> {
  const inbound = messages.filter((m) => m.direction === "inbound");

  const numbers = [
    ...new Set(
      inbound.map((m) => parseOrderNumber(m.subject)).filter((n): n is string => !!n),
    ),
  ];
  const byName = new Map<string, ReplyOrderMatch>();
  if (numbers.length > 0) {
    const query = numbers.map((n) => `name:${n.slice(1)}`).join(" OR ");
    // Shopify's name search is fuzzy, so extra rows are fetched and every hit
    // is re-checked against the exact "#NNNN".
    const first = Math.min(numbers.length * 2 + 10, 100);
    for (const node of await queryOrders(admin, query, first)) {
      if (numbers.includes(node.name)) byName.set(node.name, toOrderMatch(node));
    }
  }

  const unmatchedSenders = [
    ...new Set(
      inbound
        .filter((m) => {
          const n = parseOrderNumber(m.subject);
          return !n || !byName.has(n);
        })
        .map((m) => m.fromAddress)
        .filter((a) => SEARCHABLE_EMAIL_RE.test(a)),
    ),
  ];
  const bySender = new Map<string, ReplyOrderMatch>();
  if (unmatchedSenders.length > 0) {
    const emails = unmatchedSenders.map((a) => `email:"${a}"`).join(" OR ");
    const nodes = await queryOrders(admin, `(${emails}) status:open`, 50);
    for (const node of nodes) {
      for (const email of orderEmails(node)) {
        if (unmatchedSenders.includes(email) && !bySender.has(email)) {
          bySender.set(email, toOrderMatch(node));
        }
      }
    }
  }

  const matched: MatchedReply[] = [];
  for (const message of inbound) {
    const number = parseOrderNumber(message.subject);
    const bySubject = number ? byName.get(number) : undefined;
    if (bySubject) {
      matched.push({ message, order: bySubject, matchedBy: "subject" });
      continue;
    }
    const sender = bySender.get(message.fromAddress);
    if (sender) matched.push({ message, order: sender, matchedBy: "sender" });
  }
  return matched;
}

// ─── Entry points for the resource routes ──────────────────────────────────

// The mailbox part comes from readRecentInbox (cached). Matching to orders and the
// seen check run on every call, so a reply marked as seen disappears right away.
export async function listUnseenReplies(
  admin: AdminGraphQLClient,
  now: Date = new Date(),
): Promise<InboxResult<EmailReplyNotification[]>> {
  const cfg = imapConfig();
  if (!cfg.user || !cfg.password) {
    return { ok: false, error: INBOX_NOT_CONFIGURED_MESSAGE };
  }
  let messages: MailboxMessage[];
  try {
    messages = await readRecentInbox(cfg, now);
  } catch (e) {
    return { ok: false, error: humanizeImapError(e) };
  }
  try {
    const matched = await matchRepliesToOrders(admin, messages);
    return { ok: true, data: selectUnseenReplies(matched) };
  } catch (e) {
    return {
      ok: false,
      error: `Couldn't match replies to orders: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface OrderThreadInput {
  orderName: string;
  customerEmail: string | null;
}

// Sent is read too, so replies the merchant wrote in webmail appear in the
// thread; app sends are already in INBOX as BCC copies.
export async function getOrderThread(
  { orderName, customerEmail }: OrderThreadInput,
  now: Date = new Date(),
): Promise<InboxResult<MailboxMessage[]>> {
  const cfg = imapConfig();
  if (!cfg.user || !cfg.password) {
    return { ok: false, error: INBOX_NOT_CONFIGURED_MESSAGE };
  }
  const email = normalizeEmail(customerEmail);
  const or: SearchObject[] = [{ subject: orderName }];
  if (email) or.push({ from: email }, { to: email });
  const search: SearchObject = {
    since: daysAgo(EMAIL_THREAD_WINDOW_DAYS, now),
    or,
  };

  // IMAP SUBJECT is a substring match ("#4539" also hits "#45391"), and a
  // customer with several orders must not see another order's emails here.
  const belongs = (m: MailboxMessage): boolean => {
    const number = parseOrderNumber(m.subject);
    if (number) return number === orderName;
    return email !== "" && (m.fromAddress === email || m.toAddresses.includes(email));
  };

  try {
    const messages = await withMailbox(cfg, async (client) => {
      const inbox = await readMailbox(
        client,
        "INBOX",
        "inbox",
        search,
        MAX_THREAD_MESSAGES,
        cfg.user,
      );
      const sentPath = await findSentFolder(client);
      const sent = sentPath
        ? await readMailbox(client, sentPath, "sent", search, MAX_THREAD_MESSAGES, cfg.user)
        : [];
      return [...inbox, ...sent];
    });
    return { ok: true, data: sortThread(messages.filter(belongs)) };
  } catch (e) {
    return { ok: false, error: humanizeImapError(e) };
  }
}
