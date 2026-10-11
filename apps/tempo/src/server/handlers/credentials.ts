import { waitUntil } from "cloudflare:workers";
import { TempoError, type FnInput, type FnOutput } from "@tempo/protocol";
import { and, eq, isNull } from "drizzle-orm";
import { workspaces } from "../../db/d1.ts";
import { SECRET_KEYS, projectEnvKey } from "../../do/credential.ts";
import type { HandlerCtx } from "../run.ts";
import { d1, requireProject } from "./common.ts";

const creds = (c: HandlerCtx) => c.env.CREDENTIALS.getByName(c.user.id);

export const getCredentialStatus = async (c: HandlerCtx): Promise<FnOutput<"getCredentialStatus">> => {
  const rows = await creds(c).status();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const state = (key: string) => {
    const r = byKey.get(key);
    return { set: r !== undefined, updatedAt: r?.updatedAt ?? null };
  };
  const codex = byKey.get(SECRET_KEYS.codex);
  return {
    claude: state(SECRET_KEYS.claude),
    codex: { ...state(SECRET_KEYS.codex), lastRefresh: codex?.meta.lastRefresh ?? null },
    openrouter: state(SECRET_KEYS.openrouter),
    anthropic: state(SECRET_KEYS.anthropic),
    openai: state(SECRET_KEYS.openai),
  };
};

export const setClaudeToken = async (c: HandlerCtx, { token }: FnInput<"setClaudeToken">): Promise<FnOutput<"setClaudeToken">> => {
  await creds(c).putSecret(SECRET_KEYS.claude, token.trim());
  return {};
};

/** Codex auth.json must parse and hold tokens.access_token, tokens.refresh_token and last_refresh (02). */
export const parseCodexAuth = (authJson: string): { lastRefresh: number } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    throw new TempoError("VALIDATION_FAILED", undefined, "auth.json is not JSON");
  }
  const o = parsed as { tokens?: { access_token?: unknown; refresh_token?: unknown }; last_refresh?: unknown };
  if (typeof o?.tokens?.access_token !== "string" || typeof o.tokens.refresh_token !== "string" || typeof o.last_refresh !== "string") {
    throw new TempoError("VALIDATION_FAILED", undefined, "auth.json needs tokens.access_token, tokens.refresh_token and last_refresh");
  }
  const lastRefresh = Date.parse(o.last_refresh);
  if (Number.isNaN(lastRefresh)) throw new TempoError("VALIDATION_FAILED", undefined, "last_refresh is not a date");
  return { lastRefresh };
};

export const setCodexAuth = async (c: HandlerCtx, { authJson }: FnInput<"setCodexAuth">): Promise<FnOutput<"setCodexAuth">> => {
  const { lastRefresh } = parseCodexAuth(authJson);
  await creds(c).replaceCodexAuth(authJson, lastRefresh);
  return {};
};

export const setApiKey = async (c: HandlerCtx, { provider, key }: FnInput<"setApiKey">): Promise<FnOutput<"setApiKey">> => {
  if (/\s/.test(key.trim())) throw new TempoError("VALIDATION_FAILED", undefined, "keys have no spaces");
  await creds(c).putSecret(SECRET_KEYS[provider], key.trim());
  return {};
};

const DELETABLE = new Set<string>(Object.values(SECRET_KEYS));

export const deleteCredential = async (c: HandlerCtx, { key }: FnInput<"deleteCredential">): Promise<FnOutput<"deleteCredential">> => {
  const full = key in SECRET_KEYS ? SECRET_KEYS[key as keyof typeof SECRET_KEYS] : key;
  if (!DELETABLE.has(full)) throw new TempoError("VALIDATION_FAILED", undefined, "unknown credential");
  await creds(c).deleteSecret(full);
  return {};
};

const refreshProjectEnv = async (c: HandlerCtx, projectId: string) => {
  const ids = await d1(c.env)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.projectId, projectId), isNull(workspaces.archivedAt)))
    .all();
  const work = Promise.all(ids.map((w) => c.env.WORKSPACE.getByName(w.id).refreshEnv().catch(() => undefined)));
  waitUntil(work);
};

export const setProjectSecret = async (c: HandlerCtx, { projectId, name, value }: FnInput<"setProjectSecret">): Promise<FnOutput<"setProjectSecret">> => {
  await requireProject(c.env, c.user.id, projectId);
  await creds(c).putSecret(projectEnvKey(projectId, name), value);
  await refreshProjectEnv(c, projectId);
  return {};
};

export const deleteProjectSecret = async (c: HandlerCtx, { projectId, name }: FnInput<"deleteProjectSecret">): Promise<FnOutput<"deleteProjectSecret">> => {
  await requireProject(c.env, c.user.id, projectId);
  await creds(c).deleteSecret(projectEnvKey(projectId, name));
  await refreshProjectEnv(c, projectId);
  return {};
};

export const listProjectSecretNames = async (c: HandlerCtx, { projectId }: FnInput<"listProjectSecretNames">): Promise<FnOutput<"listProjectSecretNames">> => {
  await requireProject(c.env, c.user.id, projectId);
  return { names: await creds(c).listProjectEnvNames(projectId) };
};
