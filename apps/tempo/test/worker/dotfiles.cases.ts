import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOTFILES, TempoError } from "@tempo/protocol";
import {
  ZERO_SHA,
  buildCommit,
  buildPack,
  buildTree,
  gitObject,
  parseReportStatus,
  pktLine,
  receivePackBody,
} from "../../src/artifacts/git-writer.ts";
import type { Env } from "../../src/env.ts";
import { decide, type EgressConfig } from "../../src/egress/rules.ts";
import { dotfilesRepoName, getDotfiles, updateDotfiles } from "../../src/server/handlers/dotfiles.ts";
import { decodeInput, type HandlerCtx } from "../../src/server/run.ts";
import { artifactMetadata, fakeArtifactRepo, fakeArtifacts, fakeGitRemote } from "./artifacts-fake.ts";
import { seedProject } from "./fakes.ts";
import { seedReadyWorkspace } from "./ready-fixture.ts";

const utf8 = new TextEncoder();

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const caught = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;

    return "OK";
  } catch (e) {
    return e instanceof TempoError ? e.code : String(e);
  }
};

afterEach(() => vi.unstubAllGlobals());

describe("Git writer (01, Shell and dotfiles)", () => {
  it("hashes blobs, nested trees and commits exactly as git does", async () => {
    // Expected values come from `git hash-object`, `git write-tree` and `git commit-tree`.
    expect((await gitObject("blob", new Uint8Array())).sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect((await buildTree([])).root).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");

    // "foo.txt" sorts before the tree "foo" ('.' < '/'), and "foo" before "foo0" ('/' < '0').
    const tree = await buildTree([
      { path: "foo0", content: "x" },
      { path: "foo/sub/.keep", content: "" },
      { path: "foo.txt", content: "hello\n" },
      { path: ".zshrc", content: "export A=1\n" },
      { path: "foo/bar", content: "bar" },
    ]);

    expect(tree.root).toBe("58257eaf10012d515fa7890bb9f9c37d8f3d651b");
    expect(tree.objects.map((o) => o.sha)).toContain("8c928dcb0d4b23c489c51920ca2f3195979868e4");

    const author = { name: "Ada", email: "ada@example.com" };
    const at = 1_700_000_000_000;

    const first = await buildCommit({
      tree: tree.root,
      parent: null,
      author,
      message: "Update shell files",
      at,
    });

    expect(first.sha).toBe("1fec2ef05dd0627f7ab93a13a50be99405d93b64");

    const second = await buildCommit({
      tree: tree.root,
      parent: first.sha,
      author,
      message: "Update shell files",
      at,
    });

    expect(second.sha).toBe("1d6ce5b70a0c7942c8944e9bd36f939c78eb6dd3");
    // A name cannot inject a header line.

    const hostile = await buildCommit({
      tree: tree.root,
      parent: null,
      author: { name: "A\nparent x <b>", email: "a@b>\n" },
      message: "m",
      at,
    });

    expect(new TextDecoder().decode(hostile.body).split("\n").slice(1, 3)).toEqual([
      "author Aparent x b <a@b> 1700000000 +0000",
      "committer Aparent x b <a@b> 1700000000 +0000",
    ]);
  });

  it("frames a v2 pack with whole objects and a SHA-1 trailer, and a receive-pack request", async () => {
    const big = await gitObject("blob", utf8.encode("x".repeat(70_000)));
    const small = await gitObject("blob", utf8.encode("hi"));
    const pack = await buildPack([small, big]);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");
    const view = new DataView(pack.buffer);
    expect([view.getUint32(4), view.getUint32(8)]).toEqual([2, 2]);
    // Object header: type 3 (blob) in bits 4-6, size 2 in the low 4 bits, no continuation.
    expect(pack[12]).toBe(0x32);
    const body = pack.subarray(0, pack.length - 20);
    expect(hex(pack.subarray(pack.length - 20))).toBe(
      hex(new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(body)))),
    );

    expect(new TextDecoder().decode(pktLine("unpack ok\n"))).toBe("000eunpack ok\n");
    const request = receivePackBody({ old: ZERO_SHA, next: small.sha, ref: "refs/heads/main" }, pack);
    const head = new TextDecoder().decode(request.subarray(0, 0x74 + 4));
    expect(head).toBe(`0074${ZERO_SHA} ${small.sha} refs/heads/main\0report-status\n0000`);
    expect(request.length).toBe(0x74 + 4 + pack.length);
    expect(hex(request.subarray(request.length - pack.length))).toBe(hex(pack));
  });

  it("reads report-status: ok, a rejected (stale) update, and a failed unpack", () => {
    const report = (...lines: string[]) =>
      new Uint8Array([...lines.map(pktLine).flatMap((l) => [...l]), 48, 48, 48, 48]);

    const ref = "refs/heads/main";
    expect(parseReportStatus(report("unpack ok\n", `ok ${ref}\n`), ref)).toEqual({ ok: true });
    expect(parseReportStatus(report("unpack ok\n", `ng ${ref} stale info\n`), ref)).toEqual({
      ok: false,
      reason: "stale info",
    });
    expect(() =>
      parseReportStatus(report("unpack index-pack failed\n", `ng ${ref} unpacker error\n`), ref),
    ).toThrow(TempoError);
    expect(() => parseReportStatus(utf8.encode("zzzz"), ref)).toThrow(TempoError);
  });
});

const dotfilesFixture = async () => {
  const seeded = await seedProject();
  const name = await dotfilesRepoName(seeded.userId);
  const info = artifactMetadata(name);
  const remote = fakeGitRemote(info);
  const created: string[] = [];
  const revoked: string[] = [];
  const issued: Array<"read" | "write"> = [];
  let exists = false;

  const repo = fakeArtifactRepo(info, {
    createToken: async (scope = "write", ttl = 600) => {
      issued.push(scope);

      return {
        id: `t-${scope}`,
        plaintext: `art_${scope}`,
        scope,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    },
    revokeToken: async (token) => {
      revoked.push(token);

      return true;
    },
    readCommit: remote.readCommit,
    readTree: remote.readTree,
    readBlob: remote.readBlob,
  });

  const binding = fakeArtifacts(
    async (n) => {
      if (n !== name || !exists) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });

      return repo;
    },
    {
      create: async (n) => {
        if (exists) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
        exists = true;
        created.push(n);

        return { ...info, token: "art_initial" };
      },
    },
  );

  vi.stubGlobal("fetch", remote.fetch);
  const testEnv: Env = { ...env, ARTIFACTS: binding };

  const ctx: HandlerCtx = {
    env: testEnv,
    user: { id: seeded.userId, name: "Owner", email: "owner@example.com", image: null },
  };

  return { ctx, seeded, name, info, remote, created, revoked, issued, setExists: () => (exists = true) };
};

const row = (userId: string) =>
  env.DB.prepare("SELECT * FROM dotfiles WHERE user_id = ?").bind(userId).first<{
    artifact_repo_id: string;
    repo_name: string;
    clone_url: string;
    head_sha: string;
    updated_at: number;
  }>();

describe("getDotfiles and updateDotfiles (02, Shell and dotfiles)", () => {
  it("returns the defaults until the first save, then round-trips a full snapshot through Artifacts", async () => {
    const f = await dotfilesFixture();
    expect(await getDotfiles(f.ctx, {})).toEqual({
      files: DEFAULT_DOTFILES,
      defaults: DEFAULT_DOTFILES,
      saved: false,
      updatedAt: null,
    });

    const files = [
      { path: ".config/git/ignore", content: "*.log\n" },
      { path: ".zshrc", content: "alias ll='ls -la'\n" },
    ];

    const saved = await updateDotfiles(f.ctx, { files });
    // The first save creates the repository and revokes its creation token (09).
    expect(f.created).toEqual([f.name]);
    expect(f.revoked).toEqual(["art_initial"]);
    expect(f.remote.pushes).toEqual([
      {
        authorization: "Bearer art_write",
        old: ZERO_SHA,
        next: expect.stringMatching(/^[a-f0-9]{40}$/),
        ref: "refs/heads/main",
      },
    ]);
    const head = f.remote.refs.get("refs/heads/main")!;
    expect(await row(f.seeded.userId)).toMatchObject({
      artifact_repo_id: f.info.id,
      repo_name: f.name,
      clone_url: f.info.remote,
      head_sha: head,
    });
    expect(saved).toMatchObject({ saved: true, files: [files[1], files[0]] });
    expect(await getDotfiles(f.ctx, {})).toEqual(saved);
    const commit = (await f.remote.readCommit(head))!;
    expect(commit.parents).toEqual([]);

    // The next save builds on the stored head and replaces the whole list.
    await updateDotfiles(f.ctx, { files: [files[1]!] });
    const next = f.remote.refs.get("refs/heads/main")!;
    expect((await f.remote.readCommit(next))!.parents).toEqual([head]);
    expect((await getDotfiles(f.ctx, {})).files).toEqual([files[1]]);
    expect(f.created).toHaveLength(1);
  });

  it("fails with DOTFILES_CHANGED and changes nothing when the stored head is stale", async () => {
    const f = await dotfilesFixture();
    await updateDotfiles(f.ctx, { files: [{ path: ".zshrc", content: "one\n" }] });
    const before = await row(f.seeded.userId);
    // Another save moved main after this row was read.
    f.remote.refs.set("refs/heads/main", "1".repeat(40));
    expect(await caught(updateDotfiles(f.ctx, { files: [{ path: ".zshrc", content: "two\n" }] }))).toBe(
      "DOTFILES_CHANGED",
    );
    expect(await row(f.seeded.userId)).toEqual(before);
    expect(f.remote.refs.get("refs/heads/main")).toBe("1".repeat(40));

    // A save that pushed but lost its D1 write: Reload adopts the tip, and the next save succeeds.
    f.remote.refs.set("refs/heads/main", before!.head_sha);
    await updateDotfiles(f.ctx, { files: [{ path: ".zshrc", content: "three\n" }] });
    const pushed = f.remote.refs.get("refs/heads/main")!;
    await env.DB.prepare("UPDATE dotfiles SET head_sha = ? WHERE user_id = ?")
      .bind(before!.head_sha, f.seeded.userId)
      .run();
    expect(await caught(updateDotfiles(f.ctx, { files: [{ path: ".zshrc", content: "four\n" }] }))).toBe(
      "DOTFILES_CHANGED",
    );
    const reloaded = await getDotfiles(f.ctx, {});
    expect(reloaded.files.find((x) => x.path === ".zshrc")?.content).toBe("three\n");
    expect((await row(f.seeded.userId))?.head_sha).toBe(pushed);
    await updateDotfiles(f.ctx, { files: [{ path: ".zshrc", content: "four\n" }] });
    expect((await f.remote.readCommit(f.remote.refs.get("refs/heads/main")!))!.parents).toEqual([pushed]);
  });

  it("reuses an existing repository on the first save and builds on its tip", async () => {
    const f = await dotfilesFixture();
    f.setExists();
    const earlier = await updateDotfiles(f.ctx, { files: [{ path: ".zshrc", content: "lost row\n" }] });
    const tip = f.remote.refs.get("refs/heads/main")!;
    // The D1 write was lost after the push: the retry must not need a new repository or overwrite history.
    await env.DB.prepare("DELETE FROM dotfiles WHERE user_id = ?").bind(f.seeded.userId).run();
    await updateDotfiles(f.ctx, { files: [{ path: ".zshrc", content: "retry\n" }] });
    expect(earlier.saved).toBe(true);
    expect(f.created).toEqual([]);
    expect((await f.remote.readCommit(f.remote.refs.get("refs/heads/main")!))!.parents).toEqual([tip]);
  });

  it("rejects invalid lists with VALIDATION_FAILED before touching Artifacts", async () => {
    const f = await dotfilesFixture();

    for (const files of [
      [{ path: ".ssh/config", content: "" }],
      [{ path: "../etc/passwd", content: "" }],
      Array.from({ length: 21 }, (_, i) => ({ path: `f${i}`, content: "" })),
    ])
      expect(() => decodeInput("updateDotfiles", { files })).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );

    for (const files of [
      [
        { path: ".zshrc", content: "a" },
        { path: ".zshrc", content: "b" },
      ],
      [
        { path: ".config", content: "a" },
        { path: ".config/x", content: "b" },
      ],
      [{ path: ".zshrc", content: "x".repeat(64 * 1024 + 1) }],
    ])
      expect(await caught(updateDotfiles(f.ctx, { files }))).toBe("VALIDATION_FAILED");
    expect(f.created).toEqual([]);
    expect(f.remote.pushes).toEqual([]);
  });
});

describe("dotfiles egress (09, Git transport)", () => {
  const host = `${"a".repeat(32)}.artifacts.cloudflare.net`;
  const dotfilesRemote = `https://${host}/git/tempo-repos/dotfiles-0123456789abcdef.git`;

  const config: EgressConfig = {
    owner: "acme",
    repo: "app",
    provider: "github",
    policy: "open",
    allowlist: [],
    mcp: [],
    dotfiles: { cloneUrl: dotfilesRemote },
  };

  const decision = (url: string, c: EgressConfig = config) =>
    decide(new URL(url), new Headers(), "tempo.test", c);

  it("gives only the read side of the owner's dotfiles remote its read credential", () => {
    for (const suffix of ["/info/refs?service=git-upload-pack", "/git-upload-pack"])
      expect(decision(dotfilesRemote + suffix)).toEqual({
        rule: 2,
        action: "forward",
        set: { name: "authorization", value: "dotfiles-bearer" },
      });

    for (const url of [
      `${dotfilesRemote}/git-receive-pack`,
      `${dotfilesRemote}/info/refs?service=git-receive-pack`,
      `${dotfilesRemote}/info/refs`,
      dotfilesRemote,
      `https://${host}/git/tempo-repos/dotfiles-0123456789abcdef0.git/git-upload-pack`,
      `https://${host}/git/tempo-repos/other.git/git-upload-pack`,
      `https://${host}:444/git/tempo-repos/dotfiles-0123456789abcdef.git/git-upload-pack`,
      dotfilesRemote.replace("https:", "http:") + "/git-upload-pack",
    ])
      expect(decision(url), url).toEqual({ rule: 8, action: "forward" });
    expect(decision(`${dotfilesRemote}/git-upload-pack`, { ...config, dotfiles: null })).toEqual({
      rule: 8,
      action: "forward",
    });
  });

  it("puts the owner's dotfiles remote, and no one else's, in the workspace egress config", async () => {
    const w = await seedReadyWorkspace();
    const other = await seedProject();

    const insert = (userId: string, repo: string) =>
      env.DB.prepare(
        "INSERT INTO dotfiles (user_id, artifact_repo_id, repo_name, clone_url, head_sha, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          userId,
          `id-${repo}`,
          repo,
          `https://${host}/git/tempo-repos/${repo}.git`,
          "9".repeat(40),
          Date.now(),
        )
        .run();

    const stub = w.stub;
    await insert(other.userId, `dotfiles-${other.userId.slice(0, 8)}`);
    expect((await stub.getEgressConfig()).dotfiles).toBeNull();
    expect(await stub.getDotfilesToken()).toBeNull();
    await insert(w.seeded.userId, "dotfiles-owner");
    expect((await stub.getEgressConfig()).dotfiles).toEqual({
      cloneUrl: `https://${host}/git/tempo-repos/dotfiles-owner.git`,
    });
  });
});
