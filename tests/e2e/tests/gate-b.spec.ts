import { Schema } from "effect";
import { expect, test } from "@playwright/test";
import type { PermissionRequest, WorkspaceSummary } from "@tempo/protocol";
import { fetchApp, requireChannels, rpc, rpcFails, rpcRaw, rpcRetry } from "./lib/api.ts";
import { WorkspaceWatch } from "./lib/channels.ts";
import { ENABLED, SKIP_REASON, TARGET } from "./lib/env.ts";
import {
  allowOption,
  answerPermissionsUntilEnd,
  cleanupFile,
  cleanupTest,
  firstTurn,
  newWorkspace,
  promptAndWait,
  readySession,
  sendPrompt,
  testProject,
  turnCheckpoint,
  withProjectSettings,
} from "./lib/flows.ts";
import { sh, stopContainerFromInside, workingTreeHash } from "./lib/terminal.ts";
import { choosePermission, openWorkspace, requireUi } from "./lib/ui.ts";
import { nonce } from "./lib/util.ts";

/** Gate B: phase 1 (06, Acceptance tests AT-1 to AT-8). */

test.skip(!ENABLED, SKIP_REASON);

test.afterEach(cleanupTest);

test.afterAll(cleanupFile);

/** A long answer, so a turn is still streaming when the test acts on it. */
const longAnswer = (tag: string, lines: number): string =>
  `e2e-${tag}: write the lines "Line 1 ${tag}" through "Line ${lines} ${tag}", one per line, with no other text.`;

test.describe("AT-1 owner sign-in", () => {
  test("AT-1 the owner's session is accepted and a request without a session gets UNAUTHENTICATED", async () => {
    const session = await fetchApp("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(
        Schema.Union([
          Schema.Struct({ user: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String) })) }),
          Schema.Null,
        ]),
      )(session.json)?.user?.id,
    ).toBeTruthy();
    await rpc("listProjects", {});
    const anonymous = await rpcRaw("listProjects", {}, { token: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.json).toMatchObject({ code: "UNAUTHENTICATED", message: "Sign in to continue." });
  });

  test("AT-1 (browser) the owner's session opens the app", async ({ page }) => {
    requireUi();
    await page.goto("/");
    await expect(page.getByText("History", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("This Tempo belongs to someone else.")).toHaveCount(0);
  });

  // Manual: GitHub sign-in needs real GitHub credentials (password, 2FA, device checks) for the
  // owner and for a second account, which cannot be scripted against github.com. Steps:
  // 1. In a fresh browser profile open TEMPO_E2E_URL and sign in with GitHub as the owner: the app opens.
  // 2. In another fresh profile sign in as a different GitHub account: the page shows
  //    "This Tempo belongs to someone else." and GET /api/auth/get-session in that profile returns null.
  test.fixme("AT-1 GitHub sign-in: the owner gets in, a different GitHub account is refused with the owner message", async () => {});
});

test("AT-2 link a repo, create a workspace with a prompt: first agent output under 120 s, branch tempo/<slug> in the container", async () => {
  await requireChannels();
  const project = await testProject();

  if (project.installationId === null || project.repoId === null)
    throw new Error("AT-2 requires a GitHub-linked test project.");
  const repos = await rpc("listInstallationRepos", { installationId: project.installationId });
  expect(repos.map((r) => r.repoId)).toContain(project.repoId);

  const again = await rpcFails("linkProject", {
    installationId: project.installationId,
    repoId: project.repoId,
  });

  expect(again.code).toBe("PROJECT_EXISTS");

  const tag = nonce();

  const { summary, watch, startedAt } = await newWorkspace({
    prompt: `e2e-${tag}: reply with one short sentence that contains the word ${tag}.`,
  });

  expect(summary.branch).toBe(`tempo/${summary.slug}`);
  const turn = firstTurn(watch);

  const firstOutput = await watch.until(
    "the first agent output",
    () => watch.firstAgentOutputAt(),
    Math.max(1_000, startedAt + TARGET.firstAgentOutputMs - Date.now()),
  );

  expect(firstOutput - startedAt).toBeLessThan(TARGET.firstAgentOutputMs);

  const ended = await watch.waitTurnEnded(turn.id, 10 * 60_000);
  expect(ended.status).toBe("completed");
  expect(watch.agentText({ turnId: turn.id })).toContain(tag);

  expect((await sh(summary.id, "git branch --show-current")).trim()).toBe(`tempo/${summary.slug}`);
});

test.describe("AT-3 live streaming and reload", () => {
  test("AT-3 agent text streams live; a reconnect from scratch mid-turn gets the full transcript and the stream continues", async () => {
    await requireChannels();
    const tag = nonce();
    const { summary, watch } = await newWorkspace({ prompt: longAnswer(tag, 300) });
    const turn = firstTurn(watch);

    const streaming = await watch.until(
      "an agent message that streams live",
      () =>
        watch.itemsOf("agent_message", { turnId: turn.id }).find((i) => (watch.deltas.get(i.id) ?? 0) >= 3),
      10 * 60_000,
    );

    const textOf = (w: WorkspaceWatch): string => {
      const item = w.items.get(streaming.id);

      return item?.kind === "agent_message" ? item.content.text : "";
    };

    const before = textOf(watch);
    expect(watch.turns.get(turn.id)?.status, "the turn must still be running when the page reloads").toBe(
      "running",
    );

    // A page reload is a new connection with sinceRev=0.
    const reloaded = await WorkspaceWatch.open(summary.id, 0);
    expect(reloaded.itemsOf("user_message", { turnId: turn.id })).toHaveLength(1);
    const backlog = textOf(reloaded);
    expect(backlog.startsWith(before)).toBe(true);
    await reloaded.until(
      "the stream to continue after the reload",
      () => (reloaded.deltas.get(streaming.id) ?? 0) > 0 || textOf(reloaded).length > backlog.length,
      5 * 60_000,
    );

    const [a, b] = await Promise.all([
      watch.waitTurnEnded(turn.id, 15 * 60_000),
      reloaded.waitTurnEnded(turn.id, 15 * 60_000),
    ]);

    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    // Both connections end with the same text: nothing lost or repeated across the reload.
    expect(reloaded.agentText({ turnId: turn.id })).toBe(watch.agentText({ turnId: turn.id }));
    expect(watch.agentText({ turnId: turn.id })).toContain(`Line 1 ${tag}`);
  });

  test("AT-3 (browser) reloading the page mid-turn shows the full transcript and the stream continues", async ({
    page,
  }) => {
    requireUi();
    await requireChannels();
    const tag = nonce();
    const { summary, watch } = await newWorkspace({ prompt: longAnswer(tag, 300) });
    const turn = firstTurn(watch);

    await openWorkspace(page, summary.title);
    await expect(page.getByText(`Line 3 ${tag}`).first()).toBeVisible({ timeout: 10 * 60_000 });
    expect(watch.turns.get(turn.id)?.status, "the turn must still be running when the page reloads").toBe(
      "running",
    );

    await page.reload();
    await expect(page.getByText(`e2e-${tag}`).first()).toBeVisible();
    await expect(page.getByText(`Line 3 ${tag}`).first()).toBeVisible();

    const ended = await watch.waitTurnEnded(turn.id, 15 * 60_000);
    expect(ended.status).toBe("completed");

    const numbers = [
      ...watch.agentText({ turnId: turn.id }).matchAll(new RegExp(`Line (\\d+) ${tag}`, "g")),
    ].map((m) => Number(m[1]));

    const last = Math.max(...numbers);
    expect(last).toBeGreaterThan(3);
    await expect(page.getByText(`Line ${last} ${tag}`).first()).toBeVisible();
  });
});

test.describe("AT-4 tool calls and plan-mode permissions", () => {
  const planModeTurn = async (opts: {
    onReady?: (summary: WorkspaceSummary) => Promise<void>;
    choose: (req: PermissionRequest, watch: WorkspaceWatch) => Promise<void>;
  }): Promise<{ tag: string }> => {
    const tag = nonce();
    const { summary, watch } = await newWorkspace();
    const sessionId = await readySession(watch, "claude", { modeId: "plan" });

    const session = await watch.until(
      "the session to start with its modes",
      () => {
        const s = watch.sessions.get(sessionId);

        return s && s.status === "idle" && s.modes.length > 0 ? s : undefined;
      },
      5 * 60_000,
    );

    expect(session.modes.map((m) => m.id)).toContain("plan");
    expect(session.modeId).toBe("plan");
    await opts.onReady?.(summary);

    const turn = await sendPrompt(
      watch,
      sessionId,
      `e2e-${tag}: create a file named e2e-plan-${tag}.txt that contains the single line ${tag}. ` +
        "Make a short plan first, then leave plan mode and create the file.",
    );

    const { turn: ended, answered } = await answerPermissionsUntilEnd(watch, turn.id, (req) =>
      opts.choose(req, watch),
    );

    expect(answered.length, "plan mode asks for permission before it acts").toBeGreaterThan(0);
    expect(watch.attentions.some((a) => a.attention === "needs_input")).toBe(true);
    expect(ended.status).toBe("completed");

    for (const req of answered) {
      const item = watch.items.get(req.itemId);
      expect(item?.kind).toBe("permission");

      if (item?.kind === "permission") expect(item.content.chosenOptionId).toBeTruthy();
    }

    const tools = watch.itemsOf("tool_call", { turnId: turn.id });
    expect(tools.length).toBeGreaterThan(0);
    // Live status: some tool call was seen in a non-final status before it completed.
    expect(
      tools.some((t) => {
        const seen = watch.toolStatuses.get(t.id) ?? [];

        return seen.length >= 2 && seen.at(-1) === "completed";
      }),
    ).toBe(true);
    const file = await rpcRetry("readFile", { workspaceId: summary.id, path: `e2e-plan-${tag}.txt` });
    expect(file.content).toContain(tag);
    expect(watch.attentions.at(-1)?.attention).not.toBe("needs_input");

    return { tag };
  };

  test("AT-4 tool calls carry live status; a plan-mode permission request is approved and the turn continues", async () => {
    await requireChannels();
    await planModeTurn({
      choose: async (req, watch) => {
        await rpc("respondPermission", {
          workspaceId: watch.workspaceId,
          requestId: req.requestId,
          optionId: allowOption(req).optionId,
        });
      },
    });
  });

  test("AT-4 (browser) tool calls render and a plan-mode permission request is approved from the UI", async ({
    page,
  }) => {
    requireUi();
    await requireChannels();

    const { tag } = await planModeTurn({
      onReady: (summary) => openWorkspace(page, summary.title),
      choose: async (req) => {
        await choosePermission(page, allowOption(req).name);
      },
    });

    await expect(page.getByText(`e2e-plan-${tag}.txt`).first()).toBeVisible();
  });
});

test.describe("AT-5 checkpoints", () => {
  test("AT-5 a turn that changed files creates a checkpoint; a turn with no change reuses it; listCheckpoints returns it", async () => {
    await requireChannels();
    const tag = nonce();
    const { summary, watch } = await newWorkspace();
    const sessionId = await readySession(watch);

    await sh(summary.id, `printf '%s\\n' ${tag} > e2e-checkpoint-${tag}.txt`);
    const t1 = await promptAndWait(watch, sessionId, "Reply with exactly: OK");
    expect(t1.status).toBe("completed");
    const c1 = await turnCheckpoint(watch, t1.id);
    const list1 = await rpc("listCheckpoints", { workspaceId: summary.id });
    expect(list1.find((c) => c.id === c1)).toMatchObject({
      turnId: t1.id,
      turnSeq: t1.seq,
      reason: "turn_end",
    });

    const t2 = await promptAndWait(
      watch,
      sessionId,
      "Reply with exactly: OK. Do not run any tools and do not change any files.",
    );

    expect(t2.status).toBe("completed");
    expect(await turnCheckpoint(watch, t2.id)).toBe(c1);
    const list2 = await rpc("listCheckpoints", { workspaceId: summary.id });
    const turnEnd = (list: typeof list1) => list.filter((c) => c.reason === "turn_end").map((c) => c.id);
    expect(turnEnd(list2)).toEqual(turnEnd(list1));
  });

  // Manual: no API lists R2. After the test above (with TEMPO_E2E_KEEP=1), run
  //   wrangler r2 object get tempo-data/checkpoints/<workspaceId>/<checkpointId>.bundle --remote --file ckpt.bundle
  //   git bundle list-heads ckpt.bundle
  // and expect refs/tempo/checkpoints/<checkpointId>. AT-8 covers the bundle indirectly: the fresh
  // path can only rebuild the working tree from it.
  test.fixme("AT-5 each new checkpoint has its bundle in R2 at checkpoints/<workspaceId>/<checkpointId>.bundle", async () => {});
});

test("AT-6 an idle workspace sleeps after 5 minutes; a prompt wakes it from the snapshot in under 30 s and the agent remembers", async () => {
  test.setTimeout(50 * 60_000);
  await requireChannels();
  const restore = await withProjectSettings({ environment: { sleep_after_idle_minutes: 5 } });

  try {
    const tag = nonce();
    const word = `word${tag}`;

    const { summary, watch } = await newWorkspace({
      prompt: `e2e-${tag}: remember the code word ${word}. Reply with exactly: OK`,
    });

    const t1 = await watch.waitTurnEnded(firstTurn(watch).id, 10 * 60_000);
    expect(t1.status).toBe("completed");
    await watch.until(
      "sleep_after_idle_minutes = 5 in the effective settings",
      () => watch.detail?.settings.environment.sleep_after_idle_minutes === 5,
      5 * 60_000,
    );

    const asleep = await watch.waitState(["sleeping"], 25 * 60_000);
    const sleptAt = watch.stateSince(["sleeping"], 0)?.at ?? Date.now();
    expect(sleptAt - asleep.lastActivityAt).toBeGreaterThanOrEqual(5 * 60_000);
    const slept = await rpc("getDiagnostics", { workspaceId: summary.id });
    expect(slept.container.running).toBe(false);
    expect(slept.container.snapshots.some((s) => !s.unusable)).toBe(true);

    const wakeAt = Date.now();

    const t2 = await sendPrompt(
      watch,
      t1.sessionId,
      "What is the code word I asked you to remember? Reply with the word only.",
    );

    const awake = await watch.until(
      "the workspace to wake",
      () => watch.stateSince(["ready", "working"], wakeAt),
      10 * 60_000,
    );

    expect(awake.at - wakeAt).toBeLessThan(TARGET.wakeFromSnapshotMs);
    expect(watch.stateSince(["setting_up"], wakeAt), "a wake from a snapshot runs no setup").toBeUndefined();

    const ended = await watch.waitTurnEnded(t2.id, 10 * 60_000);
    expect(ended.status).toBe("completed");
    expect(watch.agentText({ turnId: t2.id })).toContain(word);

    const woke = await rpc("getDiagnostics", { workspaceId: summary.id });
    expect(
      woke.container.snapshots.some((s) => s.lastRestoredAt !== null && s.lastRestoredAt >= wakeAt),
    ).toBe(true);
    const wake = woke.ops.find((o) => o.kind === "wake" && o.createdAt >= wakeAt);
    expect(wake?.timings["repo.clone"], "a wake from a snapshot does not clone").toBeUndefined();
  } finally {
    await restore();
  }
});

test.describe("AT-7 container lost mid-turn", () => {
  test("AT-7 stopping the container mid-turn marks the turn interrupted, shows a notice, wakes the workspace, and the next prompt works", async () => {
    await requireChannels();
    const tag = nonce();
    const { summary, watch } = await newWorkspace({ prompt: longAnswer(tag, 400) });
    const turn = firstTurn(watch);
    await watch.until(
      "the turn running with agent output",
      () => watch.turns.get(turn.id)?.status === "running" && watch.firstAgentOutputAt() !== undefined,
      10 * 60_000,
    );

    const stoppedAt = await stopContainerFromInside(summary.id);
    const ended = await watch.waitTurnEnded(turn.id, 10 * 60_000);
    expect(ended.status).toBe("interrupted");

    const notice = await watch.until(
      "a notice about the interruption",
      () => watch.itemsOf("notice").find((n) => (watch.firstSeenAt.get(n.id) ?? 0) >= stoppedAt),
      3 * 60_000,
    );

    expect(notice.content.text.length).toBeGreaterThan(0);

    await watch.until("the workspace to wake", () => watch.stateSince(["starting"], stoppedAt), 10 * 60_000);
    await watch.waitState(["ready"], 20 * 60_000);
    const next = await promptAndWait(watch, turn.sessionId, `Reply with exactly: AFTER-${tag}`);
    expect(next.status).toBe("completed");
    expect(watch.agentText({ turnId: next.id })).toContain(`AFTER-${tag}`);
  });

  // Manual: the test above stops tempod from inside the container, the closest scripted stand-in.
  // The literal step needs the Cloudflare dashboard (Workers & Pages → Containers → the
  // workspace's instance → Stop/Destroy) while a long turn runs; then check the same four outcomes:
  // turn `interrupted`, a notice item, the workspace wakes on its own, and the next prompt completes.
  test.fixme("AT-7 destroying the container from the Cloudflare dashboard mid-turn", async () => {});
});

test.describe("AT-8 fresh path", () => {
  test("AT-8 with no usable snapshot a wake takes the fresh path: the working tree equals the last checkpoint and the session reloads or hands off", async () => {
    test.setTimeout(45 * 60_000);
    await requireChannels();
    const tag = nonce();
    const word = `word${tag}`;
    const { summary, watch } = await newWorkspace();
    const sessionId = await readySession(watch);

    await sh(
      summary.id,
      [
        `printf '%s\\n' ${tag} > e2e-fresh-${tag}.txt`,
        "f=$(git ls-files | head -n 1)",
        `printf 'e2e %s\\n' ${tag} >> "$f"`,
      ].join("\n"),
    );

    const t1 = await promptAndWait(
      watch,
      sessionId,
      `Remember the code word ${word}. Reply with exactly: OK`,
    );

    expect(t1.status).toBe("completed");
    const checkpointId = await turnCheckpoint(watch, t1.id);

    const tree = (
      await sh(summary.id, `git rev-parse 'refs/tempo/checkpoints/${checkpointId}^{tree}'`)
    ).trim();

    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(await workingTreeHash(summary.id)).toBe(tree);

    const before = await rpc("getDiagnostics", { workspaceId: summary.id });
    expect(
      before.container.snapshots.filter((s) => !s.unusable),
      "the workspace never slept, so no usable snapshot exists",
    ).toHaveLength(0);

    const stoppedAt = await stopContainerFromInside(summary.id);

    const starting = await watch.until(
      "the wake to start",
      () => watch.stateSince(["starting"], stoppedAt),
      10 * 60_000,
    );

    const settingUp = await watch.until(
      "the fresh path to reach setup",
      () => watch.stateSince(["setting_up"], starting.at) ?? watch.stateSince(["ready"], starting.at),
      15 * 60_000,
    );

    expect(settingUp.state, "a fresh disk always passes setting_up").toBe("setting_up");

    const setupRun = [...watch.scriptRuns.values()].find(
      (r) => r.kind === "setup" && (watch.scriptRunSeenAt.get(r.id) ?? 0) >= starting.at,
    );

    const ready = await watch.waitState(["ready"], 30 * 60_000);

    const beforeSetup = setupRun
      ? (watch.scriptRunSeenAt.get(setupRun.id) ?? Date.now())
      : (watch.stateSince(["ready"], starting.at)?.at ?? Date.now());

    expect(beforeSetup - starting.at, "fresh wake to ready, before setup").toBeLessThan(
      TARGET.freshWakeBeforeSetupMs,
    );
    expect(ready.state).toBe("ready");

    const after = await rpc("getDiagnostics", { workspaceId: summary.id });
    const wake = after.ops.find((o) => o.kind === "wake" && o.createdAt >= stoppedAt);
    expect(wake?.timings["repo.clone"], "the wake cloned the repo").toBeDefined();

    expect(await workingTreeHash(summary.id)).toBe(tree);
    const file = await rpcRetry("readFile", { workspaceId: summary.id, path: `e2e-fresh-${tag}.txt` });
    expect(file.content).toBe(`${tag}\n`);

    const t2 = await promptAndWait(
      watch,
      sessionId,
      "What is the code word I asked you to remember? Reply with the word only.",
    );

    expect(t2.status).toBe("completed");
    expect(watch.agentText({ turnId: t2.id })).toContain(word);
    test.info().annotations.push({
      type: "session",
      description: watch.itemsOf("handoff", { sessionId }).length > 0 ? "handed off" : "reloaded",
    });
  });

  // Manual: no API marks a snapshot `unusable`. To run the literal case: create a workspace with a
  // turn that changes files, let it sleep (AT-6), then redeploy with a rebuilt image (any change to
  // container/), which makes every snapshot unusable because its imageRef no longer matches. Send a
  // prompt: the workspace passes `setting_up`, the tree hash (see workingTreeHash in
  // lib/terminal.ts) equals `git rev-parse refs/tempo/checkpoints/<last>^{tree}`, and the turn
  // completes with either a `handoff` item or none (reloaded).
  test.fixme("AT-8 with the snapshot marked unusable (after an image change), a wake takes the fresh path", async () => {});
});
