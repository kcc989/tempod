import { Schema, Option } from "effect";
import { TempoError } from "@tempo/protocol";
import type { Env } from "../env.ts";
import { log } from "../log.ts";
import { memoryFs } from "./memfs.ts";

/** Custom agent files in Cloudflare Artifacts (01, Custom agents; 02, Write rules for custom_agents). */
export interface AgentRepoStore {
  /** The file at `ref`, or null when the path is not there. */
  read(repo: string, ref: string, path: string): Promise<string | null>;
  /** Commits `content` at `path` (null deletes it) on main and pushes. Returns the new commit. */
  write(repo: string, path: string, content: string | null, message: string): Promise<string>;
}

const TOKEN_TTL_S = 300;

const PUSH_ATTEMPTS = 3;

const BRANCH = "main";

const DIR = "/repo";

const AUTHOR = { name: "Tempo", email: "tempo@localhost" };

const codeOf = (cause: unknown): string | undefined => {
  const parsed = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(cause);

  return Option.isSome(parsed) ? parsed.value.code : undefined;
};

const artifactsError = (step: string, cause: unknown): TempoError => {
  log("warn", "artifacts call failed", { step, code: codeOf(cause) ?? "unknown" });

  return new TempoError("ARTIFACTS_ERROR", undefined, `${step}: ${codeOf(cause) ?? "failed"}`);
};

const release = (repo: ArtifactsRepo): void => {
  try {
    repo[Symbol.dispose]();
  } catch {
    // The stub is gone already.
  }
};

/** Gets the repo, creating it on first use; ALREADY_EXISTS from a racing create is success. */
const ensureRepo = async (ns: Artifacts, name: string): Promise<ArtifactsRepo> => {
  try {
    return await ns.get(name);
  } catch (e) {
    if (codeOf(e) !== "NOT_FOUND") throw artifactsError("get", e);
  }

  try {
    await ns.create(name, { setDefaultBranch: BRANCH, description: "Tempo custom agents" });
  } catch (e) {
    if (codeOf(e) !== "ALREADY_EXISTS") throw artifactsError("create", e);
  }

  try {
    return await ns.get(name);
  } catch (e) {
    throw artifactsError("get", e);
  }
};

const commitOnce = async (
  remote: string,
  token: string,
  path: string,
  content: string | null,
  message: string,
): Promise<string> => {
  const [{ default: git }, { default: http }] = await Promise.all([
    import("isomorphic-git"),
    import("isomorphic-git/http/web"),
  ]);

  const fs = memoryFs();
  const headers = { Authorization: `Bearer ${token}` };
  await fs.promises.mkdir(DIR);
  await git.init({ fs, dir: DIR, defaultBranch: BRANCH });
  await git.addRemote({ fs, dir: DIR, remote: "origin", url: remote });
  let hasMain = true;

  try {
    await git.fetch({
      fs,
      http,
      dir: DIR,
      remote: "origin",
      ref: BRANCH,
      singleBranch: true,
      depth: 1,
      headers,
    });
    await git.checkout({ fs, dir: DIR, ref: `origin/${BRANCH}`, force: true });
    await git.branch({ fs, dir: DIR, ref: BRANCH, checkout: true, force: true });
  } catch (e) {
    // A new repo has no main yet; the first commit creates it.
    if (codeOf(e) !== "NotFoundError" && codeOf(e) !== "MissingRefError") throw e;
    hasMain = false;
  }

  const full = `${DIR}/${path}`;

  if (content === null) {
    if (!hasMain) throw new TempoError("NOT_FOUND", undefined, "agent file not in repo");
    await fs.promises.unlink(full).catch(() => undefined);
    await git.remove({ fs, dir: DIR, filepath: path });
  } else {
    const segments = path.split("/").slice(0, -1);

    for (let i = 1; i <= segments.length; i++) {
      await fs.promises.mkdir(`${DIR}/${segments.slice(0, i).join("/")}`).catch(() => undefined);
    }

    await fs.promises.writeFile(full, content);
    await git.add({ fs, dir: DIR, filepath: path });
  }

  const sha = await git.commit({ fs, dir: DIR, message, author: AUTHOR, committer: AUTHOR });

  const res = await git.push({
    fs,
    http,
    dir: DIR,
    remote: "origin",
    ref: BRANCH,
    remoteRef: BRANCH,
    headers,
  });

  if (!res.ok) throw Object.assign(new Error("push rejected"), { code: "PushRejectedError" });

  return sha;
};

export const artifactsStore = (env: Env): AgentRepoStore => ({
  async read(repoName, ref, path) {
    let repo: ArtifactsRepo;

    try {
      repo = await env.AGENTS.get(repoName);
    } catch (e) {
      throw artifactsError("get", e);
    }

    try {
      const blob = await repo.readFile({ ref, path });

      return blob === null ? null : await blob.text();
    } catch (e) {
      throw artifactsError("read", e);
    } finally {
      release(repo);
    }
  },

  async write(repoName, path, content, message) {
    const repo = await ensureRepo(env.AGENTS, repoName);
    let tokenId: string | undefined;

    try {
      const { remote } = await repo.info();
      const token = await repo.createToken("write", TOKEN_TTL_S);
      tokenId = token.id;

      for (let attempt = 1; ; attempt++) {
        try {
          return await commitOnce(remote, token.plaintext, path, content, message);
        } catch (e) {
          if (e instanceof TempoError) throw e;

          // A rejected (non-fast-forward) push fetches main again (02, at most 3 times).
          if (codeOf(e) !== "PushRejectedError" || attempt >= PUSH_ATTEMPTS) throw artifactsError("push", e);
        }
      }
    } catch (e) {
      throw e instanceof TempoError ? e : artifactsError("token", e);
    } finally {
      if (tokenId) await repo.revokeToken(tokenId).catch(() => undefined);
      release(repo);
    }
  },
});

/** Indirection so tests can replace the store (as they spy on `github`). */
export const agentStore = { forEnv: artifactsStore };
