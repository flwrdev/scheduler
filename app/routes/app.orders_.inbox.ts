// Resource route (GET /app/orders/inbox): unseen customer email replies read from the mailbox
// over IMAP, for the notifications bell. It is separate from the orders loader so a slow or
// unreachable mailbox can never delay the orders list. Admin session required.

import type {
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from "react-router";

import type { EmailReplyNotification } from "../lib/email-replies";
import { listUnseenReplies } from "../services/customer-inbox.server";
import { authenticate } from "../shopify.server";

// Kept out of the orders loader so a slow or unreachable mailbox can never
// delay or break the orders list itself.
export type InboxRepliesData =
  | { ok: true; replies: EmailReplyNotification[] }
  | { ok: false; error: string; replies: [] };

const REVALIDATING_ACTIONS = new Set(["markEmailReplySeen", "sendEmail"]);

// Only these two actions reload the bell. The matching step is quick, and the
// mailbox read behind it is reused for a minute, so other actions skip the bell.
export function shouldRevalidate({ formData }: ShouldRevalidateFunctionArgs) {
  if (!formData) return false;
  return REVALIDATING_ACTIONS.has(String(formData.get("_action") ?? ""));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const result = await listUnseenReplies(admin);
  if (!result.ok) {
    console.warn(`[orders inbox] ${result.error}`);
    return Response.json({
      ok: false,
      error: result.error,
      replies: [],
    } satisfies InboxRepliesData);
  }
  return Response.json({
    ok: true,
    replies: result.data,
  } satisfies InboxRepliesData);
};
