// Webhook handler for app/uninstalled: deletes the shop's stored sessions. Shopify can deliver
// it more than once, so a missing session is not an error.

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session } = await authenticate.webhook(request);

  console.log("[app/uninstalled] webhook received.");

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
    console.log("[app/uninstalled] session cleanup completed.");
  } else {
    console.log("[app/uninstalled] session cleanup skipped.");
  }

  return new Response();
};
