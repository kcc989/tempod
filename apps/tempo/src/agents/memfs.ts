import { Schema } from "effect";
/**
 * The smallest promise file system isomorphic-git needs, held in memory for one save
 * (01, Custom agents: no container takes part).
 */

type Node = { kind: "file"; data: Uint8Array; mtimeMs: number } | { kind: "dir"; mtimeMs: number };

const fsError = (code: string, path: string): Error => Object.assign(new Error(`${code}: ${path}`), { code });

const norm = (path: string): string => {
  const parts: string[] = [];

  for (const p of path.split("/")) {
    if (p === "" || p === ".") continue;

    if (p === "..") parts.pop();
    else parts.push(p);
  }

  return `/${parts.join("/")}`;
};

const parentOf = (path: string): string => norm(path.slice(0, path.lastIndexOf("/")) || "/");

const statOf = (node: Node, ino: number) => {
  const isDir = node.kind === "dir";

  return {
    type: isDir ? "dir" : "file",
    mode: isDir ? 0o40755 : 0o100644,
    size: isDir ? 0 : node.data.byteLength,
    ino,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
  };
};

export const memoryFs = () => {
  const nodes = new Map<string, Node>([["/", { kind: "dir", mtimeMs: Date.now() }]]);
  const inodes = new Map<string, number>();

  const ino = (path: string): number => {
    if (!inodes.has(path)) inodes.set(path, inodes.size + 1);

    return inodes.get(path)!;
  };

  const get = (path: string): Node => {
    const node = nodes.get(norm(path));

    if (!node) throw fsError("ENOENT", path);

    return node;
  };

  const requireParent = (path: string): void => {
    const parent = nodes.get(parentOf(norm(path)));

    if (!parent) throw fsError("ENOENT", path);

    if (parent.kind !== "dir") throw fsError("ENOTDIR", path);
  };

  const promises = {
    async readFile(path: string, opts?: { encoding?: string } | string): Promise<Uint8Array | string> {
      const node = get(path);

      if (node.kind !== "file") throw fsError("EISDIR", path);
      const encoding = Schema.is(Schema.String)(opts) ? opts : opts?.encoding;

      return encoding === "utf8" ? new TextDecoder().decode(node.data) : node.data;
    },
    async writeFile(path: string, data: Uint8Array | string): Promise<void> {
      requireParent(path);
      const bytes = Schema.is(Schema.String)(data) ? new TextEncoder().encode(data) : new Uint8Array(data);
      nodes.set(norm(path), { kind: "file", data: bytes, mtimeMs: Date.now() });
    },
    async unlink(path: string): Promise<void> {
      if (get(path).kind !== "file") throw fsError("EISDIR", path);
      nodes.delete(norm(path));
    },
    async readdir(path: string): Promise<string[]> {
      const dir = norm(path);

      if (get(dir).kind !== "dir") throw fsError("ENOTDIR", path);
      const prefix = dir === "/" ? "/" : `${dir}/`;

      return [...nodes.keys()].flatMap((p) =>
        p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes("/")
          ? [p.slice(prefix.length)]
          : [],
      );
    },
    async mkdir(path: string): Promise<void> {
      if (nodes.has(norm(path))) throw fsError("EEXIST", path);
      requireParent(path);
      nodes.set(norm(path), { kind: "dir", mtimeMs: Date.now() });
    },
    async rmdir(path: string): Promise<void> {
      if (get(path).kind !== "dir") throw fsError("ENOTDIR", path);

      if ((await promises.readdir(path)).length > 0) throw fsError("ENOTEMPTY", path);
      nodes.delete(norm(path));
    },
    async stat(path: string) {
      return statOf(get(path), ino(norm(path)));
    },
    async lstat(path: string) {
      return statOf(get(path), ino(norm(path)));
    },
    async readlink(path: string): Promise<string> {
      throw fsError("EINVAL", path);
    },
    async symlink(_target: string, path: string): Promise<void> {
      throw fsError("EPERM", path);
    },
    async chmod(): Promise<void> {},
  };

  return { promises };
};
