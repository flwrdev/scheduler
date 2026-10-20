// Webhook handler for app/scopes_update: saves the app's new list of granted scopes on the
// stored session.

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload, session } = await authenticate.webhook(request);

  console.log("[app/scopes_update] webhook received.");
  const current = payload.current;

  if (session) {
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current.toString(),
      },
    });
    console.log("[app/scopes_update] session scope sync completed.");
  } else {
    console.log("[app/scopes_update] session scope sync skipped.");
  }

  return new Response();
};
