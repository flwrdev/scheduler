// Shared by the Delivery Scheduler card, the resource route and the View email
// modal, so the client and server apply the same limits.

export interface QuickReply {
  label: string;
  message: string;
}

export const MAX_QUICK_REPLIES = 20;
export const MAX_QUICK_REPLY_LABEL = 40;
// Matches the Send email modal's body cap, so a copied reply always fits.
export const MAX_QUICK_REPLY_MESSAGE = 5000;

export type QuickReplyFieldErrors = Record<number, { label?: string; message?: string }>;

export type QuickRepliesValidation =
  | { ok: true; replies: QuickReply[] }
  | { ok: false; message: string; fieldErrors: QuickReplyFieldErrors };

export function validateQuickReplies(input: unknown): QuickRepliesValidation {
  if (!Array.isArray(input)) {
    return { ok: false, message: "Quick replies must be a list.", fieldErrors: {} };
  }
  if (input.length > MAX_QUICK_REPLIES) {
    return {
      ok: false,
      message: `Up to ${MAX_QUICK_REPLIES} quick replies.`,
      fieldErrors: {},
    };
  }
  const replies: QuickReply[] = [];
  const fieldErrors: QuickReplyFieldErrors = {};
  input.forEach((item, index) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    const errors: { label?: string; message?: string } = {};
    if (!label) errors.label = "Enter a label.";
    else if (label.length > MAX_QUICK_REPLY_LABEL) {
      errors.label = `Keep the label under ${MAX_QUICK_REPLY_LABEL} characters.`;
    }
    if (!message) errors.message = "Enter a message.";
    else if (message.length > MAX_QUICK_REPLY_MESSAGE) {
      errors.message = `Keep the message under ${MAX_QUICK_REPLY_MESSAGE} characters.`;
    }
    if (errors.label || errors.message) fieldErrors[index] = errors;
    replies.push({ label, message });
  });
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, message: "Check the highlighted replies.", fieldErrors };
  }
  return { ok: true, replies };
}

// The stored value can be edited outside the app (e.g. through the Admin
// API), so malformed entries are dropped on read instead of failing the page.
export function parseQuickReplies(value: string | null | undefined): QuickReply[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (r): r is QuickReply =>
        !!r &&
        typeof (r as QuickReply).label === "string" &&
        typeof (r as QuickReply).message === "string" &&
        (r as QuickReply).label.trim() !== "" &&
        (r as QuickReply).message.trim() !== "",
    )
    .slice(0, MAX_QUICK_REPLIES)
    .map((r) => ({ label: r.label, message: r.message }));
}
