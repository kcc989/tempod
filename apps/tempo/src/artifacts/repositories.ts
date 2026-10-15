import { TempoError } from "@tempo/protocol";
import { Option, Schema } from "effect";
import type { Env } from "../env.ts";

const REPO_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const NAMESPACE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/;

const GIT_HOST = /^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/;

const TOKEN_TTL = 600;

const MAX_CACHED_TOKENS = 256;

const MAX_REFS_BYTES = 2 * 1024 * 1024;

const tokenCaches = new WeakMap<Artifacts, Map<string, { token: string; expiresAt: number }>>();

const ARTIFACTS_ERRORS = new Set([
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "CREATE_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
  "INVALID_INPUT",
  "INVALID_REPO_NAME",
  "INVALID_TTL",
  "INVALID_URL",
  "REMOTE_AUTH_REQUIRED",
  "UPSTREAM_UNAVAILABLE",
  "MEMORY_LIMIT",
  "INTERNAL_ERROR",
]);

// oxlint-disable no-control-regex
const BRANCH_NAME =
  /^(?![-./]|HEAD$|.*(?:\/\.|\/\/|\.\.|@\{|\\|\.lock\/))[^\x00-\x20~^:?*[\x7f]+(?<![./]|\.lock)$/;
// oxlint-enable no-control-regex

export const requireArtifacts = (env: Env): Artifacts => {
  if (!env.ARTIFACTS) throw new TempoError("ARTIFACTS_NOT_CONFIGURED");

  return env.ARTIFACTS;
};

export const validateArtifactName = (name: string): void => {
  if (!REPO_NAME.test(name))
    throw new TempoError(
      "VALIDATION_FAILED",
      undefined,
      "Repository names must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens.",
    );
};

export const validateArtifactBranch = (branch: string): void => {
  if (!branch || branch.length > 250 || branch === "@" || !BRANCH_NAME.test(branch))
    throw new TempoError("BRANCH_INVALID");
};

export const validateArtifactRef = (ref: string): void => {
  if (ref === "HEAD" || /^[a-f0-9]{40}$/.test(ref)) return;

  if (
    !ref ||
    ref.length > 250 ||
    ref === "@" ||
    !BRANCH_NAME.test(ref) ||
    (ref.startsWith("refs/") && !ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/"))
  )
    throw new TempoError("VALIDATION_FAILED", undefined, "Use a valid branch, tag, or full commit SHA.");
};

export const artifactErrorCode = (cause: unknown): string | null => {
  const parsed = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(cause);

  return Option.isSome(parsed) && ARTIFACTS_ERRORS.has(parsed.value.code) ? parsed.value.code : null;
};

export const artifactCall = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (cause) {
    if (cause instanceof TempoError) throw cause;
    const code = artifactErrorCode(cause);

    if (code === "NOT_FOUND") throw new TempoError("NOT_FOUND");

    if (["INVALID_INPUT", "INVALID_REPO_NAME", "INVALID_TTL", "INVALID_URL"].includes(code ?? ""))
      throw new TempoError("VALIDATION_FAILED", undefined, `Artifacts ${code}`);
    throw new TempoError("ARTIFACTS_API_ERROR", undefined, code ? `Artifacts ${code}` : undefined);
  }
};

export const withArtifactRepository = async <T>(
  env: Env,
  name: string,
  read: (repo: ArtifactsRepo) => Promise<T>,
): Promise<T> => {
  validateArtifactName(name);
  const artifacts = requireArtifacts(env);

  return artifactCall(async () => {
    using repo = await artifacts.get(name);

    return await read(repo);
  });
};

export const assertArtifactRemote = (remote: string, name?: string): URL => {
  let url: URL;

  try {
    url = new URL(remote);
  } catch {
    throw new TempoError("ARTIFACTS_API_ERROR", undefined, "Artifacts returned an invalid Git remote.");
  }

  const parts = url.pathname.split("/");
  const repoName = parts[3]?.replace(/\.git$/, "");

  if (
    url.href !== remote ||
    url.protocol !== "https:" ||
    !GIT_HOST.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 4 ||
    parts[1] !== "git" ||
    !NAMESPACE_NAME.test(parts[2] ?? "") ||
    !parts[3]?.endsWith(".git") ||
    !REPO_NAME.test(repoName ?? "") ||
    (name !== undefined && repoName !== name)
  )
    throw new TempoError("ARTIFACTS_API_ERROR", undefined, "Artifacts returned an invalid Git remote.");

  return url;
};

const validateRepositoryInfo = (
  info: ArtifactsRepoInfo,
  name: string,
  expectedId?: string,
): ArtifactsRepoInfo => {
  assertArtifactRemote(info.remote, name);

  if (info.name !== name || !info.id) throw new TempoError("ARTIFACTS_API_ERROR");

  if (expectedId !== undefined && info.id !== expectedId) throw new TempoError("NOT_FOUND");

  return info;
};

export const repoInfo = (env: Env, name: string, expectedId?: string): Promise<ArtifactsRepoInfo> =>
  withArtifactRepository(env, name, async (repo) => {
    return validateRepositoryInfo(await repo.info(), name, expectedId);
  });

export const artifactRepositoryInfo = repoInfo;

export const assertArtifactRepositoryIdentity = async (
  env: Env,
  name: string,
  id: string | null,
): Promise<ArtifactsRepoInfo> => {
  if (!id) throw new TempoError("REPO_NOT_ACCESSIBLE");

  return repoInfo(env, name, id);
};

export const artifactHeadSha = async (
  env: Env,
  name: string,
  branch: string,
  expectedId?: string,
): Promise<string | null> => {
  validateArtifactBranch(branch);

  return withArtifactRepository(env, name, async (repo) => {
    validateRepositoryInfo(await repo.info(), name, expectedId);

    // The binding resolves branch names, not full ref names.
    return (await repo.log({ ref: branch, limit: 1 }))[0]?.hash ?? null;
  });
};

export const artifactToken = async (
  env: Env,
  name: string,
  scope: "read" | "write" = "write",
  expectedId?: string,
): Promise<string> => {
  const artifacts = requireArtifacts(env);
  let cache = tokenCaches.get(artifacts);

  if (!cache) {
    cache = new Map();
    tokenCaches.set(artifacts, cache);
  }

  return withArtifactRepository(env, name, async (repo) => {
    const info = validateRepositoryInfo(await repo.info(), name, expectedId);

    if (scope === "write" && info.readOnly)
      throw new TempoError("REPO_NOT_ACCESSIBLE", "This repository is read-only.");
    const key = `${scope}:${name}:${info.id}`;
    const hit = cache.get(key);

    if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
    const issued = await repo.createToken(scope, TOKEN_TTL);
    const expiresAt = Date.parse(issued.expiresAt);

    if (!issued.plaintext || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
      throw new TempoError("ARTIFACTS_API_ERROR", undefined, "Artifacts returned an invalid access token.");

    for (const [cachedKey, value] of cache) {
      if (value.expiresAt <= Date.now()) cache.delete(cachedKey);
    }

    while (cache.size >= MAX_CACHED_TOKENS) cache.delete(cache.keys().next().value!);
    cache.set(key, { token: issued.plaintext, expiresAt });

    return issued.plaintext;
  });
};

const readRefs = async (response: Response): Promise<BranchTip[]> => {
  if (!response.body) throw new TempoError("ARTIFACTS_API_ERROR");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) break;
      size += next.value.byteLength;

      if (size > MAX_REFS_BYTES) {
        await reader.cancel();
        throw new TempoError("ARTIFACTS_API_ERROR", undefined, "The Git refs response is too large.");
      }

      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const refs = new Map<string, string>();
  offset = 0;
  let serviceSeen = false;

  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new TempoError("ARTIFACTS_API_ERROR");
    const prefix = decoder.decode(bytes.subarray(offset, offset + 4));

    if (!/^[a-fA-F0-9]{4}$/.test(prefix)) throw new TempoError("ARTIFACTS_API_ERROR");
    const length = Number.parseInt(prefix, 16);
    offset += 4;

    if (length === 0) continue;

    if (length < 4 || offset + length - 4 > bytes.length) throw new TempoError("ARTIFACTS_API_ERROR");
    const line = decoder.decode(bytes.subarray(offset, offset + length - 4));
    offset += length - 4;

    if (!serviceSeen) {
      if (line !== "# service=git-upload-pack\n") throw new TempoError("ARTIFACTS_API_ERROR");
      serviceSeen = true;
      continue;
    }

    if (!/^[a-f0-9]{40} [^\0\n]+(?:\0[^\n]*)?\n?$/.test(line)) throw new TempoError("ARTIFACTS_API_ERROR");
    const match = /^([a-f0-9]{40}) (refs\/heads\/[^\0\n]+)(?:\0[^\n]*)?\n?$/.exec(line);

    if (match) refs.set(match[2]!.slice("refs/heads/".length), match[1]!);
  }

  if (!serviceSeen) throw new TempoError("ARTIFACTS_API_ERROR");

  return [...refs]
    .map(([name, sha]) => ({ name, sha }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

export interface BranchTip {
  readonly name: string;
  readonly sha: string;
}

/** Every branch and its tip, from Git ref advertisement (09). */
export const artifactBranchTips = (env: Env, name: string, expectedId?: string): Promise<BranchTip[]> =>
  artifactCall(async () => {
    const info = await repoInfo(env, name, expectedId);
    const url = assertArtifactRemote(info.remote, name);
    url.pathname += "/info/refs";
    url.searchParams.set("service", "git-upload-pack");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${await artifactToken(env, name, "read", info.id)}`,
        Accept: "application/x-git-upload-pack-advertisement",
        "User-Agent": "tempo",
      },
      // workerd rejects "error"; a redirect fails the status check below.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok)
      throw new TempoError(
        "ARTIFACTS_API_ERROR",
        undefined,
        `Artifacts Git returned HTTP ${response.status}.`,
      );

    if (response.headers.get("Content-Type")?.split(";")[0] !== "application/x-git-upload-pack-advertisement")
      throw new TempoError("ARTIFACTS_API_ERROR");

    return readRefs(response);
  });

export const listArtifactBranches = async (
  env: Env,
  name: string,
  query?: string,
  expectedId?: string,
): Promise<{ name: string }[]> => {
  const q = query?.toLowerCase() ?? "";

  return (await artifactBranchTips(env, name, expectedId))
    .filter((branch) => branch.name.toLowerCase().includes(q))
    .slice(0, 100)
    .map((branch) => ({ name: branch.name }));
};

export const artifactBranchExists = async (
  env: Env,
  name: string,
  branch: string,
  expectedId?: string,
): Promise<boolean> => (await artifactBranchTips(env, name, expectedId)).some((tip) => tip.name === branch);
