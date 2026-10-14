import { and, asc, eq, isNull } from "drizzle-orm";
import { TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import {
  activeAgent,
  agentToWire,
  agentsChanged,
  attachmentToWire,
  migrateAgents,
  saveDefinition,
  summary,
} from "../../agents/library.ts";
import { agents, projectAgents } from "../../db/d1.ts";
import { newId } from "@tempo/protocol";
import type { HandlerCtx } from "../run.ts";
import { d1, requireProject } from "./common.ts";

export const listAgents = async ({ env, user }: HandlerCtx): Promise<FnOutput<"listAgents">> => {
  await migrateAgents(env, user.id);

  return (
    await d1(env)
      .select()
      .from(agents)
      .where(and(eq(agents.userId, user.id), isNull(agents.deletedAt)))
      .orderBy(asc(agents.name))
      .all()
  ).map((r) => summary(agentToWire(r)));
};

export const getAgent = async (
  { env, user }: HandlerCtx,
  { agentId }: FnInput<"getAgent">,
): Promise<FnOutput<"getAgent">> => agentToWire(await activeAgent(env, user.id, agentId));

export const saveAgent = async (
  { env, user }: HandlerCtx,
  { agentId, definition }: FnInput<"saveAgent">,
): Promise<FnOutput<"saveAgent">> => {
  const saved = await saveDefinition(env, user.id, definition, agentId);
  await agentsChanged(env, user.id);

  return saved;
};

export const deleteAgent = async (
  { env, user }: HandlerCtx,
  { agentId }: FnInput<"deleteAgent">,
): Promise<FnOutput<"deleteAgent">> => {
  await activeAgent(env, user.id, agentId);
  await d1(env)
    .update(agents)
    .set({ deletedAt: Date.now(), updatedAt: Date.now() })
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
    .run();
  await agentsChanged(env, user.id);

  return {};
};

export const listProjectAgents = async (
  { env, user }: HandlerCtx,
  { projectId }: FnInput<"listProjectAgents">,
): Promise<FnOutput<"listProjectAgents">> => {
  const project = await requireProject(env, user, projectId, "read");
  // 11, Shared project configuration: attachments use the project holder's library.
  await migrateAgents(env, project.userId);

  return Promise.all(
    (
      await d1(env)
        .select()
        .from(projectAgents)
        .where(eq(projectAgents.projectId, projectId))
        .orderBy(asc(projectAgents.createdAt))
        .all()
    ).map((row) => attachmentToWire(env, row)),
  );
};

export const putProjectAgent = async (
  { env, user }: HandlerCtx,
  input: FnInput<"putProjectAgent">,
): Promise<FnOutput<"putProjectAgent">> => {
  const project = await requireProject(env, user, input.projectId, "admin");
  await activeAgent(env, project.userId, input.agentId);
  const now = Date.now();

  const fields = {
    enabled: Number(input.enabled),
    hooksJson: JSON.stringify(input.hooks),
    autoSend: Number(input.autoSend),
    maxRuns: input.maxRuns,
    timeout: input.timeout,
    updatedAt: now,
  };

  const row = await d1(env)
    .insert(projectAgents)
    .values({ id: newId(), projectId: input.projectId, agentId: input.agentId, createdAt: now, ...fields })
    .onConflictDoUpdate({ target: [projectAgents.projectId, projectAgents.agentId], set: fields })
    .returning()
    .get();

  await agentsChanged(env, project.userId);

  return attachmentToWire(env, row);
};

export const deleteProjectAgent = async (
  { env, user }: HandlerCtx,
  { projectId, agentId }: FnInput<"deleteProjectAgent">,
): Promise<FnOutput<"deleteProjectAgent">> => {
  const project = await requireProject(env, user, projectId, "admin");

  const removed = await d1(env)
    .delete(projectAgents)
    .where(and(eq(projectAgents.projectId, projectId), eq(projectAgents.agentId, agentId)))
    .returning()
    .get();

  if (!removed) throw new TempoError("NOT_FOUND");
  await agentsChanged(env, project.userId);

  return {};
};
