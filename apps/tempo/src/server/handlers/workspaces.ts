import { and, desc, eq, isNull } from "drizzle-orm";
import { pickSlug } from "@tempo/cities";
import {
  TempoError,
  newId,
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
import { github } from "../../github/provider.ts";
import { getOwnedWorkspace } from "../../http/common.ts";
import { summaryFromD1Row } from "../../lib/summary.ts";
import { isValidBranch } from "../../do/workspace/rpc.ts";
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

const isUniqueViolation = (e: unknown, index: string) => String(e).includes("UNIQUE") && String(e).includes(index);

/** 03, Create a workspace: checks and the D1 insert here; everything after in WorkspaceDO.init. */
export const createWorkspace = async (
  { env, user }: HandlerCtx,
  { projectId, source, agent, prompt }: FnInput<"createWorkspace">,
): Promise<FnOutput<"createWorkspace">> => {
  const p = await requireProject(env, user.id, projectId);
  const project = projectToWire(p);
  const defaults = resolveSettings(project.settings, {}).effective;
  const token = await projectToken(env, p);
  const repo = repoOf(p);

  let branch: string;
  let baseBranch: string;
  let wsSource: Source;
  if (source.kind === "new") {
    baseBranch = source.baseBranch;
    wsSource = { kind: "new" };
    branch = "";
  } else if (source.kind === "branch") {
    if (!(await github.branchExists(token, repo, source.branch))) throw new TempoError("NOT_FOUND", undefined, "branch not on origin");
    branch = source.branch;
    baseBranch = p.defaultBranch;
    wsSource = { kind: "branch" };
  } else {
    const pr = await github.getPullRequest(token, repo, source.number);
    if (pr.head.repo?.id !== p.repoId) {
      throw new TempoError("VALIDATION_FAILED", "Pull requests from forks are not supported.");
    }
    branch = pr.head.ref;
    baseBranch = pr.base.ref || p.defaultBranch;
    wsSource = { kind: "pr", number: source.number };
  }

  const db = d1(env);
  const author = await authorFor(env, token, user.name);
  const defaultAgent: AgentId = agent ?? defaults.agent.default;
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
      prompt: prompt ? { text: prompt.text } : null,
      author,
      createdAt: now,
    });
    return unwrap(res);
  }
  throw new TempoError("INTERNAL", undefined, "could not pick a slug");
};

export const listWorkspaces = async ({ env, user }: HandlerCtx, { includeArchived }: FnInput<"listWorkspaces">): Promise<FnOutput<"listWorkspaces">> => {
  const db = d1(env);
  const where = includeArchived ? eq(workspaces.userId, user.id) : and(eq(workspaces.userId, user.id), isNull(workspaces.archivedAt));
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
    const { workspaceId, ...rest } = input as FnInput<K> & { workspaceId: string };
    if (!(await getOwnedWorkspace(env, user.id, workspaceId))) throw new TempoError("NOT_FOUND");
    const stub = env.WORKSPACE.getByName(workspaceId) as unknown as Record<K, (i: unknown) => Promise<import("@tempo/protocol").Result<FnOutput<K>>>>;
    return unwrap(await stub[name](rest));
  };
