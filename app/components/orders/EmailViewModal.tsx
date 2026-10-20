// Modal that shows one email from the customer's conversation, with the saved quick replies
// and a Reply button for messages from the customer.

import { useEffect, useState } from "react";
import type { MailboxMessage } from "../../lib/email-replies";
import type { QuickReply } from "../../lib/quick-replies";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { AppModal } from "../ui/AppModal";

export interface EmailViewModalProps {
  open: boolean;
  onClose: () => void;
  message: MailboxMessage | null;
  quickReplies: QuickReply[];
  onReply: (message: MailboxMessage) => void;
}

function formatFullDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Shows the sender, the date, the message text and the quick replies. The message text is shown
// as plain text, never as HTML.
export function EmailViewModal({
  open,
  onClose,
  message,
  quickReplies,
  onReply,
}: EmailViewModalProps) {
  const { fieldCopied, copyField } = useCopyToClipboard();
  const [showQuoted, setShowQuoted] = useState(false);

  const messageKey = message?.key ?? null;
  useEffect(() => {
    setShowQuoted(false);
  }, [messageKey, open]);

  if (!message) return null;
  const inbound = message.direction === "inbound";
  const body = showQuoted && message.fullText ? message.fullText : message.text;

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={message.subject}
      primaryAction={
        inbound ? { content: "Reply", onAction: () => onReply(message) } : undefined
      }
      secondaryActions={[{ content: "Close", onAction: onClose }]}
    >
      <s-stack gap="base">
        <s-stack gap="small-500">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text fontWeight="semibold">{message.fromName}</s-text>
            {message.fromName !== message.fromAddress && (
              <s-text color="subdued">&lt;{message.fromAddress}&gt;</s-text>
            )}
            {inbound && message.verdict === "fail" && (
              <s-badge tone="warning">Unverified sender</s-badge>
            )}
          </s-stack>
          {message.toAddresses.length > 0 && (
            <s-text color="subdued">To: {message.toAddresses.join(", ")}</s-text>
          )}
          <s-text color="subdued">{formatFullDate(message.date)}</s-text>
        </s-stack>
        <s-divider />
        <s-stack gap="small-200">
          <span className="odp-email-text">
            <s-text>{body || "(no text)"}</s-text>
          </span>
          {message.fullText && (
            <s-stack direction="inline">
              <s-button variant="tertiary" onClick={() => setShowQuoted((v) => !v)}>
                {showQuoted ? "Hide quoted text" : "Show quoted text"}
              </s-button>
            </s-stack>
          )}
        </s-stack>
        {inbound && (
          <s-stack gap="small-200">
            <s-divider />
            <s-heading>Quick replies</s-heading>
            {quickReplies.length > 0 ? (
              <s-stack direction="inline" gap="small-200">
                {quickReplies.map((reply, index) => {
                  const key = `quick-reply-${index}`;
                  return (
                    <s-button
                      key={key}
                      accessibilityLabel={`Copy quick reply: ${reply.label}`}
                      onClick={() => copyField(key, reply.message)}
                    >
                      {fieldCopied === key ? "Copied" : reply.label}
                    </s-button>
                  );
                })}
              </s-stack>
            ) : (
              <s-text color="subdued">
                No quick replies yet. Add them on the Delivery Scheduler page.
              </s-text>
            )}
          </s-stack>
        )}
      </s-stack>
    </AppModal>
  );
}
