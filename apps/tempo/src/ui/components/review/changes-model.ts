import { Schema } from "effect";
import type { ChangedFile, ChangesSummary, WorkspaceState } from "@tempo/protocol";

/** 04, Changes tab: the status letter (A, M, D, R) and helpers for the file list. */

/** The `Group by folder` toggle, kept per browser. */
export const GROUP_BY_FOLDER_KEY = "review:group-by-folder";

export const isBoolean = (u: unknown): u is boolean => Schema.is(Schema.Boolean)(u);

const STATUS_LABELS = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
} satisfies Readonly<Record<string, string>>;

export const statusLetter = (status: string): string => (status.charAt(0) || "M").toUpperCase();

export const statusLabel = (status: string): string =>
  Object.entries(STATUS_LABELS).find(([key]) => key === statusLetter(status))?.[1] ?? "Changed";

/** Text colour per status letter; colour marks state only. */
export const statusClass = (status: string): string => {
  switch (statusLetter(status)) {
    case "A":
      return "text-success";
    case "D":
      return "text-destructive";
    case "R":
      return "text-merged";
    default:
      return "text-warning";
  }
};

export const splitPath = (path: string): { readonly dir: string; readonly name: string } => {
  const i = path.lastIndexOf("/");

  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
};

/** Byte order, like git. */
export const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface Totals {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

export const totals = (files: ReadonlyArray<ChangedFile>): Totals => {
  let additions = 0;
  let deletions = 0;

  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }

  return { files: files.length, additions, deletions };
};

export const sortFiles = (files: ReadonlyArray<ChangedFile>): ChangedFile[] =>
  [...files].sort((a, b) => comparePaths(a.path, b.path));

export type ChangeRow =
  | {
      readonly kind: "folder";
      readonly key: string;
      readonly dir: string;
      readonly count: number;
      readonly additions: number;
      readonly deletions: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "file";
      readonly key: string;
      readonly file: ChangedFile;
      /** 1 under a folder row. */
      readonly depth: 0 | 1;
      /** The file name under a folder row, else the whole path. */
      readonly label: string;
      readonly dir: string;
    };

/**
 * The rows of the Changes list. Grouped: one folder row per directory (by full directory path,
 * sorted), its files under it; files at the top level come first with no folder row.
 */
export const changeRows = (
  files: ReadonlyArray<ChangedFile>,
  opts: { readonly grouped: boolean; readonly collapsed?: ReadonlySet<string> },
): ChangeRow[] => {
  const sorted = sortFiles(files);

  if (!opts.grouped) {
    return sorted.map((file) => ({
      kind: "file",
      key: `file:${file.path}`,
      file,
      depth: 0,
      label: file.path,
      dir: splitPath(file.path).dir,
    }));
  }

  const groups = new Map<string, ChangedFile[]>();

  for (const f of sorted) {
    const { dir } = splitPath(f.path);
    const list = groups.get(dir);

    if (list) list.push(f);
    else groups.set(dir, [f]);
  }

  const rows: ChangeRow[] = [];

  for (const dir of [...groups.keys()].sort(comparePaths)) {
    const list = groups.get(dir)!;

    if (dir !== "") {
      const t = totals(list);
      const collapsed = opts.collapsed?.has(dir) ?? false;
      rows.push({
        kind: "folder",
        key: `dir:${dir}`,
        dir,
        count: list.length,
        additions: t.additions,
        deletions: t.deletions,
        collapsed,
      });

      if (collapsed) continue;
    }

    for (const file of list) {
      rows.push({
        kind: "file",
        key: `file:${file.path}`,
        file,
        depth: dir === "" ? 0 : 1,
        label: splitPath(file.path).name,
        dir,
      });
    }
  }

  return rows;
};

/** The container is up and answers read calls (getChanges, getFileDiff, listFiles, readFile, searchFiles). */
export const isLive = (state: WorkspaceState | undefined): boolean =>
  state === "ready" || state === "working" || state === "setting_up";

/** The container is on its way up; read calls would return CONTAINER_NOT_READY. */
export const isComingUp = (state: WorkspaceState | undefined): boolean =>
  state === "creating" || state === "starting";

/**
 * Where the list comes from. `live`: getChanges. `loading`: the first getChanges is running.
 * `waking`: CONTAINER_NOT_READY (or the container is starting). `lastKnown`: no container, so the
 * last known summary from WorkspaceDetail.changes or the last `changes` message. `error`: getChanges failed.
 */
export type ChangesSource = "live" | "loading" | "waking" | "lastKnown" | "error";

export interface ChangesViewInput {
  readonly state: WorkspaceState | undefined;
  readonly scope: "branch" | "uncommitted";
  readonly data: { readonly files: ReadonlyArray<ChangedFile> } | undefined;
  readonly errorCode: string | null;
  readonly lastKnown: ChangesSummary | null;
}

export interface ChangesView {
  readonly source: ChangesSource;
  readonly files: ReadonlyArray<ChangedFile>;
  /** False while there is nothing to show yet: render skeleton rows. */
  readonly hasList: boolean;
}

const EMPTY: ReadonlyArray<ChangedFile> = [];

export const changesView = (i: ChangesViewInput): ChangesView => {
  // The last known summary is branch scope (02, `changes` message).
  const fallback = i.lastKnown?.files ?? null;
  const branchFallback = i.scope === "branch" ? fallback : null;

  if (!isLive(i.state)) {
    if (isComingUp(i.state)) return { source: "waking", files: fallback ?? EMPTY, hasList: true };

    return { source: "lastKnown", files: fallback ?? EMPTY, hasList: true };
  }

  if (i.errorCode === "CONTAINER_NOT_READY") {
    return { source: "waking", files: i.data?.files ?? fallback ?? EMPTY, hasList: true };
  }

  if (i.data) return { source: i.errorCode ? "error" : "live", files: i.data.files, hasList: true };

  if (i.errorCode)
    return { source: "error", files: branchFallback ?? EMPTY, hasList: branchFallback !== null };

  return { source: "loading", files: branchFallback ?? EMPTY, hasList: branchFallback !== null };
};
