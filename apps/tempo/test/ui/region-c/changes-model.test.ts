import type { ChangedFile } from "@tempo/protocol";
import { describe, expect, it } from "vitest";
import {
  changeRows,
  changesView,
  isComingUp,
  isLive,
  splitPath,
  statusLabel,
  statusLetter,
  totals,
} from "~/ui/components/review/changes-model";

const f = (path: string, status = "M", additions = 1, deletions = 0, oldPath?: string): ChangedFile =>
  oldPath ? { path, oldPath, status, additions, deletions } : { path, status, additions, deletions };

describe("status letters (04, Changes tab)", () => {
  it("shows A, M, D and R", () => {
    expect(["A", "M", "D", "R"].map(statusLetter)).toEqual(["A", "M", "D", "R"]);
    expect(statusLetter("R100")).toBe("R");
    expect(statusLetter("")).toBe("M");
    expect(statusLabel("D")).toBe("Deleted");
    expect(statusLabel("U")).toBe("Changed");
  });
});

describe("splitPath and totals", () => {
  it("splits a path into folder and name", () => {
    expect(splitPath("src/ui/a.ts")).toEqual({ dir: "src/ui", name: "a.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });

  it("adds up lines", () => {
    expect(totals([f("a", "M", 3, 1), f("b", "A", 2, 0)])).toEqual({ files: 2, additions: 5, deletions: 1 });
    expect(totals([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});

describe("changeRows: Group by folder", () => {
  const files = [f("src/b.ts"), f("README.md"), f("src/a.ts", "A", 4, 0), f("docs/x/y.md", "D", 0, 9)];

  it("lists files by path when not grouped", () => {
    const rows = changeRows(files, { grouped: false });
    expect(rows.map((r) => r.key)).toEqual([
      "file:README.md",
      "file:docs/x/y.md",
      "file:src/a.ts",
      "file:src/b.ts",
    ]);
    expect(rows.every((r) => r.kind === "file" && r.depth === 0 && r.label === r.file.path)).toBe(true);
  });

  it("puts top-level files first, then one row per folder with its files", () => {
    const rows = changeRows(files, { grouped: true });
    expect(rows.map((r) => (r.kind === "folder" ? `[${r.dir}]` : r.label))).toEqual([
      "README.md",
      "[docs/x]",
      "y.md",
      "[src]",
      "a.ts",
      "b.ts",
    ]);
    const src = rows.find((r) => r.kind === "folder" && r.dir === "src");
    expect(src).toMatchObject({ count: 2, additions: 5, deletions: 0, collapsed: false });
    const nested = rows.find((r) => r.kind === "file" && r.file.path === "src/a.ts");
    expect(nested).toMatchObject({ depth: 1, dir: "src" });
  });

  it("hides the files of a collapsed folder but keeps its row", () => {
    const rows = changeRows(files, { grouped: true, collapsed: new Set(["src"]) });
    expect(rows.map((r) => r.key)).toEqual(["file:README.md", "dir:docs/x", "file:docs/x/y.md", "dir:src"]);
    expect(rows[3]).toMatchObject({ kind: "folder", collapsed: true });
  });

  it("keeps the old path of a rename", () => {
    const [row] = changeRows([f("b.ts", "R", 0, 0, "a.ts")], { grouped: false });
    expect(row?.kind === "file" && row.file.oldPath).toBe("a.ts");
  });
});

describe("changesView: where the list comes from", () => {
  const lastKnown = { files: [f("old.ts")], additions: 1, deletions: 0 };
  const live = { files: [f("new.ts")] };

  it("uses getChanges while the container is up", () => {
    expect(isLive("ready") && isLive("working") && isLive("setting_up")).toBe(true);
    const v = changesView({ state: "ready", scope: "branch", data: live, errorCode: null, lastKnown });
    expect(v).toMatchObject({ source: "live", hasList: true });
    expect(v.files.map((x) => x.path)).toEqual(["new.ts"]);
  });

  it("shows the last known summary while sleeping, in any scope", () => {
    for (const scope of ["branch", "uncommitted"] as const) {
      const v = changesView({ state: "sleeping", scope, data: undefined, errorCode: null, lastKnown });
      expect(v.source).toBe("lastKnown");
      expect(v.files.map((x) => x.path)).toEqual(["old.ts"]);
    }
    expect(
      changesView({ state: "archived", scope: "branch", data: undefined, errorCode: null, lastKnown: null }),
    ).toMatchObject({ source: "lastKnown", files: [], hasList: true });
  });

  it("shows CONTAINER_NOT_READY and a starting container as waking", () => {
    expect(isComingUp("starting") && isComingUp("creating") && !isComingUp("ready")).toBe(true);
    expect(
      changesView({
        state: "ready",
        scope: "branch",
        data: undefined,
        errorCode: "CONTAINER_NOT_READY",
        lastKnown,
      }),
    ).toMatchObject({ source: "waking", hasList: true });
    expect(
      changesView({ state: "starting", scope: "uncommitted", data: undefined, errorCode: null, lastKnown })
        .source,
    ).toBe("waking");
  });

  it("shows skeletons while loading, except branch scope with a last known list", () => {
    expect(
      changesView({ state: "ready", scope: "uncommitted", data: undefined, errorCode: null, lastKnown }),
    ).toMatchObject({ source: "loading", hasList: false });
    const branch = changesView({
      state: "ready",
      scope: "branch",
      data: undefined,
      errorCode: null,
      lastKnown,
    });
    expect(branch).toMatchObject({ source: "loading", hasList: true });
    expect(branch.files.map((x) => x.path)).toEqual(["old.ts"]);
  });

  it("reports other errors", () => {
    expect(
      changesView({
        state: "ready",
        scope: "uncommitted",
        data: undefined,
        errorCode: "INTERNAL",
        lastKnown,
      }),
    ).toMatchObject({ source: "error", hasList: false });
    expect(
      changesView({ state: "ready", scope: "branch", data: live, errorCode: "INTERNAL", lastKnown }).source,
    ).toBe("error");
  });
});
