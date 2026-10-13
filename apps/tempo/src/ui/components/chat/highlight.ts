import type { CSSProperties } from "react";

/** Shiki, loaded on first use (04: code highlighting with Shiki, loaded lazily). */

export interface HighlightToken {
  readonly content: string;
  readonly style: CSSProperties | undefined;
}

export type HighlightLines = ReadonlyArray<ReadonlyArray<HighlightToken>>;

type Shiki = typeof import("shiki");

let shiki: Promise<Shiki> | null = null;
const load = (): Promise<Shiki | null> =>
  import.meta.env.SSR ? Promise.resolve(null) : (shiki ??= import("shiki"));

/** Above this, code shows plain: highlighting would block the page. */
export const MAX_HIGHLIGHT_CHARS = 60_000;

/** Shiki's inline styles use CSS names; React wants camelCase except for custom properties. */
export const toReactStyle = (
  css: Readonly<Record<string, string>> | undefined,
): CSSProperties | undefined => {
  if (!css) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(css)) {
    out[k.startsWith("--") ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as CSSProperties;
};

/** A fence info string to a Shiki language id, or null when Shiki does not know it. */
export const resolveLanguage = (lang: string, known: Readonly<Record<string, unknown>>): string | null => {
  const id = lang.trim().toLowerCase().split(/[\s{]/)[0] ?? "";
  if (!id || id === "text" || id === "plain" || id === "txt") return null;
  return Object.hasOwn(known, id) ? id : null;
};

const cache = new Map<string, HighlightLines>();
const CACHE_MAX = 200;

/**
 * Tokens with the light colour inline and the dark one in `--shiki-dark` (styles.css swaps them
 * under `.dark [data-shiki]`). Null when the language is unknown or the code is too large.
 */
export const highlight = async (code: string, lang: string): Promise<HighlightLines | null> => {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = await load();
  if (!s) return null;
  const id = resolveLanguage(lang, { ...s.bundledLanguages, ...s.bundledLanguagesAlias });
  if (!id) return null;
  const result = await s.codeToTokens(code, {
    lang: id as Parameters<Shiki["codeToTokens"]>[1]["lang"],
    themes: { light: "github-light", dark: "github-dark" },
  });
  const lines: HighlightLines = result.tokens.map((line) =>
    line.map((t) => ({ content: t.content, style: toReactStyle(t.htmlStyle) })),
  );
  cache.set(key, lines);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return lines;
};
