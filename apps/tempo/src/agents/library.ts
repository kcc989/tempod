import { Schema } from "effect";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  AGENT_LIMIT,
  AgentDefinition,
  AgentSummary,
  AttachmentHooks,
  TempoError,
  newId,
  unwrap,
  type Agent,
  type AgentAttachment,
  type AgentProfile,
} from "@tempo/protocol";
import { STARTERS } from "@tempo/agents-starter";
import { parseRoleFile } from "@tempo/settings/migrations/roles";
import {
  agentMigrations,
  agents,
  userRoles,
  workspaces,
  type AgentRow,
  type ProjectAgentRow,
} from "../db/d1.ts";
import { d1 } from "../server/handlers/common.ts";
import { log } from "../log.ts";
import type { Env } from "../env.ts";

const canonical = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonical);

  if (Schema.is(Schema.JsonObject)(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k]!)]),
    );

  return value;
};

export const definitionText = (definition: AgentDefinition): string => {
  const text = JSON.stringify(canonical(Schema.decodeUnknownSync(Schema.Json)(definition)));

  if (new TextEncoder().encode(text).length > 65536) throw new TempoError("AGENT_INVALID");

  return text;
};

export const definitionSha = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const agentToWire = (row: AgentRow): Agent => ({
  ...Schema.decodeUnknownSync(AgentDefinition, { onExcessProperty: "error" })(JSON.parse(row.definitionJson)),
  id: row.id,
  version: row.version,
  sha: row.sha,
  starter: row.starter,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const summary = (agent: Agent): AgentSummary => Schema.decodeUnknownSync(AgentSummary)(agent);

export const toLibraryProfile = (definition: AgentDefinition): AgentProfile => ({
  systemPrompt: definition.prompt,
  toolsAllow: definition.tools.allow,
  toolsDeny: definition.tools.deny,
  playwright: definition.mcp.playwright,
  mcpServers: definition.mcp.servers,
  thoughtLevel: definition.thoughtLevel,
});

export const migrationHandle = (name: string, used: Set<string>): string => {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32);

  if (!/^[a-z][a-z0-9-]{1,31}$/.test(base)) base = ("agent-" + base).slice(0, 32);

  if (!/^[a-z][a-z0-9-]{1,31}$/.test(base)) base = "agent";
  let handle = base;

  for (let n = 2; used.has(handle); n++) handle = base.slice(0, 32 - String(n).length - 1) + "-" + n;
  used.add(handle);

  return handle;
};

const migrationName = (name: string, used: Set<string>): string => {
  const base = name.slice(0, 60) || "Agent";
  let result = base;

  for (let n = 2; used.has(result); n++) result = base.slice(0, 60 - String(n).length - 3) + " (" + n + ")";
  used.add(result);

  return result;
};

const migrationPrompt = (definition: AgentDefinition, original: string, name: string): AgentDefinition => {
  let prompt = original.slice(0, 32000);

  const bytes = (value: string) =>
    new TextEncoder().encode(JSON.stringify(canonical({ ...definition, prompt: value }))).length;

  if (bytes(prompt) > 65536) {
    let low = 0;
    let high = prompt.length;

    while (low < high) {
      const middle = Math.ceil((low + high) / 2);

      if (bytes(prompt.slice(0, middle)) <= 65536) low = middle;
      else high = middle - 1;
    }

    prompt = prompt.slice(0, low);
  }

  if (prompt.length < original.length) log("warn", "Agent migration truncated a copied prompt", { name });

  return { ...definition, prompt };
};

const migrations = new Map<string, Promise<void>>();

export const migrateAgents = async (env: Env, userId: string): Promise<void> => {
  const pending = migrations.get(userId);

  if (pending) return pending;

  const work = (async () => {
    const db = d1(env);

    const [markers, existing] = await db.batch([
      db.select().from(agentMigrations).where(eq(agentMigrations.userId, userId)),
      db
        .select()
        .from(agents)
        .where(and(eq(agents.userId, userId), isNull(agents.deletedAt))),
    ]);

    if (markers.length) return;
    const handles = new Set(existing.map((a) => a.handle));
    const names = new Set(existing.map((a) => a.name));
    const rows: Array<typeof agents.$inferInsert> = [];

    const add = async (
      definition: AgentDefinition,
      id: string,
      original = definition.prompt,
      starter: string | null = null,
    ) => {
      const text = definitionText(migrationPrompt(definition, original, definition.name));
      const now = Date.now();
      rows.push({
        id,
        userId,
        handle: definition.handle,
        name: definition.name,
        definitionJson: text,
        version: 1,
        sha: await definitionSha(text),
        starter,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    };

    const oldRoles = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, userId))
      .orderBy(asc(userRoles.name))
      .all();

    for (const row of oldRoles) {
      let parsed: ReturnType<typeof parseRoleFile>;

      try {
        parsed = parseRoleFile(row.name, row.text);
      } catch {
        log("warn", "Agent migration skipped an invalid definition", { name: row.name });
        continue;
      }

      const { file, body } = parsed;
      await add(
        Schema.decodeUnknownSync(AgentDefinition, { onExcessProperty: "error" })({
          handle: migrationHandle(row.name, handles),
          name: migrationName(row.name, names),
          description: file.description,
          baseAgent: file.agent === "other" ? "auto" : file.agent,
          model: file.model === "default" ? "" : file.model,
          access: file.access,
          prompt: body.slice(0, 32000),
          outputKind: ["reviewer", "ci"].includes(row.name) ? "review" : "note",
        }),
        newId(),
        body,
      );
    }

    for (const starter of STARTERS) {
      if (handles.has(starter.handle)) continue;
      handles.add(starter.handle);
      await add(
        { ...starter, name: migrationName(starter.name, names) },
        newId(),
        starter.prompt,
        starter.handle,
      );
    }

    // The sentinel and all imports commit together. Conditional inserts also protect cross-isolate races.
    const writes = rows.map((row) =>
      env.DB.prepare(
        "INSERT INTO agents (id,user_id,handle,name,definition_json,version,sha,starter,created_at,updated_at,deleted_at) SELECT ?,?,?,?,?,1,?,?,?,?,NULL WHERE NOT EXISTS (SELECT 1 FROM agent_migrations WHERE user_id = ?) ON CONFLICT DO NOTHING",
      ).bind(
        row.id,
        userId,
        row.handle,
        row.name,
        row.definitionJson,
        row.sha,
        row.starter ?? null,
        row.createdAt,
        row.updatedAt,
        userId,
      ),
    );

    await env.DB.batch([
      ...writes,
      env.DB.prepare(
        "INSERT INTO agent_migrations (user_id,migrated_at) VALUES (?,?) ON CONFLICT DO NOTHING",
      ).bind(userId, Date.now()),
    ]);
  })();

  migrations.set(userId, work);

  try {
    await work;
  } catch (error) {
    if (Schema.isSchemaError(error))
      throw new TempoError(
        "AGENT_INVALID",
        undefined,
        "An existing definition needs repair before migration.",
      );
    throw error;
  } finally {
    if (migrations.get(userId) === work) migrations.delete(userId);
  }
};

export const activeAgent = async (env: Env, userId: string, id: string): Promise<AgentRow> => {
  const row = await d1(env)
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.id, id), isNull(agents.deletedAt)))
    .get();

  if (!row) throw new TempoError("NOT_FOUND");

  return row;
};

export const saveDefinition = async (
  env: Env,
  userId: string,
  definition: AgentDefinition,
  id?: string,
): Promise<Agent> => {
  await migrateAgents(env, userId);
  const db = d1(env);

  if (id) await activeAgent(env, userId, id);
  const text = definitionText(definition);
  const sha = await definitionSha(text);
  const now = Date.now();
  const agentId = id ?? newId();

  try {
    if (id) {
      const updated = await db
        .update(agents)
        .set({
          handle: definition.handle,
          name: definition.name,
          definitionJson: text,
          sha,
          version: sql`${agents.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(agents.id, id), eq(agents.userId, userId), isNull(agents.deletedAt)))
        .returning()
        .get();

      if (!updated) throw new TempoError("NOT_FOUND");

      return agentToWire(updated);
    }

    await env.DB.prepare(
      "INSERT INTO agents (id,user_id,handle,name,definition_json,version,sha,created_at,updated_at) SELECT ?,?,?,?,?,1,?,?,? WHERE (SELECT count(*) FROM agents WHERE user_id = ? AND deleted_at IS NULL) < ?",
    )
      .bind(agentId, userId, definition.handle, definition.name, text, sha, now, now, userId, AGENT_LIMIT)
      .run();
    const row = await db.select().from(agents).where(eq(agents.id, agentId)).get();

    if (!row) throw new TempoError("AGENT_LIMIT");

    return agentToWire(row);
  } catch (error) {
    if (
      /UNIQUE constraint failed: agents\.(user_id|handle|name)/.test(
        String(error instanceof Error && error.cause !== undefined ? error.cause : error),
      )
    )
      throw new TempoError("AGENT_NAME_TAKEN");
    throw error;
  }
};

export const attachmentToWire = async (
  env: Env,
  row: ProjectAgentRow,
  known?: AgentRow | null,
): Promise<AgentAttachment> => {
  const agent =
    known === undefined
      ? await d1(env)
          .select()
          .from(agents)
          .where(and(eq(agents.id, row.agentId), isNull(agents.deletedAt)))
          .get()
      : known;

  const { hooksJson, ...fields } = row;

  return {
    ...fields,
    enabled: !!row.enabled,
    autoSend: !!row.autoSend,
    hooks: Schema.decodeUnknownSync(AttachmentHooks)(JSON.parse(hooksJson)),
    agent: agent ? summary(agentToWire(agent)) : null,
  };
};

export const agentsChanged = async (env: Env, userId: string): Promise<void> => {
  const live = await d1(env)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(eq(workspaces.userId, userId), isNull(workspaces.archivedAt), ne(workspaces.state, "archived")),
    )
    .all();

  await Promise.all(live.map(async (r) => unwrap(await env.WORKSPACE.getByName(r.id).agentsChanged())));
};
