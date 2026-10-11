/** 04, All files tab: a tree from listFiles. */

export interface TreeDir {
  readonly name: string;
  /** "" for the root. */
  readonly path: string;
  readonly dirs: Map<string, TreeDir>;
  readonly files: string[];
}

const newDir = (name: string, path: string): TreeDir => ({ name, path, dirs: new Map(), files: [] });

export const buildTree = (paths: ReadonlyArray<string>): TreeDir => {
  const root = newDir("", "");
  for (const p of paths) {
    const parts = p.split("/").filter((s) => s !== "");
    if (parts.length === 0) continue;
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = dir.dirs.get(name);
      if (!next) {
        next = newDir(name, dir.path === "" ? name : `${dir.path}/${name}`);
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push(parts[parts.length - 1]!);
  }
  return root;
};

export interface TreeRow {
  readonly kind: "dir" | "file";
  readonly path: string;
  /** A folder chain with nothing else in it shows as one row: `src/main/java`. */
  readonly name: string;
  readonly depth: number;
  readonly expanded: boolean;
}

const byName = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Visible rows: folders first, then files, by name; only expanded folders show their children. */
export const treeRows = (root: TreeDir, expanded: ReadonlySet<string>): TreeRow[] => {
  const rows: TreeRow[] = [];
  const walk = (dir: TreeDir, depth: number) => {
    for (const name of [...dir.dirs.keys()].sort(byName)) {
      let node = dir.dirs.get(name)!;
      let label = node.name;
      while (node.files.length === 0 && node.dirs.size === 1) {
        node = node.dirs.values().next().value!;
        label = `${label}/${node.name}`;
      }
      const open = expanded.has(node.path);
      rows.push({ kind: "dir", path: node.path, name: label, depth, expanded: open });
      if (open) walk(node, depth + 1);
    }
    for (const name of [...dir.files].sort(byName)) {
      rows.push({
        kind: "file",
        path: dir.path === "" ? name : `${dir.path}/${name}`,
        name,
        depth,
        expanded: false,
      });
    }
  };
  walk(root, 0);
  return rows;
};

/** Every folder above a path: `a/b/c.ts` → `a`, `a/b`. */
export const ancestors = (path: string): string[] => {
  const parts = path.split("/").filter((s) => s !== "");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
};

/** The index of the folder row that holds row `index`, or null at the top level. */
export const parentRowIndex = (rows: ReadonlyArray<TreeRow>, index: number): number | null => {
  const depth = rows[index]?.depth ?? 0;
  if (depth === 0) return null;
  for (let i = index - 1; i >= 0; i--) if (rows[i]!.depth === depth - 1) return i;
  return null;
};
