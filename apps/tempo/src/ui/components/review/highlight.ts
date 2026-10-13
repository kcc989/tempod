import type { CSSProperties } from "react";

/** Shiki for the File tab, loaded on first use (04: Shiki, loaded lazily). */

export interface Token {
  readonly content: string;
  readonly style: CSSProperties | undefined;
}

export type TokenLines = ReadonlyArray<ReadonlyArray<Token>>;

type Shiki = typeof import("shiki");

let shiki: Promise<Shiki> | null = null;
const load = (): Promise<Shiki | null> =>
  import.meta.env.SSR ? Promise.resolve(null) : (shiki ??= import("shiki"));

/** Above this many characters a file shows plain: highlighting would hold the page too long. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  justfile: "just",
  ".bashrc": "bash",
  ".zshrc": "zsh",
  ".env": "dotenv",
};

const BY_EXT: Readonly<Record<string, string>> = {
  mts: "ts",
  cts: "ts",
  mjs: "js",
  cjs: "js",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  yml: "yaml",
  md: "markdown",
  mdx: "mdx",
  txt: "",
  lock: "",
};

/**
 * The Shiki language for a path, or null for plain text. `known` is Shiki's bundled languages
 * and aliases.
 */
export const languageFor = (path: string, known: Readonly<Record<string, unknown>>): string | null => {
  const name = (path.slice(path.lastIndexOf("/") + 1) || path).toLowerCase();
  const byName = BY_NAME[name] ?? (name.startsWith("dockerfile.") ? "docker" : undefined);
  if (byName !== undefined) return byName !== "" && Object.hasOwn(known, byName) ? byName : null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  const id = BY_EXT[ext] ?? ext;
  return id !== "" && Object.hasOwn(known, id) ? id : null;
};

/** Shiki's inline styles use CSS names; React wants camelCase except for custom properties. */
const toReactStyle = (css: Readonly<Record<string, string>> | undefined): CSSProperties | undefined => {
  if (!css) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(css)) {
    out[k.startsWith("--") ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as CSSProperties;
};

const cache = new Map<string, TokenLines>();
const CACHE_MAX = 20;

/**
 * Tokens per line with the light colour inline and the dark one in `--shiki-dark` (styles.css
 * swaps them under `.dark [data-shiki]`). Null for plain text.
 */
export const highlightFile = async (code: string, path: string): Promise<TokenLines | null> => {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = `${path}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = await load();
  if (!s) return null;
  const lang = languageFor(path, { ...s.bundledLanguages, ...s.bundledLanguagesAlias });
  if (!lang) return null;
  const result = await s.codeToTokens(code, {
    lang: lang as Parameters<Shiki["codeToTokens"]>[1]["lang"],
    themes: { light: "github-light", dark: "github-dark" },
  });
  const lines: TokenLines = result.tokens.map((line) =>
    line.map((t) => ({ content: t.content, style: toReactStyle(t.htmlStyle) })),
  );
  cache.set(key, lines);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return lines;
};

/** File text as lines: no empty last line for a trailing newline, no CR of CRLF. */
export const splitLines = (content: string): string[] => {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
};
