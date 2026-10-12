import { waitUntil } from "cloudflare:workers";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import {
  ENVIRONMENT_LIMITS,
  TempoError,
  duplicateNames,
  newId,
  type FnInput,
  type FnOutput,
  type Injector,
} from "@tempo/protocol";
import { environments, projects, workspaces, type EnvironmentRow } from "../../db/d1.ts";
import {
  environmentSecretKey,
  environmentToWire,
  parseEnvironment,
  sha256Hex,
} from "../../lib/environments.ts";
import type { HandlerCtx } from "../run.ts";
import { d1, projectToWire, requireProject } from "./common.ts";

const creds = (c: HandlerCtx) => c.env.CREDENTIALS.getByName(c.user.id);

export const requireEnvironment = async (c: HandlerCtx, environmentId: string): Promise<EnvironmentRow> => {
  const row = await d1(c.env)
    .select()
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.userId, c.user.id)))
    .get();
  if (!row) throw new TempoError("NOT_FOUND", undefined, "environment not found");
  return row;
};

const toWire = async (c: HandlerCtx, row: EnvironmentRow) =>
  environmentToWire(row, await creds(c).listEnvironmentSecretNames(row.id));

const assertNameFree = async (c: HandlerCtx, name: string, exceptId?: string) => {
  const clash = await d1(c.env)
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.userId, c.user.id),
        eq(environments.name, name),
        exceptId ? ne(environments.id, exceptId) : undefined,
      ),
    )
    .get();
  if (clash) throw new TempoError("ENVIRONMENT_EXISTS");
};

/** Sends env.set and environment.set to every live workspace of the owner (01, After a change). */
export const refreshAllWorkspaces = async (c: HandlerCtx): Promise<void> => {
  const ids = await d1(c.env)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.userId, c.user.id), isNull(workspaces.archivedAt)))
    .all();
  waitUntil(
    Promise.all(
      ids.map((w) =>
        c.env.WORKSPACE.getByName(w.id)
          .refreshEnv()
          .catch(() => undefined),
      ),
    ),
  );
};

export const listEnvironments = async (c: HandlerCtx): Promise<FnOutput<"listEnvironments">> => {
  const rows = await d1(c.env)
    .select()
    .from(environments)
    .where(eq(environments.userId, c.user.id))
    .orderBy(asc(environments.name))
    .all();
  return Promise.all(rows.map((r) => toWire(c, r)));
};

export const createEnvironment = async (
  c: HandlerCtx,
  { name }: FnInput<"createEnvironment">,
): Promise<FnOutput<"createEnvironment">> => {
  await assertNameFree(c, name);
  const now = Date.now();
  const row: EnvironmentRow = {
    id: newId(),
    userId: c.user.id,
    name,
    egressPolicy: "allowlist",
    egressAllowlistJson: "[]",
    secretsJson: "[]",
    injectorsJson: "[]",
    createdAt: now,
    updatedAt: now,
  };
  await d1(c.env).insert(environments).values(row).run();
  return environmentToWire(row, []);
};

const invalid = (detail: string) => new TempoError("VALIDATION_FAILED", undefined, detail);

export const updateEnvironment = async (
  c: HandlerCtx,
  input: FnInput<"updateEnvironment">,
): Promise<FnOutput<"updateEnvironment">> => {
  const row = await requireEnvironment(c, input.environmentId);
  const current = parseEnvironment(row);
  if (input.name !== undefined) await assertNameFree(c, input.name, row.id);
  if (input.secrets) {
    const dup = duplicateNames(input.secrets);
    if (dup.length) throw invalid(`duplicate secret names: ${dup.join(", ")}`);
  }
  let injectors: Injector[] | undefined;
  if (input.injectors) {
    const dup = duplicateNames(input.injectors);
    if (dup.length) throw invalid(`duplicate injector names: ${dup.join(", ")}`);
    injectors = await Promise.all(
      input.injectors.map(async (i) => ({
        name: i.name,
        hosts: [...i.hosts],
        code: i.code,
        sha256: await sha256Hex(i.code),
      })),
    );
  }
  const now = Date.now();
  const next: EnvironmentRow = {
    ...row,
    name: input.name ?? row.name,
    egressPolicy: input.egressPolicy ?? row.egressPolicy,
    egressAllowlistJson: input.egressAllowlist
      ? JSON.stringify(input.egressAllowlist)
      : row.egressAllowlistJson,
    secretsJson: input.secrets ? JSON.stringify(input.secrets) : row.secretsJson,
    injectorsJson: injectors ? JSON.stringify(injectors) : row.injectorsJson,
    updatedAt: now,
  };
  await d1(c.env)
    .update(environments)
    .set({
      name: next.name,
      egressPolicy: next.egressPolicy,
      egressAllowlistJson: next.egressAllowlistJson,
      secretsJson: next.secretsJson,
      injectorsJson: next.injectorsJson,
      updatedAt: now,
    })
    .where(eq(environments.id, row.id))
    .run();
  if (input.secrets) {
    const kept = new Set(input.secrets.map((s) => s.name));
    for (const s of current.secrets)
      if (!kept.has(s.name)) await creds(c).deleteSecret(environmentSecretKey(row.id, s.name));
  }
  await refreshAllWorkspaces(c);
  return toWire(c, next);
};

export const deleteEnvironment = async (
  c: HandlerCtx,
  { environmentId }: FnInput<"deleteEnvironment">,
): Promise<FnOutput<"deleteEnvironment">> => {
  const row = await requireEnvironment(c, environmentId);
  const db = d1(c.env);
  await db
    .update(projects)
    .set({ environmentId: null, updatedAt: Date.now() })
    .where(and(eq(projects.userId, c.user.id), eq(projects.environmentId, row.id)))
    .run();
  await db.delete(environments).where(eq(environments.id, row.id)).run();
  await creds(c).deleteEnvironmentSecrets(row.id);
  await refreshAllWorkspaces(c);
  return {};
};

export const setEnvironmentSecret = async (
  c: HandlerCtx,
  { environmentId, name, value }: FnInput<"setEnvironmentSecret">,
): Promise<FnOutput<"setEnvironmentSecret">> => {
  const row = await requireEnvironment(c, environmentId);
  const current = parseEnvironment(row);
  if (!current.secrets.some((s) => s.name === name)) {
    if (current.secrets.length >= ENVIRONMENT_LIMITS.secretsMax) throw invalid("too many secrets");
    await d1(c.env)
      .update(environments)
      .set({ secretsJson: JSON.stringify([...current.secrets, { name, hosts: [] }]), updatedAt: Date.now() })
      .where(eq(environments.id, row.id))
      .run();
  }
  await creds(c).putSecret(environmentSecretKey(row.id, name), value);
  await refreshAllWorkspaces(c);
  return {};
};

export const deleteEnvironmentSecret = async (
  c: HandlerCtx,
  { environmentId, name }: FnInput<"deleteEnvironmentSecret">,
): Promise<FnOutput<"deleteEnvironmentSecret">> => {
  const row = await requireEnvironment(c, environmentId);
  const current = parseEnvironment(row);
  await d1(c.env)
    .update(environments)
    .set({
      secretsJson: JSON.stringify(current.secrets.filter((s) => s.name !== name)),
      updatedAt: Date.now(),
    })
    .where(eq(environments.id, row.id))
    .run();
  await creds(c).deleteSecret(environmentSecretKey(row.id, name));
  await refreshAllWorkspaces(c);
  return {};
};

export const setProjectEnvironment = async (
  c: HandlerCtx,
  { projectId, environmentId }: FnInput<"setProjectEnvironment">,
): Promise<FnOutput<"setProjectEnvironment">> => {
  const row = await requireProject(c.env, c.user.id, projectId);
  if (environmentId !== null) await requireEnvironment(c, environmentId);
  const now = Date.now();
  await d1(c.env)
    .update(projects)
    .set({ environmentId, updatedAt: now })
    .where(eq(projects.id, projectId))
    .run();
  await refreshAllWorkspaces(c);
  return projectToWire({ ...row, environmentId, updatedAt: now });
};
