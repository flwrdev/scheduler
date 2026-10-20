// Merchant-side deep link from an order to its Messenger conversation in the
// Meta Business Suite inbox. Client-safe: no env access.

export const MESSENGER_PSID_ATTRIBUTE = "_Messenger PSID";
export const MESSENGER_SOURCE_TAG = "source:messenger";

const INBOX_BASE = "https://business.facebook.com/latest/inbox/all/";

type AttributeCarrier = { customAttributes?: Array<{ key: string; value: string | null }> | null };
type TagCarrier = { tags?: string[] | null };

export function getMessengerPsid(order: AttributeCarrier): string | null {
  const hit = (order.customAttributes ?? []).find((attr) => attr.key === MESSENGER_PSID_ATTRIBUTE);
  const value = hit?.value?.trim() ?? "";
  return /^\d{5,32}$/.test(value) ? value : null;
}

export function isMessengerSourced(order: TagCarrier): boolean {
  return (order.tags ?? []).some((tag) => tag.trim().toLowerCase() === MESSENGER_SOURCE_TAG);
}

// With a PSID the link opens that conversation; without one it opens the
// page inbox.
export function buildMessengerInboxUrl(pageId: string, psid?: string | null): string | null {
  const mailbox = pageId.trim();
  if (!/^\d{5,32}$/.test(mailbox)) return null;
  const params = new URLSearchParams({ mailbox_id: mailbox });
  if (psid) {
    params.set("selected_item_id", psid);
    params.set("thread_type", "FB_MESSAGE");
  }
  return `${INBOX_BASE}?${params.toString()}`;
}
