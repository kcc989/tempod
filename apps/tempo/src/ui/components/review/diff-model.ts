import { Schema } from "effect";
import type { ReviewComment, ReviewSide } from "@tempo/protocol";
import type { DiffLine, ParsedDiff, SplitRow } from "~/ui/lib/diff";
import { hashString } from "~/ui/lib/format";

/** 04, Diff tab: view mode, viewed marks, line selection for comments, comment placement, file steps. */

export type DiffView = "unified" | "split";

export const DIFF_VIEW_KEY = "review:diff-view";

export const isDiffView = (u: unknown): u is DiffView => u === "unified" || u === "split";

/** Unified only below 1024 px. */
export const effectiveView = (preference: DiffView, narrow: boolean): DiffView =>
  narrow ? "unified" : preference;

/** A parsed diff with more lines than this waits for `Show diff`. */
export const LARGE_DIFF_LINES = 2000;

export const diffLineCount = (parsed: ParsedDiff): number =>
  parsed.hunks.reduce((n, h) => n + h.lines.length, 0);

// ---------------------------------------------------------------------------------------------
// Viewed marks: { [path]: diff hash } per workspace in localStorage.

export type ViewedMarks = Readonly<Record<string, string>>;

export const EMPTY_MARKS: ViewedMarks = {};

export const MAX_VIEWED_MARKS = 500;

export const viewedKey = (workspaceId: string): string => `review:viewed:${workspaceId}`;

export const isViewedMarks = Schema.is(Schema.Record(Schema.String, Schema.String));

export const diffHash = (diff: string): string => hashString(diff);

/** A mark counts only while the diff is the one that was viewed. */
export const isViewed = (marks: ViewedMarks, path: string, hash: string | null): boolean =>
  hash !== null && marks[path] === hash;

/** Sets or clears one mark. Past MAX_VIEWED_MARKS the oldest marks go first. */
export const withViewed = (marks: ViewedMarks, path: string, hash: string, viewed: boolean) => {
  const next: Record<string, string> = {};

  for (const [p, h] of Object.entries(marks)) if (p !== path) next[p] = h;

  if (viewed) next[path] = hash;
  const keys = Object.keys(next);

  for (let i = 0; i < keys.length - MAX_VIEWED_MARKS; i++) delete next[keys[i]!];

  return next;
};

// ---------------------------------------------------------------------------------------------
// Lines and selection

export interface LineRef {
  readonly side: ReviewSide;
  readonly line: number;
}

/** The unified gutter: deletions are on the old side; additions and context on the new side. */
export const unifiedRef = (l: DiffLine): LineRef | null => {
  if (l.kind === "del") return l.oldLine === null ? null : { side: "old", line: l.oldLine };

  return l.newLine === null ? null : { side: "new", line: l.newLine };
};

/** The split gutters: left is the old file, right the new one. */
export const splitRefs = (row: SplitRow) =>
  ({
    left: row.left && row.left.oldLine !== null ? { side: "old", line: row.left.oldLine } : null,
    right: row.right && row.right.newLine !== null ? { side: "new", line: row.right.newLine } : null,
  }) satisfies { readonly left: LineRef | null; readonly right: LineRef | null };

export interface Selection {
  readonly side: ReviewSide;
  readonly anchor: number;
  readonly focus: number;
}

export interface LineRange {
  readonly side: ReviewSide;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export const selectionRange = (s: Selection): LineRange => ({
  side: s.side,
  lineStart: Math.min(s.anchor, s.focus),
  lineEnd: Math.max(s.anchor, s.focus),
});

export const inRange = (r: LineRange | null, ref: LineRef | null): boolean =>
  r !== null && ref !== null && r.side === ref.side && ref.line >= r.lineStart && ref.line <= r.lineEnd;

/** Extends a selection to `ref`; a ref on the other side starts a new one. */
export const extendSelection = (s: Selection | null, ref: LineRef): Selection =>
  s && s.side === ref.side
    ? { side: s.side, anchor: s.anchor, focus: ref.line }
    : { side: ref.side, anchor: ref.line, focus: ref.line };

export const anchorKey = (side: ReviewSide, line: number): string => `${side}:${line}`;

/** Keys a row answers to: a context line sits on both sides. */
export const lineKeys = (l: DiffLine | null): string[] => {
  if (!l) return [];
  const keys: string[] = [];

  if (l.kind !== "add" && l.oldLine !== null) keys.push(anchorKey("old", l.oldLine));

  if (l.kind !== "del" && l.newLine !== null) keys.push(anchorKey("new", l.newLine));

  return keys;
};

export const splitRowKeys = (row: SplitRow): string[] => {
  const keys = lineKeys(row.left);

  for (const k of lineKeys(row.right)) if (!keys.includes(k)) keys.push(k);

  return keys;
};

export interface PlacedComments {
  /** By anchorKey of the comment's last line. */
  readonly byAnchor: ReadonlyMap<string, ReadonlyArray<ReviewComment>>;
  /** Whole-file comments and comments on lines that are not in the diff any more. */
  readonly fileLevel: ReadonlyArray<ReviewComment>;
}

/** Places one file's comments under the diff line they end on. */
export const placeComments = (
  parsed: ParsedDiff | null,
  comments: ReadonlyArray<ReviewComment>,
): PlacedComments => {
  const present = new Set<string>();

  for (const h of parsed?.hunks ?? []) for (const l of h.lines) for (const k of lineKeys(l)) present.add(k);
  const byAnchor = new Map<string, ReviewComment[]>();
  const fileLevel: ReviewComment[] = [];

  for (const c of comments) {
    if (c.lineStart === null) {
      fileLevel.push(c);
      continue;
    }

    const key = anchorKey(c.side ?? "new", c.lineEnd ?? c.lineStart);

    if (!present.has(key)) {
      fileLevel.push(c);
      continue;
    }

    const list = byAnchor.get(key);

    if (list) list.push(c);
    else byAnchor.set(key, [c]);
  }

  return { byAnchor, fileLevel };
};

/** `<path>`, `<path>:<line>` or `<path>:<start>-<end>`. */
export const commentLocation = (c: Pick<ReviewComment, "path" | "lineStart" | "lineEnd">): string => {
  if (c.lineStart === null) return c.path;
  const end = c.lineEnd ?? c.lineStart;

  return end === c.lineStart ? `${c.path}:${c.lineStart}` : `${c.path}:${c.lineStart}-${end}`;
};

export const rangeLabel = (r: LineRange): string =>
  r.lineStart === r.lineEnd ? `Line ${r.lineStart}` : `Lines ${r.lineStart} to ${r.lineEnd}`;

export const drafts = (comments: ReadonlyArray<ReviewComment> | undefined): ReviewComment[] =>
  (comments ?? []).filter((c) => c.status === "draft");

/** `Send <n> comments to <agent>`. */
export const sendLabel = (n: number, agent: string): string =>
  `Send ${n} ${n === 1 ? "comment" : "comments"} to ${agent}`;

// ---------------------------------------------------------------------------------------------
// J and K: file sections stacked in one scroll container.

const SLACK = 4;

/** The file whose section holds the top of the view. `tops` are ascending. */
export const currentFileIndex = (tops: ReadonlyArray<number>, scrollTop: number): number => {
  let i = 0;

  for (let k = 0; k < tops.length; k++) if (tops[k]! <= scrollTop + SLACK) i = k;

  return i;
};

/** The file J (1) or K (-1) moves to, or null at either end. */
export const stepFileIndex = (tops: ReadonlyArray<number>, scrollTop: number, dir: 1 | -1): number | null => {
  if (tops.length === 0) return null;

  if (scrollTop + SLACK < tops[0]!) return dir === 1 ? 0 : null;
  const i = currentFileIndex(tops, scrollTop);

  if (dir === 1) return i + 1 < tops.length ? i + 1 : null;

  if (scrollTop > tops[i]! + SLACK) return i;

  return i > 0 ? i - 1 : null;
};
