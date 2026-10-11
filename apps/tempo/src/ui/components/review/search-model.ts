/** ⌘⇧F: searchFiles results, grouped by file. */

export const SEARCH_DEBOUNCE_MS = 250;

/** 02, searchFiles: at most 500 results. */
export const SEARCH_LIMIT = 500;

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface MatchGroup {
  readonly path: string;
  readonly matches: ReadonlyArray<{ readonly line: number; readonly text: string }>;
}

const MAX_TEXT = 300;

/** Files in the order the server found them; lines ascending, one row per line. */
export const groupMatches = (matches: ReadonlyArray<SearchMatch>): MatchGroup[] => {
  const groups = new Map<string, Map<number, string>>();
  for (const m of matches) {
    let lines = groups.get(m.path);
    if (!lines) {
      lines = new Map();
      groups.set(m.path, lines);
    }
    if (!lines.has(m.line)) lines.set(m.line, m.text.trim().slice(0, MAX_TEXT));
  }
  return [...groups].map(([path, lines]) => ({
    path,
    matches: [...lines].sort((a, b) => a[0] - b[0]).map(([line, text]) => ({ line, text })),
  }));
};
