import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insideRoots } from "../src/fs.ts";
import { cleanupDirs, DoClient, git, startTempod, tmpDir, writeFile, type Harness } from "./helpers.ts";

afterAll(cleanupDirs);

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const MiB = 1024 * 1024;

const setup = async () => {
  h = startTempod();
  const c = new DoClient(h.base);
  await c.hello();
  await c.waitEvent("incarnation.changed");
  const ws = h.config.workspace;
  await git(ws, "init", "-q", "-b", "main");
  return { c, ws, h: h! };
};

describe("insideRoots", () => {
  test("follows symlinks, including dangling ones, to where a write would land", () => {
    const root = tmpDir("roots-");
    const ws = join(root, "ws");
    const outside = join(root, "outside");
    mkdirSync(join(ws, "sub"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(ws, "out-dir"));
    symlinkSync(join(outside, "missing.txt"), join(ws, "dangling-out"));
    symlinkSync(join(ws, "sub", "later.txt"), join(ws, "dangling-in"));
    symlinkSync("sub/../../outside/x", join(ws, "relative-out"));
    symlinkSync(join(ws, "loop-b"), join(ws, "loop-a"));
    symlinkSync(join(ws, "loop-a"), join(ws, "loop-b"));
    expect(insideRoots([ws], join(ws, "sub", "new.txt"))).toBe(join(ws, "sub", "new.txt"));
    expect(insideRoots([ws], join(ws, "a", "b", "c.txt"))).toBe(join(ws, "a", "b", "c.txt"));
    expect(insideRoots([ws], join(ws, "dangling-in"))).toBe(join(ws, "dangling-in"));
    expect(insideRoots([ws], join(ws, "out-dir", "f.txt"))).toBeNull();
    expect(insideRoots([ws], join(ws, "dangling-out"))).toBeNull();
    expect(insideRoots([ws], join(ws, "relative-out"))).toBeNull();
    expect(insideRoots([ws], join(ws, "..", "outside", "f"))).toBeNull();
    expect(insideRoots([ws], "relative/path")).toBeNull();
    expect(insideRoots([ws, outside], join(ws, "dangling-out"))).toBe(join(ws, "dangling-out"));
    expect(typeof insideRoots([ws], join(ws, "loop-a"))).toBe("string");
  });
});

describe("fs.list, fs.read, fs.search", () => {
  test("fs.list: tracked plus untracked, not ignored", async () => {
    const { c, ws } = await setup();
    writeFileSync(join(ws, ".gitignore"), "dist/\n*.log\n");
    writeFile(join(ws, "src", "a.ts"), "a\n");
    await git(ws, "add", "-A");
    writeFile(join(ws, "src", "b.ts"), "b\n");
    writeFile(join(ws, "dist", "out.js"), "x\n");
    writeFileSync(join(ws, "debug.log"), "x\n");
    const r = await c.ok<{ paths: string[] }>("fs.list", {});
    expect(r.paths.sort()).toEqual([".gitignore", "src/a.ts", "src/b.ts"]);
  });

  test("fs.read: utf8 text, base64 for binary and invalid UTF-8, with the size", async () => {
    const { c, ws } = await setup();
    writeFileSync(join(ws, "a.txt"), "héllo\n");
    writeFileSync(join(ws, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(ws, "latin1.txt"), Buffer.from([0x68, 0xe9, 0x6c]));
    expect(await c.ok<unknown>("fs.read", { path: "a.txt", maxBytes: MiB })).toEqual({ content: "héllo\n", encoding: "utf8", size: 7 });
    expect(await c.ok<unknown>("fs.read", { path: join(ws, "a.txt"), maxBytes: MiB })).toMatchObject({ encoding: "utf8" });
    expect(await c.ok<unknown>("fs.read", { path: "bin.dat", maxBytes: MiB })).toEqual({ content: "AAEC/w==", encoding: "base64", size: 4 });
    expect(await c.ok<unknown>("fs.read", { path: "latin1.txt", maxBytes: MiB })).toEqual({ content: "aOls", encoding: "base64", size: 3 });
  });

  test("fs.read: FILE_TOO_LARGE over maxBytes, and when the encoded answer would pass 1 MiB", async () => {
    const { c, ws } = await setup();
    writeFileSync(join(ws, "big.txt"), "x".repeat(2000));
    expect(await c.req("fs.read", { path: "big.txt", maxBytes: 1000 })).toMatchObject({ ok: false, error: { code: "FILE_TOO_LARGE" } });
    writeFileSync(join(ws, "blob.bin"), Buffer.alloc(900 * 1024, 0));
    expect(await c.req("fs.read", { path: "blob.bin", maxBytes: MiB })).toMatchObject({ ok: false, error: { code: "FILE_TOO_LARGE" } });
    writeFileSync(join(ws, "escapes.txt"), "\u0001".repeat(300 * 1024));
    expect(await c.req("fs.read", { path: "escapes.txt", maxBytes: MiB })).toMatchObject({ ok: false, error: { code: "FILE_TOO_LARGE" } });
    writeFileSync(join(ws, "fits.txt"), "y".repeat(900 * 1024));
    const ok = await c.req("fs.read", { path: "fits.txt", maxBytes: MiB });
    expect(ok.ok).toBe(true);
  });

  test("fs.read: PATH_OUTSIDE_WORKSPACE for escapes, also through symlinks; NOT_FOUND for missing files and folders", async () => {
    const { c, ws } = await setup();
    const outside = tmpDir("outside-");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
    symlinkSync(join(outside, "nothing-yet.txt"), join(ws, "dangling.txt"));
    mkdirSync(join(ws, "folder"));
    for (const path of ["../x.txt", "/etc/passwd", "link.txt", "dangling.txt", join(outside, "secret.txt")]) {
      expect(await c.req("fs.read", { path, maxBytes: MiB })).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE" } });
    }
    expect(await c.req("fs.read", { path: "missing.txt", maxBytes: MiB })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await c.req("fs.read", { path: "folder", maxBytes: MiB })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("fs.search: literal and regex, capped at maxResults, ignored files skipped", async () => {
    const { c, ws } = await setup();
    writeFileSync(join(ws, ".gitignore"), "dist/\n");
    writeFile(join(ws, "src", "a.ts"), "const needle = 1;\nconst other = 2;\nneedle();\n");
    writeFile(join(ws, "src", "b.ts"), "// a.b needle\n");
    writeFile(join(ws, "dist", "c.js"), "needle\n");
    const lit = await c.ok<{ matches: Array<{ path: string; line: number; text: string }> }>("fs.search", {
      query: "needle",
      regex: false,
      maxResults: 50,
    });
    const found = lit.matches.map((m) => `${m.path}:${m.line}:${m.text}`).sort();
    expect(found).toEqual(["src/a.ts:1:const needle = 1;", "src/a.ts:3:needle();", "src/b.ts:1:// a.b needle"]);
    const dot = await c.ok<{ matches: unknown[] }>("fs.search", { query: "a.b", regex: false, maxResults: 50 });
    expect(dot.matches).toHaveLength(1);
    const re = await c.ok<{ matches: Array<{ path: string }> }>("fs.search", { query: "^const \\w+ = 2", regex: true, maxResults: 50 });
    expect(re.matches.map((m) => m.path)).toEqual(["src/a.ts"]);
    const capped = await c.ok<{ matches: unknown[] }>("fs.search", { query: "needle", regex: false, maxResults: 2 });
    expect(capped.matches).toHaveLength(2);
    const bad = await c.req("fs.search", { query: "(", regex: true, maxResults: 5 });
    expect(bad).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await c.ok<unknown>("fs.search", { query: "", regex: false, maxResults: 5 })).toEqual({ matches: [] });
  });
});

describe("settings.read", () => {
  test("resolves overrides and files; a later file change sends settings.changed", async () => {
    const { c, ws, h } = await setup();
    writeFile(join(ws, ".tempo", "settings.toml"), '[scripts]\nsetup = "bun install"\n');
    writeFileSync(join(ws, "conductor.json"), JSON.stringify({ scripts: { archive: "echo bye" }, spotlight_testing: true }));
    const r = await c.ok<{ effective: { scripts: { setup: string; archive: string }; agent: { default: string } }; warnings: string[] }>(
      "settings.read",
      { overrides: { agent: { default: "codex" } } },
    );
    expect(r.effective.scripts.setup).toBe("bun install");
    expect(r.effective.scripts.archive).toBe("echo bye");
    expect(r.effective.agent.default).toBe("codex");
    expect(r.warnings.join("\n")).toContain("spotlight_testing");
    await h.app.refresh();
    expect(c.of("settings.changed")).toHaveLength(0);
    writeFile(join(ws, ".tempo", "settings.toml"), '[scripts]\nsetup = "npm ci"\n');
    await h.app.refresh();
    const changed = await c.waitEvent("settings.changed");
    expect(changed.effective.scripts.setup).toBe("npm ci");
    expect(changed.effective.agent.default).toBe("codex");
  });
});
