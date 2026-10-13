import { asc } from "drizzle-orm";
import { ConversationArtifact, redact } from "@tempo/protocol";
import { Schema } from "effect";
import { items, sessions, turns } from "../../db/workspace-do.ts";
import type { WorkspaceCore } from "./core.ts";

export const CONVERSATION_INTERVAL_MS = 60_000;
export const conversationPrefix = (projectId: string) => `artifacts/projects/${projectId}/conversations/`;
export const conversationKey = (projectId: string, conversationId: string) =>
  `${conversationPrefix(projectId)}${conversationId}.json`;

export const markConversationDirty = (core: WorkspaceCore): void => {
  if (!core.wsOrNull()) return;
  core.setKv("conversationRevision", (core.kv<number>("conversationRevision") ?? 0) + 1);
  if (core.kv<number>("conversationDueAt") === undefined)
    core.setKv("conversationDueAt", Date.now() + CONVERSATION_INTERVAL_MS);
  core.scheduleAlarm();
};

/** Serialize uploads so an older snapshot cannot overwrite a newer one. */
export const saveConversation = async (core: WorkspaceCore, force = false): Promise<void> => {
  while (core.conversationUpload) {
    await core.conversationUpload;
    if (!force) return;
  }
  if (!core.wsOrNull() || (!force && core.kv<number>("conversationDueAt") === undefined)) return;
  const revision = core.kv<number>("conversationRevision") ?? 0;
  const row = core.ws();
  const artifact = Schema.decodeUnknownSync(ConversationArtifact)({
    version: 1,
    conversationId: row.workspaceId,
    projectId: row.projectId,
    title: row.title,
    branch: row.branch,
    updatedAt: Date.now(),
    sessions: core.db
      .select()
      .from(sessions)
      .orderBy(asc(sessions.sortOrder), asc(sessions.id))
      .all()
      .map((s) => ({
        id: s.id,
        agent: s.agent,
        title: s.title,
        status: s.status,
        createdAt: s.createdAt,
        closedAt: s.closedAt,
      })),
    turns: core.db
      .select()
      .from(turns)
      .orderBy(asc(turns.seq))
      .all()
      .map((t) => core.turnToWire(t)),
    items: core.db
      .select()
      .from(items)
      .orderBy(asc(items.createdAt), asc(items.id))
      .all()
      .map((r) => {
        const item = core.itemToWire(r);
        return item.kind === "tool_call" ? { ...item, content: redact(item.content) } : item;
      }),
  });
  const upload = core.env.DATA.put(
    conversationKey(row.projectId, row.workspaceId),
    JSON.stringify(artifact),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { title: row.title, branch: row.branch, updatedAt: String(artifact.updatedAt) },
    },
  ).then(() => {
    core.setKv("conversationSavedRevision", revision);
    if ((core.kv<number>("conversationRevision") ?? 0) === revision)
      core.setKv("conversationDueAt", undefined);
  });
  core.conversationUpload = upload;
  try {
    await upload;
  } finally {
    core.conversationUpload = null;
  }
};
