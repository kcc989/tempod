import type { Mention } from "@tempo/protocol";
import { useMemo } from "react";
import { Store, useStore } from "~/ui/lib/store";
import type { PendingAttachment } from "./ComposerParts";

interface DraftChips {
  readonly sending: boolean;
  readonly mentions: ReadonlyArray<Mention>;
  readonly reviewCommentIds: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<PendingAttachment>;
}

const drafts = new Map<string, Store<DraftChips>>();

/** Keep unsent chips across tab switches, without persisting attachments in browser storage. */
export function useDraftChips(workspaceId: string, sessionId: string) {
  const store = useMemo(() => {
    const key = `${workspaceId}\u0000${sessionId}`;
    let value = drafts.get(key);
    if (!value) {
      value = new Store<DraftChips>({ sending: false, mentions: [], reviewCommentIds: [], attachments: [] });
      drafts.set(key, value);
    }
    return value;
  }, [workspaceId, sessionId]);
  const value = useStore(store);
  const setField = <K extends keyof DraftChips>(
    key: K,
    next: DraftChips[K] | ((prev: DraftChips[K]) => DraftChips[K]),
  ) => {
    store.set((prev) => ({ ...prev, [key]: typeof next === "function" ? next(prev[key]) : next }));
  };
  return {
    ...value,
    beginSend: () => {
      if (store.getSnapshot().sending) return false;
      store.update({ sending: true });
      return true;
    },
    finishSend: () => store.update({ sending: false }),
    setMentions: (
      next: DraftChips["mentions"] | ((prev: DraftChips["mentions"]) => DraftChips["mentions"]),
    ) => setField("mentions", next),
    setReviewCommentIds: (
      next:
        | DraftChips["reviewCommentIds"]
        | ((prev: DraftChips["reviewCommentIds"]) => DraftChips["reviewCommentIds"]),
    ) => setField("reviewCommentIds", next),
    setAttachments: (
      next: DraftChips["attachments"] | ((prev: DraftChips["attachments"]) => DraftChips["attachments"]),
    ) => setField("attachments", next),
  };
}
