import { eq } from "drizzle-orm";
import {
  DEFAULT_DOTFILES,
  DOTFILES_LIMITS,
  TempoError,
  dotfilesProblem,
  type Dotfile,
  type DotfilesState,
  type FnInput,
  type FnOutput,
} from "@tempo/protocol";
import {
  artifactBranchTips,
  artifactCall,
  artifactErrorCode,
  artifactToken,
  assertArtifactRemote,
  repoInfo,
  requireArtifacts,
  withArtifactRepository,
} from "../../artifacts/repositories.ts";
import { ZERO_SHA, buildCommit, buildTree, pushObjects } from "../../artifacts/git-writer.ts";
import { dotfiles, type DotfilesRow } from "../../db/d1.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { log } from "../../log.ts";
import type { HandlerCtx } from "../run.ts";
import { d1 } from "./common.ts";

const BRANCH = "main";

const REF = `refs/heads/${BRANCH}`;

/** 01, Shell and dotfiles: `dotfiles-<first 16 hex digits of sha256(userId)>`. */
export const dotfilesRepoName = async (userId: string): Promise<string> =>
  `dotfiles-${(await sha256Hex(userId)).slice(0, 16)}`;

export const dotfilesRow = async (env: HandlerCtx["env"], userId: string): Promise<DotfilesRow | null> =>
  (await d1(env).select().from(dotfiles).where(eq(dotfiles.userId, userId)).get()) ?? null;

/** The image defaults first, in their order, then the rest by path. */
const ordered = (files: ReadonlyArray<Dotfile>): Dotfile[] => {
  const rank = (path: string) => {
    const i = DEFAULT_DOTFILES.findIndex((d) => d.path === path);

    return i === -1 ? DEFAULT_DOTFILES.length : i;
  };

  return [...files].sort(
    (a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
};

const state = (files: ReadonlyArray<Dotfile>, row: DotfilesRow | null): DotfilesState => ({
  files: ordered(files),
  defaults: [...DEFAULT_DOTFILES],
  saved: row !== null,
  updatedAt: row?.updatedAt ?? null,
});

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Every file in the commit's tree, walked with the binding. */
const readSnapshot = (env: HandlerCtx["env"], row: DotfilesRow): Promise<Dotfile[]> =>
  withArtifactRepository(env, row.repoName, async (repo) => {
    const info = await repo.info();
    assertArtifactRemote(info.remote, row.repoName);

    if (info.id !== row.artifactRepoId) throw new TempoError("NOT_FOUND");
    const commit = await repo.readCommit(row.headSha);

    if (!commit) throw new TempoError("ARTIFACTS_API_ERROR", undefined, "The saved shell files are missing.");
    const files: Dotfile[] = [];

    const walk = async (hash: string, prefix: string): Promise<void> => {
      const entries = await repo.readTree(hash);

      if (!entries)
        throw new TempoError("ARTIFACTS_API_ERROR", undefined, "The saved shell files are missing.");

      for (const entry of entries) {
        const path = `${prefix}${entry.name}`;

        if (entry.type === "tree") await walk(entry.hash, `${path}/`);
        else if (entry.type === "blob" || entry.type === "exec") {
          if (files.length >= DOTFILES_LIMITS.filesMax) throw new TempoError("ARTIFACTS_API_ERROR");
          const blob = await repo.readBlob(entry.hash);

          if (!blob)
            throw new TempoError("ARTIFACTS_API_ERROR", undefined, "The saved shell files are missing.");
          files.push({ path, content: utf8.decode(await blob.arrayBuffer()) });
        }
      }
    };

    await walk(commit.treeHash, "");

    return files;
  });

export const getDotfiles = async (
  ctx: HandlerCtx,
  _input: FnInput<"getDotfiles">,
): Promise<FnOutput<"getDotfiles">> => {
  requireArtifacts(ctx.env);
  const row = await adoptRemoteTip(ctx.env, await dotfilesRow(ctx.env, ctx.user.id));

  return state(row ? await readSnapshot(ctx.env, row) : DEFAULT_DOTFILES, row);
};

/** Only Tempo pushes to the repository, so a newer tip is a save whose D1 write was lost. */
const adoptRemoteTip = async (
  env: HandlerCtx["env"],
  row: DotfilesRow | null,
): Promise<DotfilesRow | null> => {
  if (!row) return row;

  const tip = (await artifactBranchTips(env, row.repoName, row.artifactRepoId)).find(
    (t) => t.name === BRANCH,
  )?.sha;

  if (!tip || tip === row.headSha) return row;
  await d1(env).update(dotfiles).set({ headSha: tip }).where(eq(dotfiles.userId, row.userId)).run();

  return { ...row, headSha: tip };
};

const revokeInitialToken = async (env: HandlerCtx["env"], name: string, token: string): Promise<void> => {
  try {
    await withArtifactRepository(env, name, (repo) => repo.revokeToken(token));
  } catch {
    // The token expires on its own; it is never stored.
  }
};

/** Creates the repository on the first save; an existing one (from an earlier, interrupted save) is reused. */
const ensureRepository = async (ctx: HandlerCtx, name: string): Promise<ArtifactsRepoInfo> => {
  await artifactCall(async () => {
    try {
      const created = await requireArtifacts(ctx.env).create(name, { setDefaultBranch: BRANCH });
      await revokeInitialToken(ctx.env, name, created.token);
    } catch (cause) {
      if (artifactErrorCode(cause) !== "ALREADY_EXISTS") throw cause;
    }
  });

  return repoInfo(ctx.env, name);
};

export const updateDotfiles = async (
  ctx: HandlerCtx,
  { files }: FnInput<"updateDotfiles">,
): Promise<FnOutput<"updateDotfiles">> => {
  const problem = dotfilesProblem(files);

  if (problem) throw new TempoError("VALIDATION_FAILED", undefined, problem);
  requireArtifacts(ctx.env);
  const { env, user } = ctx;
  const row = await dotfilesRow(env, user.id);
  const name = row?.repoName ?? (await dotfilesRepoName(user.id));
  const info = row ? await repoInfo(env, name, row.artifactRepoId) : await ensureRepository(ctx, name);
  const remote = assertArtifactRemote(info.remote, name);

  // Without a row, an earlier save may have pushed before its D1 write was lost; build on that tip.
  const old = row
    ? row.headSha
    : ((await artifactBranchTips(env, name, info.id)).find((t) => t.name === BRANCH)?.sha ?? ZERO_SHA);

  const tree = await buildTree(files);
  const now = Date.now();

  const commit = await buildCommit({
    tree: tree.root,
    parent: old === ZERO_SHA ? null : old,
    author: { name: user.name, email: user.email },
    message: "Update shell files",
    at: now,
  });

  const token = await artifactToken(env, name, "write", info.id);

  const result = await artifactCall(() =>
    pushObjects({ remote, token, ref: REF, old, next: commit.sha, objects: [...tree.objects, commit] }),
  );

  if (!result.ok) {
    log("warn", "dotfiles push rejected", { reason: result.reason });
    throw new TempoError("DOTFILES_CHANGED");
  }

  const saved: DotfilesRow = {
    userId: user.id,
    artifactRepoId: info.id,
    repoName: name,
    cloneUrl: remote.href,
    headSha: commit.sha,
    updatedAt: now,
  };

  await d1(env)
    .insert(dotfiles)
    .values(saved)
    .onConflictDoUpdate({
      target: dotfiles.userId,
      set: {
        artifactRepoId: saved.artifactRepoId,
        cloneUrl: saved.cloneUrl,
        headSha: saved.headSha,
        updatedAt: now,
      },
    })
    .run();

  return state(files, saved);
};
