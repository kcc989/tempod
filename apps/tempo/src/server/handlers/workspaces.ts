import { and, desc, eq, isNull } from "drizzle-orm";
import { pickSlug } from "@tempo/cities";
import {
  TempoError,
  newId,
  toAgentProfile,
  unwrap,
  type AgentId,
  type FnInput,
  type FnOutput,
  type Source,
  type WorkspaceFnName,
} from "@tempo/protocol";
import { resolveSettings } from "@tempo/settings";
import { workspaces } from "../../db/d1.ts";
import { getUserById } from "../../github/api.ts";
import { github, prStateOf } from "../../github/provider.ts";
import { getOwnedWorkspace } from "../../http/common.ts";
import { summaryFromD1Row } from "../../lib/summary.ts";
import { workspaceStub } from "../../do/workspace/stub.ts";
import type { InitInput } from "../../do/workspace/index.ts";
import { isValidBranch, type SessionAgentProfile } from "../../do/workspace/rpc.ts";
import { resolveCustomAgent } from "./agents.ts";
import type { Handler, HandlerCtx } from "../run.ts";
import { d1, projectToWire, projectToken, repoOf, requireProject } from "./common.ts";

const authorCache = new Map<string, { name: string; email: string }>();

/** Commit author (03, repo.clone): GitHub name, else login; `<id>+<login>@users.noreply.github.com`. */
const authorFor = async (env: HandlerCtx["env"], token: string, fallbackName: string) => {
  const id = env.TEMPO_OWNER_GITHUB_ID;
  const hit = authorCache.get(id);

  if (hit) return hit;

  try {
    const u = await getUserById(token, id);
    const author = { name: u.name || u.login, email: `${id}+${u.login}@users.noreply.github.com` };
    authorCache.set(id, author);

    return author;
  } catch {
    return { name: fallbackName || "Tempo", email: `${id}@users.noreply.github.com` };
  }
};

/** Drizzle wraps D1 errors ("Failed query: ..."); the constraint text is on `cause`. */
const isUniqueViolation = (cause: unknown, column: "branch" | "slug") => {
  const text = String(cause instanceof Error && cause.cause !== undefined ? cause.cause : cause);

  return text.includes("UNIQUE") && text.includes(`workspaces.${column}`);
};

/** 03, Create a workspace: checks and the D1 insert here; everything after in WorkspaceDO.init. */
export const createWorkspace = async (
  { env, user }: HandlerCtx,
  { projectId, source, agent, model, customAgentId, prompt }: FnInput<"createWorkspace">,
): Promise<FnOutput<"createWorkspace">> => {
  const p = await requireProject(env, user.id, projectId);
  const custom = customAgentId ? await resolveProfile(env, user.id, customAgentId, agent) : undefined;
  const project = projectToWire(p);
  const defaults = resolveSettings(project.settings, {}).effective;
  const token = await projectToken(env, p);
  const repo = repoOf(p);
  let branch: string;
  let baseBranch: string;
  let wsSource: Source;
  let pr: InitInput["pr"] = null;

  if (source.kind === "new") {
    baseBranch = source.baseBranch;
    wsSource = { kind: "new" };
    branch = "";
  } else if (source.kind === "branch") {
    if (!(await github.branchExists(token, repo, source.branch)))
      throw new TempoError("NOT_FOUND", undefined, "branch not on origin");
    branch = source.branch;
    baseBranch = p.defaultBranch;
    wsSource = { kind: "branch" };
  } else {
    const ghPr = await github.getPullRequest(token, repo, source.number);

    if (ghPr.head.repo?.id !== p.repoId) {
      throw new TempoError("VALIDATION_FAILED", "Pull requests from forks are not supported.");
    }

    branch = ghPr.head.ref;
    baseBranch = ghPr.base.ref || p.defaultBranch;
    wsSource = { kind: "pr", number: source.number };
    pr = { number: source.number, state: prStateOf(ghPr), title: ghPr.title };
  }

  const db = d1(env);
  const author = await authorFor(env, token, user.name);
  const defaultAgent: AgentId = custom?.agent ?? agent ?? defaults.agent.default;
  const now = Date.now();
  const id = newId();

  for (let attempt = 0; attempt < 5; attempt++) {
    const used = await db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(and(eq(workspaces.projectId, projectId), isNull(workspaces.archivedAt)))
      .all();

    const slug = pickSlug(used.map((u) => u.slug));
    const wsBranch = source.kind === "new" ? `${defaults.git.branch_prefix}${slug}` : branch;

    if (!isValidBranch(wsBranch)) throw new TempoError("BRANCH_INVALID");

    try {
      await db
        .insert(workspaces)
        .values({
          id,
          projectId,
          userId: user.id,
          slug,
          title: prompt ? prompt.text.trim().slice(0, 60) : slug,
          branch: wsBranch,
          baseBranch,
          state: "creating",
          attention: "none",
          defaultAgent,
          prNumber: pr?.number ?? null,
          prState: pr?.state ?? null,
          pinned: 0,
          lastActivityAt: now,
          createdAt: now,
          summaryRev: 0,
        })
        .run();
    } catch (e) {
      if (isUniqueViolation(e, "branch")) throw new TempoError("BRANCH_IN_USE");

      if (isUniqueViolation(e, "slug")) continue;
      throw e;
    }

    const res = await env.WORKSPACE.getByName(id).init({
      workspaceId: id,
      projectId,
      userId: user.id,
      slug,
      branch: wsBranch,
      baseBranch,
      source: wsSource,
      defaultAgent,
      agent: defaultAgent,
      model,
      prompt: prompt ? { text: prompt.text } : null,
      pr,
      custom: custom?.custom ?? null,
      author,
      createdAt: now,
    });

    return unwrap(res);
  }

  throw new TempoError("INTERNAL", undefined, "could not pick a slug");
};

export const listModels = async ({ env, user }: HandlerCtx): Promise<FnOutput<"listModels">> => {
  return unwrap(await env.WORKSPACE.getByName(`models:${user.id}`).discoverModels(user.id));
};

const resolveProfile = async (
  env: HandlerCtx["env"],
  userId: string,
  customAgentId: string,
  agent: AgentId | undefined,
): Promise<{ agent: AgentId; custom: SessionAgentProfile }> => {
  const { customAgent, definition } = await resolveCustomAgent(env, userId, customAgentId, agent);

  return {
    agent: definition.baseAgent,
    custom: { customAgent, profile: toAgentProfile(definition), model: definition.model },
  };
};

/** createSession resolves a custom agent here: the WorkspaceDO never reads D1 or Artifacts for it. */
export const createSession: Handler<"createSession"> = async ({ env, user }, input) => {
  const { workspaceId, customAgentId, ...rest } = input;

  if (!(await getOwnedWorkspace(env, user.id, workspaceId))) throw new TempoError("NOT_FOUND");

  const custom = customAgentId
    ? (await resolveProfile(env, user.id, customAgentId, rest.agent)).custom
    : undefined;

  return unwrap(
    await env.WORKSPACE.getByName(workspaceId).createSession(custom ? { ...rest, custom } : rest),
  );
};

export const listWorkspaces = async (
  { env, user }: HandlerCtx,
  { includeArchived }: FnInput<"listWorkspaces">,
): Promise<FnOutput<"listWorkspaces">> => {
  const db = d1(env);

  const where = includeArchived
    ? eq(workspaces.userId, user.id)
    : and(eq(workspaces.userId, user.id), isNull(workspaces.archivedAt));

  const rows = await db.select().from(workspaces).where(where).orderBy(desc(workspaces.lastActivityAt)).all();

  return rows.map(summaryFromD1Row);
};

/**
 * Workspace functions (02): check ownership, then call the WorkspaceDO method with the same name
 * and the same input minus workspaceId. The Worker never writes WorkspaceDO data itself.
 */
export const viaWorkspace =
  <K extends WorkspaceFnName>(name: K): Handler<K> =>
  async ({ env, user }, input) => {
    const { workspaceId, ...rest } = input;

    if (!(await getOwnedWorkspace(env, user.id, workspaceId))) throw new TempoError("NOT_FOUND");
    const stub = workspaceStub(env.WORKSPACE, workspaceId);

    // SAFETY: name indexes the generated RPC method and its matching MethodInput<K>/FnOutput<K> contract.
    const invoke = stub[name] as (
      input: Omit<FnInput<K>, "workspaceId">,
    ) => Promise<import("@tempo/protocol").Result<FnOutput<K>>>;

    return unwrap(await invoke(rest));
  };
