import type { Mention } from "@tempo/protocol";
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");
const isSavedDraft = (value: unknown): value is Draft | string =>
  typeof value === "string" ||
  (isRecord(value) &&
    typeof value["text"] === "string" &&
    Array.isArray(value["mentions"]) &&
    value["mentions"].every((m) => isRecord(m) && typeof m["path"] === "string") &&
    strings(value["reviewCommentIds"]) &&
    Array.isArray(value["attachments"]) &&
    value["attachments"].every(
      (a) =>
        isRecord(a) &&
        typeof a["localId"] === "string" &&
        typeof a["name"] === "string" &&
        typeof a["mime"] === "string" &&
        typeof a["size"] === "number" &&
        ["ready", "failed", "uploading"].includes(String(a["status"])) &&
        (a["status"] !== "ready" || typeof a["attachmentId"] === "string"),
    ));

const asDraft = (saved: Draft | string): Draft => {
  if (typeof saved === "string") return { ...EMPTY, text: saved };
  return {
    ...saved,
    attachments: saved.attachments.map((a) => ({
      ...a,
      status: a.status === "uploading" && !isAttachmentUploading(a.localId) ? "failed" : a.status,
      preview: a.attachmentId ? attachmentPreview(a.attachmentId) : uploadPreview(a.localId),
    })),
  };
};

type Next<T> = T | ((value: T) => T);
const nextValue = <T>(next: Next<T>, current: T): T =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

export function useComposerDraft(workspaceId: string, sessionId: string) {
  const [saved, setSaved] = useLocalStorage<Draft | string>(
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
