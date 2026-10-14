import { expect, test } from "@playwright/test";
import { requireChannels, rpc, rpcFails, rpcRetry } from "./lib/api.ts";
import { WorkspaceWatch } from "./lib/channels.ts";
import { ENABLED, SKIP_REASON, env } from "./lib/env.ts";
import {
  allowOption,
  answerPermissionsUntilEnd,
  cleanupTest,
  readySession,
  trackWorkspace,
} from "./lib/flows.ts";
import { sh } from "./lib/terminal.ts";
import { nonce, waitFor } from "./lib/util.ts";

/**
 * Native forge demo (09, 10): create an Artifacts repository, build something in a workspace,
 * run project CI, open a Tempo pull request and merge it behind the CI gate.
 */

test.skip(!ENABLED, SKIP_REASON);

test.afterEach(cleanupTest);

const PIPELINE = `version: 1
jobs:
  test:
    name: Tests
    run: node --test
required: [test]
`;

const BUILD_PROMPT =
  "Create a small Node.js module in this repository: `slug.js` exports `slugify(text)`, which lowercases, " +
  "trims and joins words with single hyphens, and drops characters other than a-z and 0-9. " +
  "Add `slug.test.js` with node:test cases, and a short README.md. Use no dependencies. " +
  "Run `node --test` and make it pass. Do not commit.";

const SLUG_JS = `export const slugify = (text) =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
`;

const SLUG_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./slug.js";

test("slugify joins words with hyphens", () => {
  assert.equal(slugify("  Hello, Tempo World! "), "hello-tempo-world");
});
`;

/** Without TEMPO_E2E_DEMO_AGENT the files are written through the terminal, so no agent login is needed. */
const build = async (watch: WorkspaceWatch): Promise<void> => {
  const agent = env("TEMPO_E2E_DEMO_AGENT");

  if (agent === "claude" || agent === "codex") {
    const sessionId = await readySession(watch, agent);

    const turn = await rpc("sendPrompt", {
      workspaceId: watch.workspaceId,
      sessionId,
      text: BUILD_PROMPT,
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    });

    const { turn: ended } = await answerPermissionsUntilEnd(watch, turn.id, async (req) => {
      const option = allowOption(req);
      await rpc("respondPermission", {
        workspaceId: watch.workspaceId,
        requestId: req.requestId,
        optionId: option.optionId,
      });
    });

    expect(ended.status).toBe("completed");

    return;
  }

  await sh(
    watch.workspaceId,
    [
      `cat > package.json <<'EOF'\n{ "name": "slug", "type": "module", "private": true }\nEOF`,
      `cat > slug.js <<'EOF'\n${SLUG_JS}EOF`,
      `cat > slug.test.js <<'EOF'\n${SLUG_TEST_JS}EOF`,
      `printf '# slug\\n\\nBuilt in a Tempo workspace.\\n' > README.md`,
    ].join("\n"),
  );
};

const ciRunFor = (projectId: string, branch: string, sha: string) =>
  waitFor(
    `a completed CI run for ${branch} at ${sha.slice(0, 7)}`,
    async () => {
      const runs = await rpc("listCiRuns", { projectId, branch });
      const run = runs.find((r) => r.sha === sha);

      return run?.status === "completed" ? run : undefined;
    },
    20 * 60_000,
    5_000,
  );

test("forge demo: create a repo, build, run CI, open a PR and merge it", async () => {
  test.setTimeout(60 * 60_000);
  await requireChannels();
  const tag = nonce();

  const project = await rpc("createRepository", {
    name: `tempo-demo-${tag}`,
    description: "Tempo forge demo",
  });

  expect(project.provider).toBe("artifacts");
  const projectId = project.id;
  const base = project.defaultBranch;

  const empty = await rpc("getRepository", { projectId });
  expect(empty.empty).toBe(true);

  const pipeline = await rpc("updateCiPipeline", { projectId, source: PIPELINE, revision: 0 });
  expect(pipeline.enabled).toBe(true);
  expect(pipeline.required).toEqual(["test"]);

  // Empty repository: the workspace bootstraps the base branch (09, initializeEmpty).
  const summary = await rpc("createWorkspace", { projectId, source: { kind: "new", baseBranch: base } });
  trackWorkspace(summary.id);
  const workspaceId = summary.id;
  const watch = await WorkspaceWatch.open(workspaceId);
  await watch.waitState(["ready"], 15 * 60_000);

  await build(watch);
  expect(await sh(workspaceId, "node --test 2>&1 | tail -n 20")).toMatch(/# fail 0/);

  const { commitSha } = await rpcRetry("commitAndPush", { workspaceId, message: "Add slugify module" });
  expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
  const branch = (await rpc("getWorkspace", { workspaceId })).branch;

  // The push is ingested (10, Ingestion): an automatic run for the exact commit.
  const run = await ciRunFor(projectId, branch, commitSha);
  expect(run.trigger).toBe("push");
  expect(run.conclusion).toBe("success");
  const detail = await rpc("getCiRun", { projectId, runId: run.id });
  expect(detail.jobs.map((j) => [j.key, j.conclusion])).toEqual([["test", "success"]]);
  const log = await rpc("getCiJobLog", { projectId, runId: run.id, job: "test" });
  expect(log.text).toMatch(/# pass [1-9]/);

  const pr = await rpc("createPullRequest", {
    workspaceId,
    title: "Add slugify module",
    body: "Built and checked in Tempo.",
    draft: false,
  });

  expect(pr.url).toContain(`project=${projectId}`);
  const opened = await rpc("getRepositoryPullRequest", { projectId, number: pr.number });
  expect([opened.state, opened.headBranch, opened.baseBranch, opened.headSha]).toEqual([
    "open",
    branch,
    base,
    commitSha,
  ]);

  const checks = await rpc("listCheckRuns", { workspaceId });
  expect(checks.map((c) => [c.name, c.conclusion])).toEqual([["Tests", "success"]]);

  await rpcRetry("mergePullRequest", { workspaceId, method: "squash" });
  const merged = await rpc("getRepositoryPullRequest", { projectId, number: pr.number });
  expect(merged.state).toBe("merged");
  expect(merged.mergeSha).toMatch(/^[0-9a-f]{40}$/);
  expect(
    (await rpcFails("updateRepositoryPullRequest", { projectId, number: pr.number, state: "open" })).code,
  ).toBe("PR_NOT_MERGEABLE");

  const history = await rpc("listRepositoryCommits", { projectId, ref: base });
  expect(history[0]?.hash).toBe(merged.mergeSha);
  const repo = await rpc("getRepository", { projectId, ref: base });
  expect(repo.entries.map((e) => e.path)).toEqual(expect.arrayContaining(["slug.js", "slug.test.js"]));

  // The merge commit is ingested for the base branch too.
  const mainRun = await ciRunFor(projectId, base, merged.mergeSha ?? "");
  expect(mainRun.conclusion).toBe("success");

  watch.close();
});
