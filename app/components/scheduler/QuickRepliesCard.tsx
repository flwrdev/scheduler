// Scheduler card to edit the merchant's saved email replies. Loads and saves them through
// /app/scheduler/quick-replies.

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import {
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_LABEL,
  MAX_QUICK_REPLY_MESSAGE,
  type QuickReply,
  type QuickReplyFieldErrors,
} from "../../lib/quick-replies";
import { flag } from "../../lib/web-component-props";
import type { QuickRepliesData } from "../../routes/app.scheduler_.quick-replies";
import { SectionHeader } from "../ui/SectionHeader";

const QUICK_REPLIES_URL = "/app/scheduler/quick-replies";

// The key only gives React a stable identity while rows are moved or deleted.
interface DraftReply extends QuickReply {
  key: number;
}

let nextDraftKey = 0;

// Turns saved replies into editable drafts, each with its own key.
function toDrafts(replies: ReadonlyArray<QuickReply>): DraftReply[] {
  return replies.map((r) => ({ ...r, key: nextDraftKey++ }));
}

// True when both lists have the same replies in the same order.
function sameReplies(a: ReadonlyArray<QuickReply>, b: ReadonlyArray<QuickReply>) {
  return (
    a.length === b.length &&
    a.every((r, i) => r.label === b[i].label && r.message === b[i].message)
  );
}

export function QuickRepliesCard() {
  const shopify = useAppBridge();
  const loadFetcher = useFetcher<QuickRepliesData>();
  const saveFetcher = useFetcher<QuickRepliesData>();
  const saving = saveFetcher.state !== "idle";

  const [saved, setSaved] = useState<QuickReply[] | null>(null);
  const [drafts, setDrafts] = useState<DraftReply[]>([]);
  const [fieldErrors, setFieldErrors] = useState<QuickReplyFieldErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = loadFetcher.load;
  useEffect(() => {
    load(QUICK_REPLIES_URL);
  }, [load]);

  useEffect(() => {
    const data = loadFetcher.data;
    if (!data || loadFetcher.state !== "idle") return;
    if (data.ok) {
      setSaved(data.replies);
      setDrafts(toDrafts(data.replies));
      setLoadError(null);
    } else {
      setLoadError(data.message);
    }
  }, [loadFetcher.data, loadFetcher.state]);

  const handledSaveRef = useRef<QuickRepliesData | null>(null);
  useEffect(() => {
    const data = saveFetcher.data;
    if (!data || saveFetcher.state !== "idle") return;
    if (handledSaveRef.current === data) return;
    handledSaveRef.current = data;
    if (data.ok) {
      setSaved(data.replies);
      setDrafts(toDrafts(data.replies));
      setFieldErrors({});
      shopify.toast.show("Quick replies saved");
    } else {
      setFieldErrors(data.fieldErrors ?? {});
      shopify.toast.show(data.message, { isError: true });
    }
  }, [saveFetcher.data, saveFetcher.state, shopify]);

  const dirty = saved !== null && !sameReplies(saved, drafts);

  // Replaces the drafts and clears the row errors, because row numbers change after a move
  // or a delete.
  const updateDrafts = (next: DraftReply[]) => {
    setDrafts(next);
    setFieldErrors({});
  };

  // Swaps the reply at `index` with its neighbour above (-1) or below (1).
  const move = (index: number, delta: -1 | 1) => {
    const next = [...drafts];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    updateDrafts(next);
  };

  const save = () => {
    saveFetcher.submit(
      { replies: drafts.map(({ label, message }) => ({ label, message })) },
      { method: "post", action: QUICK_REPLIES_URL, encType: "application/json" },
    );
  };

  return (
    <s-section>
      <s-stack gap="base">
        <SectionHeader
          title="Quick replies"
          description="Shown in the View email window on the Orders page. One click copies the message."
          action={
            <s-button
              disabled={flag(
                saved === null || drafts.length >= MAX_QUICK_REPLIES || saving,
              )}
              onClick={() =>
                setDrafts((d) => [...d, ...toDrafts([{ label: "", message: "" }])])
              }
            >
              Add reply
            </s-button>
          }
        />

        {loadError && <s-banner tone="critical">{loadError}</s-banner>}

        {saved === null && !loadError && (
          <s-paragraph color="subdued">Loading quick replies…</s-paragraph>
        )}

        {saved !== null && drafts.length === 0 && (
          <s-paragraph color="subdued">No quick replies yet.</s-paragraph>
        )}

        {drafts.length > 0 && (
          <s-stack gap="small">
            {drafts.map((reply, index) => (
              <s-stack key={reply.key} gap="small-200">
                {index > 0 && <s-divider />}
                <s-stack
                  direction="inline"
                  justifyContent="space-between"
                  alignItems="end"
                  gap="small-200"
                >
                  <div style={{ minWidth: "200px", flexGrow: 1 }}>
                    <s-text-field
                      label="Label"
                      autocomplete="off"
                      value={reply.label}
                      maxLength={MAX_QUICK_REPLY_LABEL}
                      error={fieldErrors[index]?.label}
                      disabled={flag(saving)}
                      onInput={(e) => {
                        const label = e.currentTarget.value;
                        setDrafts((d) =>
                          d.map((r, i) => (i === index ? { ...r, label } : r)),
                        );
                      }}
                    />
                  </div>
                  <s-stack direction="inline" gap="small-200">
                    <s-button
                      accessibilityLabel={`Move ${reply.label || "reply"} up`}
                      disabled={flag(index === 0 || saving)}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </s-button>
                    <s-button
                      accessibilityLabel={`Move ${reply.label || "reply"} down`}
                      disabled={flag(index === drafts.length - 1 || saving)}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </s-button>
                    <s-button
                      tone="critical"
                      disabled={flag(saving)}
                      onClick={() =>
                        updateDrafts(drafts.filter((_, i) => i !== index))
                      }
                    >
                      Delete
                    </s-button>
                  </s-stack>
                </s-stack>
                <s-text-area
                  label="Message"
                  autocomplete="off"
                  rows={3}
                  value={reply.message}
                  maxLength={MAX_QUICK_REPLY_MESSAGE}
                  error={fieldErrors[index]?.message}
                  disabled={flag(saving)}
                  onInput={(e) => {
                    const message = e.currentTarget.value;
                    setDrafts((d) =>
                      d.map((r, i) => (i === index ? { ...r, message } : r)),
                    );
                  }}
                />
              </s-stack>
            ))}
          </s-stack>
        )}

        {saved !== null && (
          <s-stack direction="inline" justifyContent="end">
            <s-button
              variant="primary"
              loading={flag(saving)}
              disabled={flag(!dirty || saving)}
              onClick={save}
            >
              Save replies
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
