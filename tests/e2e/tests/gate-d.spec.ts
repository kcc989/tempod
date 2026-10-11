import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { requireChannels, rpc, rpcFails, rpcRetry } from "./lib/api.ts";
import { HubWatch, WorkspaceWatch } from "./lib/channels.ts";
import { E2E, ENABLED, SKIP_REASON, TARGET, appHost, env, required } from "./lib/env.ts";
import {
  allowOption,
  answerPermissionsUntilEnd,
  cleanupFile,
  cleanupTest,
  firstTurn,
  newWorkspace,
  pollState,
  promptAndWait,
  readySession,
  withProjectSettings,
} from "./lib/flows.ts";
import { sh, workingTreeHash } from "./lib/terminal.ts";
import { choosePermission, composer, openWorkspace, requireUi, sendFromComposer } from "./lib/ui.ts";
import { leakedSecrets, nonce, sleep, waitFor } from "./lib/util.ts";

/** Gate D: phase 3 (06, Acceptance tests AT-17 to AT-22, and the credential grep). */

test.skip(!ENABLED, SKIP_REASON);
test.afterEach(cleanupTest);
test.afterAll(cleanupFile);

/** GitHub creates check runs a few seconds after a PR opens; Tempo then polls every 60 s (03). */
const CHECK_RUN_CREATION_MS = 15_000;
/** TempoOutbound caches the egress config for 60 s (01, TempoOutbound). */
const EGRESS_CONFIG_CACHE_MS = 65_000;

test.describe.serial("AT-17 and AT-18 pull requests", () => {
  // afterEach closes every socket, so AT-18 opens its own channels on the same workspace.
  let shared: { workspaceId: string } | null = null;

  test("AT-17 commit and push, then create a PR; the badge and checks state update within 60 s", async () => {
    await requireChannels();
    const tag = nonce();
    const { summary, watch } = await newWorkspace({ scope: "file" });
    const workspaceId = summary.id;
    await watch.waitState(["ready"], 15 * 60_000);

    // One fixed file, so repeated runs do not pile up files in the test repo.
    await sh(
      workspaceId,
      `mkdir -p e2e-tempo && printf 'Last e2e run: %s\\n' ${tag} > e2e-tempo/last-run.md`,
    );
    const { commitSha } = await rpcRetry("commitAndPush", { workspaceId, message: `e2e: run ${tag}` });
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    await watch.until("pushed", () => watch.detail?.pushed === true, 60_000);
    expect((await rpcFails("commitAndPush", { workspaceId, message: "e2e: nothing" })).code).toBe(
      "NOTHING_TO_COMMIT",
    );

    const hub = await HubWatch.open();
    shared = { workspaceId };
    const createdAt = Date.now();
    const pr = await rpc("createPullRequest", {
      workspaceId,
      title: `e2e: run ${tag}`,
      body: "Created by the Tempo e2e suite.",
      draft: false,
    });
    expect(pr.url).toContain(`/pull/${pr.number}`);
    expect(
      (await rpcFails("createPullRequest", { workspaceId, title: "again", body: "", draft: false })).code,
    ).toBe("PR_EXISTS");

    const badgeAt = await hub.until(
      "the PR badge",
      () => {
        const s = hub.summaries.get(workspaceId);
        return s?.prNumber === pr.number && s.prState === "open" ? Date.now() : undefined;
      },
      TARGET.prUpdateMs,
    );
    expect(badgeAt - createdAt).toBeLessThan(TARGET.prUpdateMs);

    // The repo's pull_request workflow must create check runs (README.md, test repo).
    const checksAt = await hub.until(
      "the checks state",
      () => (hub.summaries.get(workspaceId)?.checksState ? Date.now() : undefined),
      TARGET.prUpdateMs + CHECK_RUN_CREATION_MS,
    );
    expect(checksAt - createdAt).toBeLessThan(TARGET.prUpdateMs + CHECK_RUN_CREATION_MS);
    const final = await hub.until(
      "the checks to finish",
      () => {
        const c = hub.summaries.get(workspaceId)?.checksState;
        return c === "success" || c === "failure" ? c : undefined;
      },
      15 * 60_000,
    );
    const runs = await rpc("listCheckRuns", { workspaceId });
    expect(runs.length).toBeGreaterThan(0);
    const failed = runs.some((r) =>
      ["failure", "cancelled", "timed_out", "action_required"].includes(r.conclusion ?? ""),
    );
    expect(final).toBe(failed ? "failure" : "success");
  });

  test("AT-18 squash-merge from Tempo; with archive_on_merge the workspace archives", async () => {
    if (!shared) throw new Error("AT-17 did not create a pull request");
    await requireChannels();
    const { workspaceId } = shared;
    const watch = await WorkspaceWatch.open(workspaceId);
    const hub = await HubWatch.open();
    const restore = await withProjectSettings({ git: { archive_on_merge: true } });
    try {
      await watch.until(
        "archive_on_merge in the effective settings",
        () => watch.detail?.settings.git.archive_on_merge === true,
        2 * 60_000,
      );
      await rpc("mergePullRequest", { workspaceId, method: "squash" });
      await hub.until(
        "the PR badge to show merged",
        () => hub.summaries.get(workspaceId)?.prState === "merged",
        TARGET.prUpdateMs,
      );
      const archived = await pollState(workspaceId, ["archived"], 15 * 60_000);
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.prState).toBe("merged");
      await hub.until(
        "the sidebar to drop the workspace",
        () => hub.summaries.get(workspaceId)?.state === "archived" || hub.removed.has(workspaceId),
        60_000,
      );
    } finally {
      await restore();
      hub.close();
      await cleanupFile();
    }
  });
});

test("AT-19 archive, restore, wake: transcript and files are intact", async () => {
  test.setTimeout(45 * 60_000);
  await requireChannels();
  const tag = nonce();
  const { summary, watch } = await newWorkspace({
    prompt: `e2e-${tag}: reply with exactly: TRANSCRIPT-${tag}`,
  });
  const workspaceId = summary.id;
  const t1 = await watch.waitTurnEnded(firstTurn(watch).id, 10 * 60_000);
  expect(t1.status).toBe("completed");

  await sh(
    workspaceId,
    [
      "f=$(git ls-files | head -n 1)",
      `printf 'e2e %s\\n' ${tag} >> "$f"`,
      `printf 'kept %s\\n' ${tag} > e2e-archive-${tag}.txt`,
    ].join("\n"),
  );
  const tree = await workingTreeHash(workspaceId);
  const transcript = [...watch.items.values()].map((i) => ({
    id: i.id,
    kind: i.kind,
    text: "text" in i.content ? i.content.text : null,
  }));
  expect(transcript.length).toBeGreaterThanOrEqual(2);
  watch.close();

  await rpcRetry("archiveWorkspace", { workspaceId }, 10 * 60_000, ["WORKSPACE_BUSY"]);
  const archived = await pollState(workspaceId, ["archived"], 15 * 60_000);
  expect(archived.archivedAt).not.toBeNull();
  expect((await rpcFails("wakeWorkspace", { workspaceId })).code).toBe("WORKSPACE_ARCHIVED");

  await rpc("restoreWorkspace", { workspaceId });
  const restored = await pollState(workspaceId, ["sleeping"], 10 * 60_000);
  expect(restored.archivedAt).toBeNull();
  await rpcRetry("wakeWorkspace", { workspaceId }, 5 * 60_000, ["WORKSPACE_BUSY"]);
  await pollState(workspaceId, ["ready"], 20 * 60_000);

  const after = await WorkspaceWatch.open(workspaceId, 0);
  for (const item of transcript) {
    const now = after.items.get(item.id);
    expect(now?.kind, `item ${item.id}`).toBe(item.kind);
    if (item.text !== null && now && "text" in now.content) expect(now.content.text).toBe(item.text);
  }
  expect(after.agentText({ turnId: t1.id })).toContain(`TRANSCRIPT-${tag}`);
  expect(await workingTreeHash(workspaceId)).toBe(tree);
  expect((await rpcRetry("readFile", { workspaceId, path: `e2e-archive-${tag}.txt` })).content).toBe(
    `kept ${tag}\n`,
  );

  const next = await promptAndWait(after, t1.sessionId, `Reply with exactly: AGAIN-${tag}`);
  expect(next.status).toBe("completed");
  expect(after.agentText({ turnId: next.id })).toContain(`AGAIN-${tag}`);
});

test("AT-20 with the allowlist policy a host not on the list gets 403 and an egress_log row; APP_HOST is blocked under both policies", async () => {
  test.setTimeout(30 * 60_000);
  await requireChannels();
  const tag = nonce();
  const path = `/e2e-${tag}`;
  const restore = await withProjectSettings({
    environment: { egress_policy: "allowlist", egress_allowlist: [] },
  });
  try {
    const { summary, watch } = await newWorkspace();
    const workspaceId = summary.id;
    await watch.waitState(["ready"], 15 * 60_000);
    await watch.until(
      "the allowlist policy in effect",
      () => watch.detail?.settings.environment.egress_policy === "allowlist",
      2 * 60_000,
    );

    const curl = async (url: string): Promise<{ code: number; body: string }> => {
      const out = await sh(
        workspaceId,
        `curl -sS -o /tmp/e2e-body -w '%{http_code}' --max-time 30 '${url}' || true; echo; head -c 300 /tmp/e2e-body 2>/dev/null || true`,
      );
      const [code = "0", ...body] = out.split("\n");
      return { code: Number(code), body: body.join("\n") };
    };
    const egressRow = (host: string, rowPath: string, since: number) =>
      waitFor(
        `an egress_log row for ${host}${rowPath}`,
        async () =>
          (await rpc("getDiagnostics", { workspaceId })).egress.find(
            (r) => r.host === host && r.path === rowPath && r.ts >= since - 5_000,
          ),
        60_000,
      );

    const blockedAt = Date.now();
    const blocked = await curl(`https://example.com${path}`);
    expect(blocked.code).toBe(403);
    expect(blocked.body).toContain("tempo: egress blocked for example.com");
    expect(
      (await curl("https://registry.npmjs.org/")).code,
      "built-in agent hosts pass under allowlist",
    ).toBe(200);
    expect((await curl(`${E2E.url}/api/v1/meta`)).code, "APP_HOST under allowlist").toBe(403);
    expect(await egressRow("example.com", path, blockedAt)).toMatchObject({
      method: "GET",
      status: 403,
      rule: 10,
    });
    expect(await egressRow(appHost(), "/api/v1/meta", blockedAt)).toMatchObject({ status: 403, rule: 0 });

    await withProjectSettings({ environment: { egress_policy: "open" } });
    await watch.until(
      "the open policy in effect",
      () => watch.detail?.settings.environment.egress_policy === "open",
      2 * 60_000,
    );
    await sleep(EGRESS_CONFIG_CACHE_MS);
    const openAt = Date.now();
    const open = await curl(`https://example.com${path}`);
    expect(open.code, "a request that reached example.com").toBeGreaterThan(0);
    expect(open.code).not.toBe(403);
    expect(await egressRow("example.com", path, openAt)).toMatchObject({ status: open.code, rule: 8 });
    expect((await curl(`${E2E.url}/api/v1/meta`)).code, "APP_HOST under open").toBe(403);
  } finally {
    await restore();
  }
});

test.describe("AT-21 phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("AT-21 at phone width: list workspaces, read a live transcript, send a prompt, approve a permission", async ({
    page,
  }) => {
    requireUi();
    await requireChannels();
    const tag = nonce();
    const { summary, watch } = await newWorkspace();
    const sessionId = await readySession(watch, "claude", { modeId: "plan" });
    await watch.until(
      "the session to start",
      () => watch.sessions.get(sessionId)?.status === "idle",
      5 * 60_000,
    );

    await openWorkspace(page, summary.title, { phone: true });
    await page.getByText("Chat", { exact: true }).first().click();
    await sendFromComposer(
      page,
      `e2e-${tag}: create a file named e2e-phone-${tag}.txt that contains ${tag}. Plan first, then leave plan mode and create it.`,
    );
    const turn = await watch.until(
      "the prompt sent from the phone",
      () => [...watch.turns.values()].find((t) => t.prompt.text.startsWith(`e2e-${tag}`)),
      60_000,
    );
    await expect(page.getByText(`e2e-${tag}`).first()).toBeVisible();

    const { turn: ended, answered } = await answerPermissionsUntilEnd(watch, turn.id, async (req) => {
      await choosePermission(page, allowOption(req).name);
    });
    expect(answered.length).toBeGreaterThan(0);
    expect(ended.status).toBe("completed");
    await expect(page.getByText(`e2e-phone-${tag}`).first()).toBeVisible();
    expect(
      (await rpcRetry("readFile", { workspaceId: summary.id, path: `e2e-phone-${tag}.txt` })).content,
    ).toContain(tag);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, "no horizontal scrolling at phone width").toBeLessThanOrEqual(390);
  });
});

test.describe("AT-22 keyboard shortcuts", () => {
  test("AT-22 (Chromium) shortcuts from 04 open the palette, dialogs and panels", async ({ page }) => {
    requireUi();
    await requireChannels();
    const { summary, watch } = await newWorkspace();
    await readySession(watch);
    await openWorkspace(page, summary.title);
    const dialog = page.getByRole("dialog");
    const history = page.getByText("History", { exact: true }).first();

    await page.keyboard.press("ControlOrMeta+KeyK");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.keyboard.press("Alt+KeyN");
    await expect(dialog.getByText("New workspace").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.keyboard.press("Alt+Comma");
    await expect(dialog.getByText("Logins").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await expect(history).toBeVisible();
    await page.keyboard.press("ControlOrMeta+KeyB");
    await expect(history).toBeHidden();
    await page.keyboard.press("ControlOrMeta+KeyB");
    await expect(history).toBeVisible();

    await page.keyboard.press("Alt+KeyL");
    await expect(composer(page)).toBeFocused();

    await page.keyboard.press("Alt+KeyT");
    for (const agent of ["Claude", "Codex", "OpenCode", "Pi"])
      await expect(page.getByText(agent, { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Escape");
  });

  // Manual: Playwright drives Chromium, WebKit and Firefox builds, not Safari and Firefox as
  // shipped on macOS, and 06 requires those browsers. On a Mac, in Chrome, Safari and Firefox,
  // go through every row of 04's shortcut table in a test workspace (⌥Y, ⌥P, ⌥M, ⌥A and ⌥R act on
  // git and scripts, so use a throwaway branch) and check each action runs and the browser does not
  // take the key.
  test.fixme("AT-22 every shortcut in 04 works in Chrome, Safari and Firefox on macOS", async () => {});
});

test.describe("Gate D credential grep", () => {
  /** One credential value per line, at least 8 characters (README.md, credential grep). */
  const loadSecrets = (): string[] =>
    readFileSync(required("TEMPO_E2E_SECRETS_FILE"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= 8);

  const expectNoLeak = (haystack: string, secrets: string[], where: string) => {
    const leaks = leakedSecrets(haystack, secrets).map((i) => i + 1);
    expect(leaks, `lines ${leaks.join(", ")} of TEMPO_E2E_SECRETS_FILE occur in ${where}`).toEqual([]);
  };

  test("Gate D credential grep: nothing the API or the channels return holds a test credential", async () => {
    test.skip(!env("TEMPO_E2E_SECRETS_FILE"), "TEMPO_E2E_SECRETS_FILE is not set");
    test.setTimeout(30 * 60_000);
    await requireChannels();
    const secrets = loadSecrets();
    const projects = await rpc("listProjects", {});
    const workspaces = await rpc("listWorkspaces", { includeArchived: true });
    const parts: string[] = [
      JSON.stringify(projects),
      JSON.stringify(workspaces),
      JSON.stringify(await rpc("getCredentialStatus", {})),
    ];
    for (const p of projects)
      parts.push(JSON.stringify(await rpc("listProjectSecretNames", { projectId: p.id })));
    const note = (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`;
    for (const ws of workspaces) {
      const workspaceId = ws.id;
      parts.push(JSON.stringify(await rpc("getDiagnostics", { workspaceId }).catch(note)));
      parts.push(JSON.stringify(await rpc("listScriptRuns", { workspaceId }).catch(note)));
      parts.push(JSON.stringify(await rpc("listReviewComments", { workspaceId }).catch(note)));
      parts.push(JSON.stringify(await rpc("listCheckpoints", { workspaceId }).catch(note)));
      const watch = await WorkspaceWatch.open(workspaceId, 0).catch(() => null);
      if (watch) {
        parts.push(JSON.stringify(watch.socket.messages.map((m) => m.data)));
        watch.close();
      }
    }
    expectNoLeak(parts.join("\n"), secrets, "API or channel data");
  });

  test("Gate D credential grep: the Worker logs of the run hold no test credential", async () => {
    test.skip(
      !env("TEMPO_E2E_WORKER_LOG"),
      "TEMPO_E2E_WORKER_LOG is not set (wrangler tail output, README.md)",
    );
    expectNoLeak(readFileSync(required("TEMPO_E2E_WORKER_LOG"), "latin1"), loadSecrets(), "the Worker logs");
  });

  test("Gate D credential grep: the R2 objects hold no test credential", async () => {
    test.skip(
      !env("TEMPO_E2E_R2_DUMP"),
      "TEMPO_E2E_R2_DUMP is not set (unpacked copy of the bucket, README.md)",
    );
    const secrets = loadSecrets();
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const files = walk(required("TEMPO_E2E_R2_DUMP"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expectNoLeak(readFileSync(file, "latin1"), secrets, file);
  });

  // Manual: no API reads the WorkspaceDO `events` table. Dump `payload_json` of every workspace's
  // `events` rows with a one-off script against the DOs (for example a temporary owner-only debug
  // route removed afterwards), write it to a file and grep it with `grep -F -f <secrets file>`;
  // zero matches is required.
  test.fixme("Gate D credential grep: the events rows hold no test credential", async () => {});
});
