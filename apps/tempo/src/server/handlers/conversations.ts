import { ConversationArtifact, TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import { and, eq } from "drizzle-orm";
import { workspaces } from "../../db/d1.ts";
import { Schema } from "effect";
import { conversationKey, conversationPrefix } from "../../do/workspace/conversations.ts";
import type { HandlerCtx } from "../run.ts";
import { d1, requireProject } from "./common.ts";

export const listProjectConversations = async (
  { env, user }: HandlerCtx,
  { projectId, cursor }: FnInput<"listProjectConversations">,
): Promise<FnOutput<"listProjectConversations">> => {
  await requireProject(env, user, projectId, "read");

  const existing = await d1(env)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.projectId, projectId), eq(workspaces.userId, user.id)))
    .all();

  for (const w of existing) {
    if (!(await env.DATA.head(conversationKey(projectId, w.id))))
      await env.WORKSPACE.getByName(w.id).persistConversation();
  }

  const prefix = conversationPrefix(projectId);

  const options: R2ListOptions = {
    prefix,
    limit: 100,
    include: ["customMetadata"],
  };

  if (cursor) options.cursor = cursor;
  const result = await env.DATA.list(options);

  return {
    conversations: result.objects.map((o) => ({
      conversationId: o.key.slice(prefix.length, -".json".length),
      projectId,
      title: o.customMetadata?.["title"] ?? "",
      branch: o.customMetadata?.["branch"] ?? "",
      updatedAt: Number(o.customMetadata?.["updatedAt"] ?? o.uploaded.getTime()),
    })),
    cursor: result.truncated ? result.cursor : null,
  };
};

export const getProjectConversation = async (
  { env, user }: HandlerCtx,
  { projectId, conversationId }: FnInput<"getProjectConversation">,
): Promise<FnOutput<"getProjectConversation">> => {
  await requireProject(env, user, projectId, "read");

  if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(conversationId)) throw new TempoError("NOT_FOUND");

  const live = await d1(env)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, conversationId),
        eq(workspaces.projectId, projectId),
        eq(workspaces.userId, user.id),
      ),
    )
    .get();

  if (live) await env.WORKSPACE.getByName(live.id).persistConversation();
  const obj = await env.DATA.get(conversationKey(projectId, conversationId));

  if (!obj) throw new TempoError("NOT_FOUND");
  const artifact = Schema.decodeUnknownSync(ConversationArtifact)(await obj.json());

  if (artifact.projectId !== projectId || artifact.conversationId !== conversationId)
    throw new TempoError("NOT_FOUND");

  return artifact;
};
