import {
  MCP_MAX_SERVERS,
  mcpInputProblem,
  newId,
  TempoError,
  type FnInput,
  type FnOutput,
} from "@tempo/protocol";
import { and, asc, eq } from "drizzle-orm";
import { mcpServers, type McpServerRow } from "../../db/d1.ts";
import { mcpHeaderKey, mcpKeyPrefix, mcpToWire, storedHeaders, type StoredHeader } from "../../lib/mcp.ts";
import type { HandlerCtx } from "../run.ts";
import { d1 } from "./common.ts";

const creds = (c: HandlerCtx) => c.env.CREDENTIALS.getByName(c.user.id);

const storedSecretKeys = async (c: HandlerCtx): Promise<Set<string>> =>
  new Set((await creds(c).status()).map((s) => s.key).filter((k) => k.startsWith("mcp.")));

export const listMcpServers = async (c: HandlerCtx): Promise<FnOutput<"listMcpServers">> => {
  const rows = await d1(c.env)
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.userId, c.user.id))
    .orderBy(asc(mcpServers.name))
    .all();

  const stored = await storedSecretKeys(c);

  return rows.map((r) => mcpToWire(r, stored));
};

export const saveMcpServer = async (
  c: HandlerCtx,
  input: FnInput<"saveMcpServer">,
): Promise<FnOutput<"saveMcpServer">> => {
  const db = d1(c.env);
  const mine = await db.select().from(mcpServers).where(eq(mcpServers.userId, c.user.id)).all();
  let existing: McpServerRow | undefined;

  if (input.id !== undefined) {
    existing = mine.find((r) => r.id === input.id);

    if (!existing) throw new TempoError("NOT_FOUND", undefined, "MCP server not found");
  } else if (mine.length >= MCP_MAX_SERVERS) {
    throw new TempoError("VALIDATION_FAILED", `You can add at most ${MCP_MAX_SERVERS} MCP servers.`);
  }

  if (mine.some((r) => r.name === input.name && r.id !== input.id))
    throw new TempoError("VALIDATION_FAILED", `An MCP server named ${input.name} already exists.`);
  const id = existing?.id ?? newId();
  const allStored = await storedSecretKeys(c);

  const storedHere = new Set(
    [...allStored].flatMap((k) => (k.startsWith(mcpKeyPrefix(id)) ? [k.slice(mcpKeyPrefix(id).length)] : [])),
  );

  const problem = mcpInputProblem(input, storedHere);

  if (problem) throw new TempoError("VALIDATION_FAILED", problem);

  const stdio = input.transport === "stdio";
  const headers = stdio ? [] : (input.headers ?? []);
  const store = creds(c);

  for (const h of headers) {
    if (h.secret && h.value !== undefined && h.value !== "")
      await store.putSecret(mcpHeaderKey(id, h.name), h.value);
  }

  const keep = new Set(headers.filter((h) => h.secret).map((h) => h.name.toLowerCase()));

  for (const name of storedHere) if (!keep.has(name)) await store.deleteSecret(mcpHeaderKey(id, name));

  const now = Date.now();

  const values = {
    name: input.name,
    transport: input.transport,
    enabled: input.enabled ? 1 : 0,
    command: stdio ? (input.command ?? "").trim() : null,
    argsJson: JSON.stringify(stdio ? (input.args ?? []) : []),
    envJson: JSON.stringify(stdio ? (input.env ?? []).map((e) => ({ name: e.name, value: e.value })) : []),
    url: stdio ? null : (input.url ?? null),
    headersJson: JSON.stringify(
      headers.map((h): StoredHeader =>
        h.secret ? { name: h.name, secret: true } : { name: h.name, value: h.value ?? "" },
      ),
    ),
    updatedAt: now,
  };

  const row = existing
    ? await db
        .update(mcpServers)
        .set(values)
        .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, c.user.id)))
        .returning()
        .get()
    : await db
        .insert(mcpServers)
        .values({ ...values, id, userId: c.user.id, createdAt: now })
        .returning()
        .get();

  return mcpToWire(row, await storedSecretKeys(c));
};

export const deleteMcpServer = async (
  c: HandlerCtx,
  { id }: FnInput<"deleteMcpServer">,
): Promise<FnOutput<"deleteMcpServer">> => {
  const db = d1(c.env);

  const row = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, c.user.id)))
    .get();

  const store = creds(c);
  const keys = [...(await storedSecretKeys(c))].filter((k) => k.startsWith(mcpKeyPrefix(id)));

  for (const h of row ? storedHeaders(row) : []) keys.push(mcpHeaderKey(id, h.name));

  for (const key of new Set(keys)) await store.deleteSecret(key);

  if (row) await db.delete(mcpServers).where(eq(mcpServers.id, id)).run();

  return {};
};
