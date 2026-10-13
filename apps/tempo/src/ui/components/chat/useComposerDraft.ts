import { Schema, Predicate } from "effect";
import { Mention } from "@tempo/protocol";
import { useCallback } from "react";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";
import { draftKey } from "./composer-model";
import type { PendingAttachment } from "./ComposerParts";
import { attachmentPreview, isAttachmentUploading, uploadPreview } from "./attachment-cache";

interface Draft {
  readonly text: string;
  readonly mentions: ReadonlyArray<Mention>;
  readonly reviewCommentIds: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<PendingAttachment>;
}

const EMPTY: Draft = { text: "", mentions: [], reviewCommentIds: [], attachments: [] };

const AttachmentBase = {
  localId: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
  preview: Schema.optional(Schema.String),
};

const SavedAttachment = Schema.Struct({
  ...AttachmentBase,
  status: Schema.Literals(["ready", "failed", "uploading"]),
  attachmentId: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter((attachment) => attachment.status !== "ready" || attachment.attachmentId !== undefined),
);

const SavedDraft = Schema.Union([
  Schema.String,
  Schema.Struct({
    text: Schema.String,
    mentions: Schema.Array(Mention),
    reviewCommentIds: Schema.Array(Schema.String),
    attachments: Schema.Array(SavedAttachment),
  }),
]);

const isSavedDraft = Schema.is(SavedDraft);

const asDraft = (saved: typeof SavedDraft.Type): Draft => {
  if (Schema.is(Schema.String)(saved)) return { ...EMPTY, text: saved };

  return {
    ...saved,
    attachments: saved.attachments.map((a) => ({
      ...a,
      attachmentId: a.attachmentId,
      status: a.status === "uploading" && !isAttachmentUploading(a.localId) ? "failed" : a.status,
      preview: a.attachmentId ? attachmentPreview(a.attachmentId) : uploadPreview(a.localId),
    })),
  };
};

type Next<T> = T | ((value: T) => T);

const nextValue = <T extends Draft[keyof Draft]>(next: Next<T>, current: T): T =>
  Predicate.isFunction(next) ? next(current) : next;

export function useComposerDraft(workspaceId: string, sessionId: string) {
  const [saved, setSaved] = useLocalStorage<typeof SavedDraft.Type>(
    draftKey(workspaceId, sessionId),
    EMPTY,
    isSavedDraft,
  );

  const draft = asDraft(saved);

  const update = useCallback(
    <K extends keyof Draft>(key: K, next: Next<Draft[K]>) =>
      setSaved((current) => {
        const value = asDraft(current);

        return { ...value, [key]: nextValue(next, value[key]) };
      }),
    [setSaved],
  );

  const clearSent = useCallback(
    (sent: Draft) =>
      setSaved((current) => {
        const value = asDraft(current);

        return {
          text: value.text === sent.text ? "" : value.text,
          mentions: value.mentions.filter((m) => !sent.mentions.some((s) => s.path === m.path)),
          reviewCommentIds: value.reviewCommentIds.filter((id) => !sent.reviewCommentIds.includes(id)),
          attachments: value.attachments.filter(
            (a) => !sent.attachments.some((s) => s.localId === a.localId),
          ),
        };
      }),
    [setSaved],
  );

  return { draft, update, clearSent };
}
