import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TempoError } from "@tempo/protocol";
import { findBinary, run, tail } from "./exec.ts";

export const MAX_LIST_PATHS = 50_000;
const MAX_LINE_CHARS = 1_000;

const isUnder = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Real path of `p`, or of its nearest existing ancestor joined with the rest. */
const realOfNearest = (p: string): string => {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  return resolve(realOrSelf(cur), ...rest);
};

/** Absolute path inside one of `roots`, following symlinks, or null if it escapes them. */
export const insideRoots = (roots: ReadonlyArray<string>, path: string): string | null => {
  if (!isAbsolute(path)) return null;
  const abs = resolve(path);
  const lexical = roots.some((r) => isUnder(resolve(r), abs) || isUnder(realOrSelf(r), abs));
  if (!lexical) return null;
  const real = realOfNearest(abs);
  return roots.some((r) => isUnder(realOrSelf(r), real)) ? abs : null;
};

/** Resolves a workspace path (relative, or absolute under the workspace). */
export const resolveWorkspacePath = (workspace: string, path: string): string => {
  const abs = isAbsolute(path) ? path : resolve(workspace, path);
  const inside = insideRoots([workspace], abs);
  if (!inside) throw new TempoError("PATH_OUTSIDE_WORKSPACE");
  return inside;
};

/** Workspace-relative form of a path that is known to be inside it. */
export const relativeToWorkspace = (workspace: string, abs: string): string => {
  const rel = relative(resolve(workspace), abs);
  if (!rel.startsWith("..")) return rel;
  return relative(realOrSelf(workspace), realOfNearest(abs));
};

export const listFiles = async (workspace: string, env: Record<string, string>): Promise<string[]> => {
  const r = await run(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: workspace, env });
  if (r.code !== 0) throw new TempoError("INTERNAL", tail(r.stderr, 1000) || "git ls-files failed");
  const out = new Set<string>();
  for (const p of r.stdout.split("\0")) {
    if (p === "") continue;
    out.add(p);
    if (out.size >= MAX_LIST_PATHS) break;
  }
  return [...out];
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

export const readWorkspaceFile = async (
  workspace: string,
  path: string,
  maxBytes: number,
): Promise<{ content: string; encoding: "utf8" | "base64"; size: number }> => {
  const abs = resolveWorkspacePath(workspace, path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new TempoError("NOT_FOUND");
  }
  if (!st.isFile()) throw new TempoError("NOT_FOUND", "Not a file.");
  if (st.size > maxBytes) throw new TempoError("FILE_TOO_LARGE");
  const bytes = await readFile(abs);
  const size = bytes.byteLength;
  if (size > maxBytes) throw new TempoError("FILE_TOO_LARGE");
  if (!bytes.subarray(0, 8000).includes(0)) {
    try {
      return { content: utf8.decode(bytes), encoding: "utf8", size };
    } catch {
      // not valid UTF-8: fall through to base64
    }
  }
  return { content: bytes.toString("base64"), encoding: "base64", size };
};

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

const clip = (text: string): string => {
  const t = text.replace(/\r?\n$/, "");
  return t.length > MAX_LINE_CHARS ? t.slice(0, MAX_LINE_CHARS) : t;
};

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

export const searchFiles = async (
  workspace: string,
  env: Record<string, string>,
  query: string,
  regex: boolean,
  maxResults: number,
): Promise<SearchMatch[]> => {
  const limit = Math.max(0, Math.floor(maxResults));
  if (limit === 0 || query === "") return [];
  const rg = findBinary("rg");
  return rg ? searchRg(rg, workspace, env, query, regex, limit) : searchGitGrep(workspace, env, query, regex, limit);
};

const searchRg = async (
  rg: string,
  workspace: string,
  env: Record<string, string>,
  query: string,
  regex: boolean,
  limit: number,
): Promise<SearchMatch[]> => {
  const args = [rg, "--json", "--hidden", "--glob", "!.git", ...(regex ? [] : ["-F"]), "-e", query, "--", "."];
  const proc = Bun.spawn(args, { cwd: workspace, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stderr = new Response(proc.stderr).text();
  const out: SearchMatch[] = [];
  for await (const line of lines(proc.stdout)) {
    if (!line.startsWith('{"type":"match"')) continue;
    let msg: { data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const path = msg.data?.path?.text;
    const lineNo = msg.data?.line_number;
    const text = msg.data?.lines?.text;
    if (path === undefined || lineNo === undefined || text === undefined) continue;
    out.push({ path: path.replace(/^\.\//, ""), line: lineNo, text: clip(text) });
    if (out.length >= limit) {
      proc.kill("SIGKILL");
      break;
    }
  }
  const code = await proc.exited;
  if (out.length < limit && code === 2 && out.length === 0) {
    throw new TempoError("VALIDATION_FAILED", tail(await stderr, 500) || "Search failed.");
  }
  return out;
};

const searchGitGrep = async (
  workspace: string,
  env: Record<string, string>,
  query: string,
  regex: boolean,
  limit: number,
): Promise<SearchMatch[]> => {
  const r = await run(["git", "grep", "-z", "-n", "-I", "--untracked", regex ? "-E" : "-F", "-e", query], {
    cwd: workspace,
    env,
  });
  if (r.code === 1) return [];
  if (r.code !== 0) throw new TempoError("VALIDATION_FAILED", tail(r.stderr, 500) || "Search failed.");
  const out: SearchMatch[] = [];
  for (const line of r.stdout.split("\n")) {
    const a = line.indexOf("\0");
    const b = line.indexOf("\0", a + 1);
    if (a < 0 || b < 0) continue;
    out.push({ path: line.slice(0, a), line: Number(line.slice(a + 1, b)), text: clip(line.slice(b + 1)) });
    if (out.length >= limit) break;
  }
  return out;
};
