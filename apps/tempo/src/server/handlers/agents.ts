import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import {
  CUSTOM_AGENT_LIMIT,
  TempoError,
  customAgentPath,
  customAgentRepo,
  newId,
  type AgentId,
  type CustomAgent,
  type CustomAgentDefinition,
  type FnInput,
  type FnOutput,
} from "@tempo/protocol";
import { parseAgentFile, stringifyAgentFile } from "@tempo/settings";
import { agentStore } from "../../agents/store.ts";
import { customAgents, type CustomAgentRow } from "../../db/d1.ts";
import type { Env } from "../../env.ts";
import type { HandlerCtx } from "../run.ts";
import { d1 } from "./common.ts";

/** Custom agents (01, Custom agents; 02, Server functions). */

const activeRow = async (env: Env, userId: string, id: string): Promise<CustomAgentRow> => {
  const row = await d1(env)
    .select()
    .from(customAgents)
    .where(and(eq(customAgents.id, id), eq(customAgents.userId, userId), isNull(customAgents.deletedAt)))
    .get();
  if (!row) throw new TempoError("NOT_FOUND", undefined, "custom agent not found");
  return row;
};

const readDefinition = async (env: Env, row: CustomAgentRow): Promise<CustomAgentDefinition> => {
  const text = await agentStore.forEnv(env).read(row.repo, row.commitSha, row.path);
  if (text === null) throw new TempoError("ARTIFACTS_ERROR", undefined, "agent file missing at its commit");
  return parseAgentFile(text);
};

const toWire = (row: CustomAgentRow, def: CustomAgentDefinition): CustomAgent => ({
  ...def,
  id: row.id,
  commitSha: row.commitSha,
  updatedAt: row.updatedAt,
});

const isNameTaken = (e: unknown): boolean =>
  /UNIQUE constraint failed: custom_agents\.(user_id|name)/.test(String(e));

/** The custom agent a session starts from, read at its current commit. */
export const resolveCustomAgent = async (
  env: Env,
  userId: string,
  customAgentId: string,
  agent?: AgentId,
): Promise<{
  customAgent: { id: string; name: string; commitSha: string };
  definition: CustomAgentDefinition;
}> => {
  const row = await activeRow(env, userId, customAgentId);
  if (agent !== undefined && agent !== row.baseAgent) {
    throw new TempoError("VALIDATION_FAILED", undefined, "agent must equal the custom agent's base agent");
  }
  return {
    customAgent: { id: row.id, name: row.name, commitSha: row.commitSha },
    definition: await readDefinition(env, row),
  };
};

export const listCustomAgents = async ({ env, user }: HandlerCtx): Promise<FnOutput<"listCustomAgents">> => {
  const rows = await d1(env)
    .select()
    .from(customAgents)
    .where(and(eq(customAgents.userId, user.id), isNull(customAgents.deletedAt)))
    .orderBy(asc(customAgents.name))
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    baseAgent: r.baseAgent as AgentId,
    updatedAt: r.updatedAt,
  }));
};

export const getCustomAgent = async (
  { env, user }: HandlerCtx,
  { customAgentId }: FnInput<"getCustomAgent">,
): Promise<FnOutput<"getCustomAgent">> => {
  const row = await activeRow(env, user.id, customAgentId);
  return toWire(row, await readDefinition(env, row));
};

export const saveCustomAgent = async (
  { env, user }: HandlerCtx,
  { customAgentId, definition }: FnInput<"saveCustomAgent">,
): Promise<FnOutput<"saveCustomAgent">> => {
  const db = d1(env);
  const existing = customAgentId ? await activeRow(env, user.id, customAgentId) : null;
  const id = existing?.id ?? newId();
  const clash = await db
    .select({ id: customAgents.id })
    .from(customAgents)
    .where(
      and(
        eq(customAgents.userId, user.id),
        eq(customAgents.name, definition.name),
        isNull(customAgents.deletedAt),
        ne(customAgents.id, id),
      ),
    )
    .get();
  if (clash) throw new TempoError("CUSTOM_AGENT_EXISTS");
  if (!existing) {
    const n = await db
      .select({ n: count() })
      .from(customAgents)
      .where(and(eq(customAgents.userId, user.id), isNull(customAgents.deletedAt)))
      .get();
    if ((n?.n ?? 0) >= CUSTOM_AGENT_LIMIT) throw new TempoError("CUSTOM_AGENT_LIMIT");
  }

  const repo = customAgentRepo(user.id);
  const path = customAgentPath(id);
  // The row changes only after the push succeeds, so commit_sha always names a real commit (02).
  const commitSha = await agentStore
    .forEnv(env)
    .write(repo, path, stringifyAgentFile(definition), `Save agent ${id}`);
  const now = Date.now();
  const fields = {
    name: definition.name,
    description: definition.description,
    baseAgent: definition.baseAgent,
    commitSha,
    updatedAt: now,
  };
  try {
    if (existing) {
      await db.update(customAgents).set(fields).where(eq(customAgents.id, id)).run();
    } else {
      await db
        .insert(customAgents)
        .values({ id, userId: user.id, repo, path, createdAt: now, deletedAt: null, ...fields })
        .run();
    }
  } catch (e) {
    if (isNameTaken(e)) throw new TempoError("CUSTOM_AGENT_EXISTS");
    throw e;
  }
  return { ...definition, id, commitSha, updatedAt: now };
};

export const deleteCustomAgent = async (
  { env, user }: HandlerCtx,
  { customAgentId }: FnInput<"deleteCustomAgent">,
): Promise<FnOutput<"deleteCustomAgent">> => {
  const row = await activeRow(env, user.id, customAgentId);
  await agentStore.forEnv(env).write(row.repo, row.path, null, `Delete agent ${row.id}`);
  const now = Date.now();
  await d1(env)
    .update(customAgents)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(customAgents.id, row.id))
    .run();
  return {};
};
