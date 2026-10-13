import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, isDocsOnly } from "./ci-changes.ts";

const repos: string[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});

const repository = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tempo-ci-changes-"));
  repos.push(cwd);
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "CI test",
        GIT_AUTHOR_EMAIL: "ci@example.test",
        GIT_COMMITTER_NAME: "CI test",
        GIT_COMMITTER_EMAIL: "ci@example.test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) throw new Error(stderr);
    return stdout.trim();
  };
  await git("init", "-q");
  await Bun.write(join(cwd, "README.md"), "Initial documentation\n");
  await Bun.write(join(cwd, "code.ts"), "export const value = 1;\n");
  await git("add", ".");
  await git("commit", "-qm", "initial");
  return { cwd, git, base: await git("rev-parse", "HEAD") };
};

describe("CI documentation-only classification", () => {
  it("allows repository docs and their images, but fails closed on code, configuration and fixtures", () => {
    expect(isDocsOnly(["README.md", "AGENTS.md", "docs/CI.md", "docs/screenshot.png", "spikes/S1.md"])).toBe(
      true,
    );
    for (const file of [
      "package.json",
      "bun.lock",
      ".github/workflows/ci.yml",
      "docs/example.ts",
      "packages/tempod/test/fixtures/README.md",
      "apps/tempo/src/ui/App.tsx",
    ])
      expect(isDocsOnly(["docs/CI.md", file])).toBe(false);
    expect(isDocsOnly([])).toBe(false);
  });

  it("compares all commits since the base, including deleted documentation", async () => {
    const { cwd, git, base } = await repository();
    await rm(join(cwd, "README.md"));
    await Bun.write(join(cwd, "docs/CI.md"), "CI documentation\n");
    await git("add", ".");
    await git("commit", "-qm", "docs");
    const files = await changedFiles(base, cwd);
    expect(files).toEqual(["README.md", "docs/CI.md"]);
    expect(isDocsOnly(files!)).toBe(true);
    await Bun.write(join(cwd, "code.ts"), "export const value = 2;\n");
    await git("add", ".");
    await git("commit", "-qm", "code");
    expect(isDocsOnly((await changedFiles(base, cwd))!)).toBe(false);
  });

  it("includes the code side of a rename into documentation", async () => {
    const { cwd, git, base } = await repository();
    await git("mv", "code.ts", "AGENTS.md");
    await git("commit", "-qm", "rename");
    const files = await changedFiles(base, cwd);
    expect(files).toContain("code.ts");
    expect(files).toContain("AGENTS.md");
    expect(isDocsOnly(files!)).toBe(false);
  });

  it("fetches a missing base in a shallow checkout before classifying", async () => {
    const { cwd, git, base } = await repository();
    await Bun.write(join(cwd, "README.md"), "Updated documentation\n");
    await git("add", ".");
    await git("commit", "-qm", "docs");
    const checkout = await mkdtemp(join(tmpdir(), "tempo-ci-shallow-"));
    repos.push(checkout);
    await git("clone", "--depth=1", `file://${cwd}`, checkout);
    const files = await changedFiles(base, checkout);
    expect(files).toEqual(["README.md"]);
    expect(isDocsOnly(files!)).toBe(true);
  });

  it("uses the full suite when the base is missing, invalid, unavailable or unchanged", async () => {
    const { cwd, base } = await repository();
    for (const sha of [undefined, "HEAD", "0".repeat(40), "a".repeat(40)])
      expect(await changedFiles(sha, cwd)).toBeNull();
    expect(isDocsOnly((await changedFiles(base, cwd))!)).toBe(false);
  });
});
