// Resource route (/app/scheduler/quick-replies): loads and saves the merchant's saved email
// replies, stored in the shop metafield $app.quick_replies. Kept apart from the scheduler
// action so saving replies never touches the schedule rules. Admin session required.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  type QuickReply,
  type QuickReplyFieldErrors,
  validateQuickReplies,
} from "../lib/quick-replies";
import { readQuickReplies, saveQuickReplies } from "../services/quick-replies.server";
import { authenticate } from "../shopify.server";

// A separate route from the scheduler action, so saving replies writes only
// the shop metafield and never touches the scheduler's stored settings.
export type QuickRepliesData =
  | { ok: true; replies: QuickReply[]; saved?: boolean }
  | { ok: false; message: string; fieldErrors?: QuickReplyFieldErrors };

// The action response already carries the saved list, and the scheduler's
// own ops never change it.
export function shouldRevalidate() {
  return false;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const result = await readQuickReplies(admin);
  return Response.json(
    (result.ok
      ? { ok: true, replies: result.replies }
      : { ok: false, message: result.message }) satisfies QuickRepliesData,
    { headers: { "Cache-Control": "no-store" } },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  if (request.method.toUpperCase() !== "POST") {
    return Response.json(
      { ok: false, message: "Method not allowed." } satisfies QuickRepliesData,
      { status: 405 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({
      ok: false,
      message: "Request body must be JSON.",
    } satisfies QuickRepliesData);
  }

  const validation = validateQuickReplies(
    (body as { replies?: unknown } | null)?.replies,
  );
  if (!validation.ok) {
    return Response.json({
      ok: false,
      message: validation.message,
      fieldErrors: validation.fieldErrors,
    } satisfies QuickRepliesData);
  }

  const result = await saveQuickReplies(admin, validation.replies);
  if (!result.ok) {
    console.error(`[quick replies] ${result.message}`);
    return Response.json({ ok: false, message: result.message } satisfies QuickRepliesData);
  }
  return Response.json({
    ok: true,
    replies: result.replies,
    saved: true,
  } satisfies QuickRepliesData);
};
