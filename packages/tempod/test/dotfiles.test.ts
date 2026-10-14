import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupDirs,
  DoClient,
  git,
  startTempod,
  testConfig,
  tmpDir,
  writeFile,
  type Harness,
} from "./helpers.ts";

afterAll(cleanupDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const x of harnesses.splice(0)) await x.close();
});

const T = 60_000;

/** A bare dotfiles remote plus a work clone that commits complete snapshots to `main`. */
const makeRemote = async () => {
  const root = tmpDir("dotfiles-");
  const bare = join(root, "dotfiles.git");
  const seed = join(root, "seed");
  await git(root, "init", "-q", "--bare", "-b", "main", bare);
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  await git(seed, "config", "user.email", "seed@example.com");
  await git(seed, "config", "user.name", "Seed");
  await git(seed, "remote", "add", "origin", bare);

  const commit = async (files: Record<string, string>, links: Record<string, string> = {}) => {
    await git(seed, "rm", "-q", "-r", "--ignore-unmatch", "--cached", ".");

    for (const [path, content] of Object.entries(files)) writeFile(join(seed, path), content);

    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(seed, path));
    await git(seed, "add", "--", ...Object.keys(files), ...Object.keys(links));
    await git(seed, "commit", "-q", "--allow-empty", "-m", "snapshot");
    await git(seed, "push", "-q", "-f", "origin", "main");

    return git(seed, "rev-parse", "HEAD");
  };

  return { url: `file://${bare}`, commit };
};

const boot = async () => {
  const defaults = tmpDir("home-defaults-");
  writeFile(join(defaults, ".zshrc"), "default zshrc\n");
  writeFile(join(defaults, ".tmux.conf"), "default tmux\n");
  const h = startTempod(testConfig({ homeDefaults: defaults }));
  harnesses.push(h);
  const c = new DoClient(h.base);
  await c.hello();
  const home = h.config.home;
  writeFile(join(home, ".zshrc"), "default zshrc\n");
  writeFile(join(home, ".tmux.conf"), "default tmux\n");
  const read = (path: string) => readFileSync(join(home, path), "utf8");
  const record = () => JSON.parse(readFileSync(join(h.config.stateDir, "dotfiles.json"), "utf8"));

  return { c, home, read, record, stateDir: h.config.stateDir };
};

describe("dotfiles.apply", () => {
  test(
    "copies a commit into home, records it, and gives the same result again",
    async () => {
      const remote = await makeRemote();
      const sha = await remote.commit({ ".zshrc": "mine\n", ".config/starship.toml": "x = 1\n" });
      const { c, read, record, home } = await boot();

      const first = await c.ok("dotfiles.apply", { source: { url: remote.url, sha } }, T);
      expect(first).toEqual({ applied: [".config/starship.toml", ".zshrc"], restored: [] });
      expect(read(".zshrc")).toBe("mine\n");
      expect(read(".config/starship.toml")).toBe("x = 1\n");
      expect(read(".tmux.conf")).toBe("default tmux\n");
      expect(record()).toEqual({ paths: [".config/starship.toml", ".zshrc"] });

      writeFileSync(join(home, ".zshrc"), "edited in the container\n");
      const again = await c.ok("dotfiles.apply", { source: { url: remote.url, sha } }, T);
      expect(again).toEqual(first);
      expect(read(".zshrc")).toBe("mine\n");
    },
    T,
  );

  test(
    "restores the default or deletes a path the next commit drops",
    async () => {
      const remote = await makeRemote();
      const one = await remote.commit({ ".zshrc": "mine\n", ".inputrc": "set bell-style none\n" });
      const two = await remote.commit({ ".tmux.conf": "set -g mouse on\n" });
      const { c, read, record, home } = await boot();

      await c.ok("dotfiles.apply", { source: { url: remote.url, sha: one } }, T);
      const r = await c.ok("dotfiles.apply", { source: { url: remote.url, sha: two } }, T);

      expect(r).toEqual({ applied: [".tmux.conf"], restored: [".inputrc", ".zshrc"] });
      expect(read(".zshrc")).toBe("default zshrc\n");
      expect(existsSync(join(home, ".inputrc"))).toBe(false);
      expect(read(".tmux.conf")).toBe("set -g mouse on\n");
      expect(record()).toEqual({ paths: [".tmux.conf"] });
    },
    T,
  );

  test(
    "with a null source restores every recorded path and clears the record",
    async () => {
      const remote = await makeRemote();
      const sha = await remote.commit({ ".zshrc": "mine\n", "bin/hello": "#!/bin/sh\n" });
      const { c, read, home, stateDir } = await boot();

      await c.ok("dotfiles.apply", { source: { url: remote.url, sha } }, T);
      const r = await c.ok("dotfiles.apply", { source: null }, T);

      expect(r).toEqual({ applied: [], restored: [".zshrc", "bin/hello"] });
      expect(read(".zshrc")).toBe("default zshrc\n");
      expect(existsSync(join(home, "bin/hello"))).toBe(false);
      expect(existsSync(join(stateDir, "dotfiles.json"))).toBe(false);
      expect(await c.ok("dotfiles.apply", { source: null }, T)).toEqual({ applied: [], restored: [] });
    },
    T,
  );

  test(
    "never writes reserved paths, symlinks, or through a symlinked folder",
    async () => {
      const remote = await makeRemote();
      const outside = tmpDir("outside-");

      const sha = await remote.commit(
        { ".zshrc": "mine\n", ".ssh/config": "Host *\n", ".tempod/dotfiles.json": "{}", "link/x": "x\n" },
        { ".profile": "/etc/passwd" },
      );

      const { c, read, home, record } = await boot();
      symlinkSync(outside, join(home, "link"));

      const r = await c.ok("dotfiles.apply", { source: { url: remote.url, sha } }, T);

      expect(r.applied).toEqual([".zshrc"]);
      expect(read(".zshrc")).toBe("mine\n");
      expect(existsSync(join(home, ".ssh/config"))).toBe(false);
      expect(existsSync(join(home, ".profile"))).toBe(false);
      expect(existsSync(join(outside, "x"))).toBe(false);
      expect(record()).toEqual({ paths: [".zshrc"] });
      expect(statSync(join(home, ".zshrc")).isFile()).toBe(true);
    },
    T,
  );

  test(
    "rejects a commit that is not a full sha and changes nothing",
    async () => {
      const remote = await makeRemote();
      await remote.commit({ ".zshrc": "mine\n" });
      const { c, read } = await boot();

      const r = await c.reqRaw("dotfiles.apply", { source: { url: remote.url, sha: "main" } }, T);

      expect(r.ok ? null : r.error.code).toBe("VALIDATION_FAILED");
      expect(read(".zshrc")).toBe("default zshrc\n");
    },
    T,
  );
});
