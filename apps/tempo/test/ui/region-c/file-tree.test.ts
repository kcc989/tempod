import { describe, expect, it } from "vitest";
import { ancestors, buildTree, parentRowIndex, treeRows } from "~/ui/components/review/file-tree";

const PATHS = [
  "src/ui/App.tsx",
  "src/ui/app.css",
  "src/main.ts",
  "README.md",
  "a.txt",
  "java/com/acme/Main.java",
  "java/com/acme/Util.java",
];

const names = (rows: ReturnType<typeof treeRows>) => rows.map((r) => `${"  ".repeat(r.depth)}${r.name}`);

describe("file tree from listFiles (04, All files)", () => {
  const tree = buildTree(PATHS);

  it("shows top-level folders first, then files, by name", () => {
    expect(names(treeRows(tree, new Set()))).toEqual(["java/com/acme", "src", "a.txt", "README.md"]);
  });

  it("joins a chain of folders that hold nothing else", () => {
    const rows = treeRows(tree, new Set(["java/com/acme"]));
    expect(rows[0]).toMatchObject({
      kind: "dir",
      path: "java/com/acme",
      name: "java/com/acme",
      expanded: true,
    });
    expect(names(rows).slice(0, 3)).toEqual(["java/com/acme", "  Main.java", "  Util.java"]);
    expect(rows[1]).toMatchObject({ kind: "file", path: "java/com/acme/Main.java" });
  });

  it("shows children only of expanded folders", () => {
    expect(names(treeRows(tree, new Set(["src"])))).toEqual([
      "java/com/acme",
      "src",
      "  ui",
      "  main.ts",
      "a.txt",
      "README.md",
    ]);
    expect(names(treeRows(tree, new Set(["src", "src/ui"])))).toContain("    App.tsx");
  });

  it("finds the folder row above a row", () => {
    const rows = treeRows(tree, new Set(["src", "src/ui"]));
    const app = rows.findIndex((r) => r.path === "src/ui/App.tsx");
    expect(rows[parentRowIndex(rows, app)!]?.path).toBe("src/ui");
    expect(parentRowIndex(rows, 0)).toBeNull();
  });

  it("lists the folders above a path", () => {
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestors("c.ts")).toEqual([]);
  });

  it("handles 50,000 paths", () => {
    const many = Array.from({ length: 50_000 }, (_, i) => `d${i % 100}/e${i % 7}/f${i}.ts`);
    const big = buildTree(many);
    const rows = treeRows(big, new Set(["d1"]));
    expect(rows.filter((r) => r.depth === 0)).toHaveLength(100);
    expect(rows.filter((r) => r.depth === 1)).toHaveLength(7);
  });
});
