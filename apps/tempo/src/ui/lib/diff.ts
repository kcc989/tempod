/** Unified diff parsing (getFileDiff returns a unified diff with 3 lines of context) and a line diff. */

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface DiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: ReadonlyArray<DiffLine>;
}

export interface ParsedDiff {
  readonly hunks: ReadonlyArray<DiffHunk>;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export const parseUnifiedDiff = (text: string): ParsedDiff => {
  const hunks: DiffHunk[] = [];
  let current: { header: string; oldStart: number; newStart: number; lines: DiffLine[] } | null = null;
  let oldNo = 0;
  let newNo = 0;
  let binary = false;
  let additions = 0;
  let deletions = 0;
  const lines = text.split("\n");

  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    const m = HUNK.exec(line);

    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      current = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      hunks.push(current);
      continue;
    }

    if (!current) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
      continue;
    }

    if (line.startsWith("\\")) continue;
    const sign = line[0];
    const body = line.slice(1);

    if (sign === "+") {
      current.lines.push({ kind: "add", text: body, oldLine: null, newLine: newNo++ });
      additions++;
    } else if (sign === "-") {
      current.lines.push({ kind: "del", text: body, oldLine: oldNo++, newLine: null });
      deletions++;
    } else if (sign === " " || line === "") {
      current.lines.push({ kind: "context", text: body, oldLine: oldNo++, newLine: newNo++ });
    } else if (line.startsWith("diff --git")) {
      current = null;
    }
  }

  return { hunks, binary, additions, deletions };
};

export interface SplitRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

/** Pairs each run of deletions with the run of additions that follows it. */
export const toSplitRows = (hunk: DiffHunk): SplitRow[] => {
  const rows: SplitRow[] = [];
  const ls = hunk.lines;
  let i = 0;

  while (i < ls.length) {
    const line = ls[i]!;

    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }

    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];

    while (i < ls.length && ls[i]!.kind === "del") dels.push(ls[i++]!);

    while (i < ls.length && ls[i]!.kind === "add") adds.push(ls[i++]!);
    const n = Math.max(dels.length, adds.length);

    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }

  return rows;
};

const MAX_CELLS = 4_000_000;

/**
 * Line diff between two texts (Myers, O((N+M)·D)). Used for ACP `diff` tool content, which sends
 * the old and new file text. Very large inputs fall back to "all removed, all added".
 */
export const diffLines = (oldText: string, newText: string): DiffLine[] => {
  const a = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const b = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
  // Trim the common prefix and suffix first; most edits are small.
  let start = 0;

  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;

  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];

  for (let i = 0; i < start; i++) out.push({ kind: "context", text: a[i]!, oldLine: i + 1, newLine: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = (midA.length * midB.length > MAX_CELLS ? null : myers(midA, midB)) ?? fallback(midA, midB);
  let o = start;
  let n = start;

  for (const op of ops) {
    if (op.kind === "context") out.push({ kind: "context", text: op.text, oldLine: ++o, newLine: ++n });
    else if (op.kind === "del") out.push({ kind: "del", text: op.text, oldLine: ++o, newLine: null });
    else out.push({ kind: "add", text: op.text, oldLine: null, newLine: ++n });
  }

  for (let i = endA; i < a.length; i++)
    out.push({ kind: "context", text: a[i]!, oldLine: ++o, newLine: ++n });

  return out;
};

interface Op {
  readonly kind: DiffLineKind;
  readonly text: string;
}

const fallback = (a: string[], b: string[]): Op[] => [
  ...a.map((text) => ({ kind: "del" as const, text })),
  ...b.map((text) => ({ kind: "add" as const, text })),
];

const MAX_EDITS = 1500;

const myers = (a: string[], b: string[]): Op[] | null => {
  const n = a.length;
  const m = b.length;

  if (n === 0) return b.map((text) => ({ kind: "add", text }));

  if (m === 0) return a.map((text) => ({ kind: "del", text }));
  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_EDITS) return null;
    trace.push(v.slice());
    const next = v.slice();

    for (let k = -d; k <= d; k += 2) {
      let x: number;

      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;

      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      next[offset + k] = x;

      if (x >= n && y >= m) {
        v = next;
        trace.push(v.slice());
        break outer;
      }
    }

    v = next;
  }

  // Backtrack.
  const ops: Op[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;

    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ kind: "context", text: a[x - 1]! });
      x--;
      y--;
    }

    if (d === 0) break;

    if (x === prevX) ops.push({ kind: "add", text: b[y - 1]! });
    else ops.push({ kind: "del", text: a[x - 1]! });
    x = prevX;
    y = prevY;
  }

  while (x > 0 && y > 0) {
    ops.push({ kind: "context", text: a[x - 1]! });
    x--;
    y--;
  }

  return ops.reverse();
};
