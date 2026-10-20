// Modal to write an email to the customer of an order, with up to three photos. Submits the
// `sendEmail` action as multipart form data.

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { SendEmailResponse } from "../../services/send-customer-email.server";
import { replySubject } from "../../lib/email-replies";
import { flag } from "../../lib/web-component-props";
import { AppModal } from "../ui/AppModal";

// "Send email" compose modal (customer-email-design.md §4) — opened from the
// details panel's Actions menu, single order only. The To field is display
// only: the server re-reads the customer email from the order id (E-4), so
// nothing typed here can redirect the send. Sends through the merchant's
// business mailbox; writes nothing to the order (E-5).
export interface SendEmailModalProps {
  open: boolean;
  onClose: () => void;
  orderId: string | null;
  orderName: string | null;
  customerEmail: string | null;
  replyTo?: { subject: string; messageId: string | null } | null;
}

const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

// E-8 photo caps — mirror the authoritative server-side limits in
// send-customer-email.server.ts (client checks are UX only).
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS_TOTAL_BYTES = 15 * 1024 * 1024;
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function SendEmailModal({
  open,
  onClose,
  orderId,
  orderName,
  customerEmail,
  replyTo = null,
}: SendEmailModalProps) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<SendEmailResponse>();
  const isSubmitting = fetcher.state !== "idle";

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Reset + prefill each time the modal opens (same pattern as
  // RescheduleModal). Subject prefill: "Order #XXXX".
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      // The added "Re: " can push a max-length subject past the server's cap.
      setSubject(
        replyTo
          ? replySubject(replyTo.subject).slice(0, MAX_SUBJECT)
          : orderName
            ? `Order ${orderName}`
            : "",
      );
      setBody("");
      setPhotos([]);
      setError(null);
      setPhotoError(null);
    }
    wasOpenRef.current = open;
  }, [open, orderName, replyTo]);

  // Thumbnail previews need object URLs, which must be revoked on change.
  const photoPreviews = useMemo(
    () => photos.map((file) => URL.createObjectURL(file)),
    [photos],
  );
  useEffect(() => {
    return () => {
      for (const url of photoPreviews) URL.revokeObjectURL(url);
    };
  }, [photoPreviews]);

  // Success → toast + close. Failure → banner INSIDE the modal so the typed
  // message is never lost; fields stay editable for retry.
  const handledDataRef = useRef<SendEmailResponse | null>(null);
  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledDataRef.current === fetcher.data) return;
    handledDataRef.current = fetcher.data;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      onClose();
    } else {
      setError(fetcher.data.message || "Failed to send the email.");
    }
  }, [fetcher.data, fetcher.state, shopify, onClose]);

  // Checks the photos the merchant picked or dropped and keeps the ones that pass the limits.
  const handleDropPhotos = (accepted: File[]) => {
    setPhotoError(null);
    const next = [...photos];
    const rejected: string[] = [];
    for (const file of accepted) {
      if (next.length >= MAX_PHOTOS) {
        rejected.push(`only ${MAX_PHOTOS} photos per email`);
        break;
      }
      if (!PHOTO_TYPES.includes(file.type)) {
        rejected.push(`"${file.name}" is not a JPEG/PNG/WebP image`);
        continue;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        rejected.push(`"${file.name}" is over ${mb(MAX_PHOTO_BYTES)}`);
        continue;
      }
      if (
        next.reduce((sum, f) => sum + f.size, 0) + file.size >
        MAX_PHOTOS_TOTAL_BYTES
      ) {
        rejected.push(`photos are ${mb(MAX_PHOTOS_TOTAL_BYTES)} max in total`);
        continue;
      }
      next.push(file);
    }
    setPhotos(next);
    if (rejected.length) {
      setPhotoError(`Some photos were not added: ${rejected.join("; ")}.`);
    }
  };

  const removePhoto = (index: number) => {
    setPhotoError(null);
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const canSend =
    !isSubmitting &&
    Boolean(orderId) &&
    subject.trim().length > 0 &&
    body.trim().length > 0;

  const handleSend = () => {
    if (!orderId) return;
    setError(null);
    const fd = new FormData();
    fd.append("_action", "sendEmail");
    fd.append("orderId", orderId);
    fd.append("subject", subject);
    fd.append("body", body);
    if (replyTo?.messageId) fd.append("inReplyTo", replyTo.messageId);
    for (const photo of photos) fd.append("photo", photo, photo.name);
    // multipart: the photos must survive serialization; the route action's
    // request.formData() parses multipart natively, with or without files.
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={replyTo ? "Reply to customer" : "Send email"}
      primaryAction={{
        content: isSubmitting ? "Sending…" : replyTo ? "Send reply" : "Send email",
        onAction: handleSend,
        loading: isSubmitting,
        disabled: !canSend,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <s-stack gap="base">
        {error && (
          <s-banner tone="critical" heading="The email was not sent">
            {error}
          </s-banner>
        )}
        <s-text-field
          label="To"
          value={customerEmail ?? ""}
          disabled
          autocomplete="off"
        />
        <s-text-field
          label="Subject"
          value={subject}
          disabled={flag(isSubmitting)}
          maxLength={MAX_SUBJECT}
          autocomplete="off"
          onInput={(e) => setSubject(e.currentTarget.value)}
        />
        <s-text-area
          label="Message"
          value={body}
          disabled={flag(isSubmitting)}
          rows={6}
          maxLength={MAX_BODY}
          autocomplete="off"
          details={`${body.length}/${MAX_BODY} characters. Sent as plain text from your business mailbox. A copy is BCC'd to you.`}
          onInput={(e) => setBody(e.currentTarget.value)}
        />
        <s-stack gap="small-200">
          {photoError && <s-banner tone="warning">{photoError}</s-banner>}
          {photos.length < MAX_PHOTOS && (
            <s-stack gap="small-300">
              <s-drop-zone
                label="Add photos"
                accessibilityLabel="Add photos"
                accept={PHOTO_ACCEPT}
                multiple
                disabled={flag(isSubmitting)}
                onInput={(e) => {
                  const zone = e.currentTarget;
                  const picked = Array.from(zone.files);
                  zone.value = "";
                  handleDropPhotos(picked);
                }}
              />
              <s-text color="subdued">
                {`JPEG, PNG, or WebP · up to ${MAX_PHOTOS} photos, ${mb(MAX_PHOTO_BYTES)} each`}
              </s-text>
            </s-stack>
          )}
          {photos.map((photo, index) => (
            <s-stack
              key={`${photo.name}-${index}`}
              direction="inline"
              gap="small"
              alignItems="center"
            >
              <s-thumbnail src={photoPreviews[index]} alt={photo.name} size="small" />
              <div
                style={{
                  minWidth: 0,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <s-text>{photo.name}</s-text>
              </div>
              <s-button
                variant="tertiary"
                tone="critical"
                disabled={flag(isSubmitting)}
                onClick={() => removePhoto(index)}
              >
                Remove
              </s-button>
            </s-stack>
          ))}
          {photos.length > 0 && (
            <s-text color="subdued">
              Photos are sent to the customer only — your mailbox copy lists
              them without the attachments to save storage space.
            </s-text>
          )}
        </s-stack>
      </s-stack>
    </AppModal>
  );
}
