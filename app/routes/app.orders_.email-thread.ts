// Resource route (GET /app/orders/email-thread?orderId=...): the email conversation of one order
// plus the saved quick replies. Only the order id comes from the browser; the order name and the
// customer address are read from Shopify, so a crafted URL cannot read another address's mail.

import type {
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from "react-router";

import type { MailboxMessage } from "../lib/email-replies";
import { type QuickReply, parseQuickReplies } from "../lib/quick-replies";
import { getOrderThread } from "../services/customer-inbox.server";
import { authenticate } from "../shopify.server";

// Only the order id comes from the client. The order name and customer
// email are read from Shopify, so a crafted URL can't pull an arbitrary
// address's mail out of the mailbox.
export type EmailThreadData =
  | {
      ok: true;
      orderId: string;
      messages: MailboxMessage[];
      quickReplies: QuickReply[];
    }
  | { ok: false; orderId: string; error: string; messages: [] };

// Every read is a fresh IMAP login; only a send can change this thread.
export function shouldRevalidate({ formData }: ShouldRevalidateFunctionArgs) {
  return String(formData?.get("_action") ?? "") === "sendEmail";
}

const ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

const ORDER_FOR_THREAD_QUERY = `#graphql
  query OrderForEmailThread($id: ID!) {
    order(id: $id) {
      id
      name
      email
      customer {
        defaultEmailAddress {
          emailAddress
        }
      }
    }
    shop {
      quickReplies: metafield(namespace: "$app", key: "quick_replies") {
        value
      }
    }
  }
`;

interface OrderForThread {
  id: string;
  name: string;
  email?: string | null;
  customer?: {
    defaultEmailAddress?: { emailAddress?: string | null } | null;
  } | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const orderId = new URL(request.url).searchParams.get("orderId")?.trim() ?? "";

  const failure = (error: string, status?: number) =>
    Response.json(
      { ok: false, orderId, error, messages: [] } satisfies EmailThreadData,
      status ? { status } : undefined,
    );

  if (!ORDER_GID_RE.test(orderId)) {
    return failure("Invalid order ID.", 400);
  }

  let order: OrderForThread | null = null;
  let quickReplies: QuickReply[] = [];
  try {
    const res = await admin.graphql(ORDER_FOR_THREAD_QUERY, {
      variables: { id: orderId },
    });
    const body = (await res.json()) as {
      data?: {
        order?: OrderForThread | null;
        shop?: { quickReplies?: { value?: string | null } | null } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
      return failure(
        `Couldn't read the order: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    order = body.data?.order ?? null;
    quickReplies = parseQuickReplies(body.data?.shop?.quickReplies?.value);
  } catch (e) {
    return failure(e instanceof Error ? e.message : "Couldn't read the order.");
  }
  if (!order) {
    return failure("Order not found.", 404);
  }

  const result = await getOrderThread({
    orderName: order.name,
    customerEmail:
      order.customer?.defaultEmailAddress?.emailAddress ?? order.email ?? null,
  });
  if (!result.ok) {
    console.warn(`[orders email-thread] ${order.name}: ${result.error}`);
    return failure(result.error);
  }
  return Response.json({
    ok: true,
    orderId,
    messages: result.data,
    quickReplies,
  } satisfies EmailThreadData);
};
