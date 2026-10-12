import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AgentId } from "@tempo/protocol";
import { previewUrl, requireChannels, rpc, rpcFails, rpcRetry } from "./lib/api.ts";
import { HubWatch, type WorkspaceWatch } from "./lib/channels.ts";
import { E2E, ENABLED, SKIP_REASON, env } from "./lib/env.ts";
import {
  cleanupFile,
  cleanupTest,
  newWorkspace,
  promptAndWait,
  readySession,
  sendPrompt,
  testProject,
  turnCheckpoint,
} from "./lib/flows.ts";
import { sh, Terminal, workingTreeHash } from "./lib/terminal.ts";
import { nonce, waitFor } from "./lib/util.ts";

/** Gate C: phase 2 (06, Acceptance tests AT-9 to AT-16). */

test.skip(!ENABLED, SKIP_REASON);
test.afterEach(cleanupTest);
test.afterAll(cleanupFile);

/** Vite for the AT-16 preview, installed at runtime inside the workspace. */
const VITE_VERSION = "6.3.5";

const scriptLog = async (watch: WorkspaceWatch, runId: string): Promise<string> => {
  const runs = await rpc("listScriptRuns", { workspaceId: watch.workspaceId });
  return `${watch.scriptOutput.get(runId) ?? ""}\n${runs.find((r) => r.id === runId)?.logTail ?? ""}`;
};

const scriptEnded = (watch: WorkspaceWatch, runId: string, timeoutMs: number) =>
  watch.until(
    `script run ${runId} to end`,
    () => {
      const r = watch.scriptRuns.get(runId);
      return r && r.status !== "running" ? r : undefined;
    },
    timeoutMs,
  );

test("AT-9 five workspaces run turns at the same time; the hub shows each state live; no output lands in the wrong workspace", async () => {
  test.setTimeout(60 * 60_000);
  await requireChannels();
  const tag = nonce();
  const hub = await HubWatch.open();
  const spaces = await Promise.all([0, 1, 2, 3, 4].map(() => newWorkspace()));
  const sessions = await Promise.all(spaces.map((w) => readySession(w.watch)));
  const tokens = spaces.map((_, i) => `E2E${tag}W${i}`);

  const turns = await Promise.all(
    spaces.map((w, i) =>
      sendPrompt(
        w.watch,
        sessions[i]!,
        `Write the lines "${tokens[i]} line 1" through "${tokens[i]} line 200", one per line, with no other text.`,
      ),
    ),
  );
  const ended = await Promise.all(spaces.map((w, i) => w.watch.waitTurnEnded(turns[i]!.id, 20 * 60_000)));
  for (const t of ended) expect(t.status).toBe("completed");

  const ids = spaces.map((w) => w.summary.id);
  expect(hub.maxConcurrent(ids, "working"), "all five were working at the same moment").toBe(5);
  await Promise.all(
    ids.map((id) =>
      hub.until(`hub shows ${id} ready again`, () => hub.summaries.get(id)?.state === "ready", 2 * 60_000),
    ),
  );

  spaces.forEach((w, i) => {
    // Live: the hub showed `working` within 5 s of the turn starting on the workspace channel.
    const started = w.watch.turnStatusAt.get(turns[i]!.id)?.get("running");
    const shown = hub.history(w.summary.id).find((e) => e.summary.state === "working")?.at;
    expect(started, `turn of workspace ${i} was seen running`).toBeDefined();
    expect(shown, `hub showed workspace ${i} working`).toBeDefined();
    expect(Math.abs((shown ?? 0) - (started ?? 0))).toBeLessThan(5_000);

    const text = w.watch.agentText({});
    expect(text).toContain(tokens[i]);
    tokens.forEach((other, j) => {
      if (j !== i) expect(text, `workspace ${i} holds output of workspace ${j}`).not.toContain(other);
    });
  });
  hub.close();
});

test("AT-10 Codex, OpenCode and Pi each complete a turn in their own chat tab in one workspace", async () => {
  test.setTimeout(45 * 60_000);
  await requireChannels();
  const creds = await rpc("getCredentialStatus", {});
  expect(creds.codex.set || creds.openai.set, "a Codex login or an OpenAI key must be set").toBe(true);
  expect(creds.openrouter.set, "an OpenRouter key must be set for OpenCode and Pi").toBe(true);

  const tag = nonce();
  const { watch } = await newWorkspace();
  await watch.waitState(["ready"], 15 * 60_000);
  const agents: AgentId[] = ["codex", "opencode", "pi"];
  const sessions = new Map<AgentId, string>();
  for (const agent of agents) {
    const model = env(`TEMPO_E2E_MODEL_${agent.toUpperCase()}`);
    const session = await rpc("createSession", {
      workspaceId: watch.workspaceId,
      agent,
      ...(model ? { model } : {}),
    });
    expect(session.agent).toBe(agent);
    sessions.set(agent, session.id);
  }
  // One turn runs per workspace at a time; the other prompts queue (01, Send a prompt).
  const turns = await Promise.all(
    agents.map((agent) =>
      sendPrompt(watch, sessions.get(agent)!, `Reply with exactly: ${agent.toUpperCase()}-${tag}`),
    ),
  );
  for (const [i, agent] of agents.entries()) {
    const ended = await watch.waitTurnEnded(turns[i]!.id, 15 * 60_000);
    expect(ended.status, `${agent} turn`).toBe("completed");
    const sessionId = sessions.get(agent)!;
    expect(watch.agentText({ sessionId })).toContain(`${agent.toUpperCase()}-${tag}`);
    for (const other of agents) {
      if (other !== agent)
        expect(watch.agentText({ sessionId })).not.toContain(`${other.toUpperCase()}-${tag}`);
    }
    const session = watch.sessions.get(sessionId);
    expect(
      session?.configOptions.some((o) => o.category === "model"),
      `${agent} reports a model option`,
    ).toBe(true);
  }
});

test("AT-11 a Codex token refresh in one workspace reaches a second running workspace, which then completes a turn", async () => {
  test.setTimeout(45 * 60_000);
  const file = env("TEMPO_E2E_CODEX_AUTH_FILE");
  test.skip(
    !file,
    "TEMPO_E2E_CODEX_AUTH_FILE is not set: AT-11 uploads a fresh Codex auth.json with last_refresh set 9 days back",
  );
  await requireChannels();
  const tag = nonce();
  const auth = JSON.parse(readFileSync(file ?? "", "utf8")) as Record<string, unknown>;
  const stale = Date.now() - 9 * 24 * 60 * 60_000;
  auth["last_refresh"] = new Date(stale).toISOString();
  await rpc("setCodexAuth", { authJson: JSON.stringify(auth) });
  expect((await rpc("getCredentialStatus", {})).codex.set).toBe(true);

  const lastRefreshIn = async (workspaceId: string): Promise<number> =>
    Date.parse((await sh(workspaceId, 'jq -r .last_refresh "$HOME/.codex/auth.json"')).trim());

  // B runs first: a live Codex session holds a lease and the stale auth.json, with no turn yet.
  const b = await newWorkspace();
  const bSession = await readySession(b.watch, "codex");
  await b.watch.until(
    "B's Codex session to start",
    () => b.watch.sessions.get(bSession)?.status === "idle",
    5 * 60_000,
  );
  expect(Math.abs((await lastRefreshIn(b.summary.id)) - stale), "B holds the stale auth.json").toBeLessThan(
    1_000,
  );

  // A's turn makes Codex refresh the 9-day-old token.
  const a = await newWorkspace();
  const aSession = await readySession(a.watch, "codex");
  const aTurn = await promptAndWait(a.watch, aSession, `Reply with exactly: A-${tag}`);
  expect(aTurn.status).toBe("completed");
  const refreshed = await waitFor(
    "CredentialDO to accept the refreshed auth.json",
    async () => {
      const codex = (await rpc("getCredentialStatus", {})).codex;
      return codex.lastRefresh !== null && codex.lastRefresh > stale + 60_000 ? codex.lastRefresh : undefined;
    },
    5 * 60_000,
  );

  await waitFor(
    "the refreshed auth.json to reach B",
    async () => (await lastRefreshIn(b.summary.id)) === refreshed,
    3 * 60_000,
    5_000,
  );
  const bTurn = await promptAndWait(b.watch, bSession, `Reply with exactly: B-${tag}`);
  expect(bTurn.status).toBe("completed");
  expect(b.watch.agentText({ turnId: bTurn.id })).toContain(`B-${tag}`);
});

test("AT-12 changes and diffs are correct for added, changed, deleted, renamed and untracked files in both scopes; review comments reach the agent", async () => {
  await requireChannels();
  const tag = nonce();
  const { summary, watch } = await newWorkspace();
  const sessionId = await readySession(watch);
  const workspaceId = summary.id;

  const out = await sh(
    workspaceId,
    [
      "set -e",
      'mapfile -t F < <(git ls-files | while IFS= read -r f; do [ -f "$f" ] && [ -s "$f" ] && grep -Iq . "$f" && printf "%s\\n" "$f"; done | head -n 3)',
      '[ "${#F[@]}" -eq 3 ] || { echo "the test repo needs three tracked text files"; exit 3; }',
      'deleted=$(git show HEAD:"${F[1]}" | grep -c "")',
      `renamed="e2e-renamed-${tag}-$(basename "\${F[2]}")"`,
      `printf 'committed %s\\n' ${tag} > e2e-committed-${tag}.txt`,
      `git add e2e-committed-${tag}.txt`,
      `git commit -q -m "e2e committed ${tag}"`,
      `printf 'e2e change %s\\n' ${tag} >> "\${F[0]}"`,
      'git rm -q -- "${F[1]}"',
      'git mv -- "${F[2]}" "$renamed"',
      `printf 'added %s\\n' ${tag} > e2e-added-${tag}.txt`,
      `git add e2e-added-${tag}.txt`,
      `printf 'untracked %s\\n' ${tag} > e2e-untracked-${tag}.txt`,
      'printf "%s\\n" "${F[0]}" "${F[1]}" "${F[2]}" "$renamed" "$deleted"',
    ].join("\n"),
  );
  const [changed, deleted, renameFrom, renameTo, deletedLines] = out.trimEnd().split("\n").slice(-5) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const added = `e2e-added-${tag}.txt`;
  const untracked = `e2e-untracked-${tag}.txt`;
  const committed = `e2e-committed-${tag}.txt`;

  for (const scope of ["uncommitted", "branch"] as const) {
    const changes = await rpcRetry("getChanges", { workspaceId, scope });
    const byPath = new Map(changes.files.map((f) => [f.path, f]));
    expect(byPath.get(changed), `${scope}: changed`).toMatchObject({ status: "M" });
    expect(byPath.get(changed)?.additions).toBeGreaterThanOrEqual(1);
    expect(byPath.get(deleted), `${scope}: deleted`).toMatchObject({
      status: "D",
      deletions: Number(deletedLines),
    });
    expect(byPath.get(renameTo), `${scope}: renamed`).toMatchObject({ status: "R", oldPath: renameFrom });
    expect(byPath.get(added), `${scope}: added`).toMatchObject({ status: "A", additions: 1, deletions: 0 });
    expect(byPath.get(untracked), `${scope}: untracked`).toMatchObject({
      status: "A",
      additions: 1,
      deletions: 0,
    });
    if (scope === "branch") {
      expect(byPath.get(committed), "branch: committed on the branch").toMatchObject({
        status: "A",
        additions: 1,
      });
      expect(changes.baseSha).not.toBe(changes.headSha);
    } else {
      expect(byPath.has(committed), "uncommitted: a committed file is not an uncommitted change").toBe(false);
      expect(changes.baseSha).toBe(changes.headSha);
    }

    const diff = async (path: string) => (await rpcRetry("getFileDiff", { workspaceId, scope, path })).diff;
    expect(
      (await diff(changed)).split("\n").some((l) => l.startsWith("+") && l.includes(`e2e change ${tag}`)),
    ).toBe(true);
    expect(await diff(deleted)).toContain("deleted file mode");
    const rename = await diff(renameTo);
    expect(rename).toContain(`rename from ${renameFrom}`);
    expect(rename).toContain(`rename to ${renameTo}`);
    expect(await diff(added)).toContain(`+added ${tag}`);
    expect(await diff(untracked)).toContain(`+untracked ${tag}`);
    if (scope === "branch") expect(await diff(committed)).toContain(`+committed ${tag}`);
  }

  const comment = await rpc("addReviewComment", {
    workspaceId,
    path: changed,
    lineStart: 1,
    lineEnd: 1,
    side: "new",
    body: `E2E-REVIEW-${tag}: please keep this line.`,
  });
  expect(comment.status).toBe("draft");
  const turn = await promptAndWait(
    watch,
    sessionId,
    "Quote verbatim every review comment you received with this message, and nothing else. Do not change any files.",
    10 * 60_000,
    { reviewCommentIds: [comment.id] },
  );
  expect(turn.status).toBe("completed");
  expect(watch.agentText({ turnId: turn.id })).toContain(`E2E-REVIEW-${tag}`);
  const sent = (await rpc("listReviewComments", { workspaceId })).find((c) => c.id === comment.id);
  expect(sent).toMatchObject({ status: "sent", sentTurnId: turn.id });
  const userMessage = watch.itemsOf("user_message", { turnId: turn.id })[0];
  expect(userMessage?.content.reviewCommentIds).toContain(comment.id);
});

test("AT-13 revert restores the exact tree of the chosen checkpoint, shows the marker, and the next prompt carries the revert note", async () => {
  await requireChannels();
  const tag = nonce();
  const { summary, watch } = await newWorkspace();
  const sessionId = await readySession(watch);
  const workspaceId = summary.id;
  const fileA = `e2e-revert-${tag}.txt`;
  const fileB = `e2e-revert-b-${tag}.txt`;

  await sh(workspaceId, `printf 'v1\\n' > ${fileA}`);
  const t1 = await promptAndWait(watch, sessionId, "Reply with exactly: OK");
  expect(t1.status).toBe("completed");
  const c1 = await turnCheckpoint(watch, t1.id);

  await sh(workspaceId, `printf 'v2\\n' > ${fileA} && printf 'b\\n' > ${fileB}`);
  const t2 = await promptAndWait(watch, sessionId, "Reply with exactly: OK");
  expect(t2.status).toBe("completed");
  expect(await turnCheckpoint(watch, t2.id)).not.toBe(c1);

  const tree = (await sh(workspaceId, `git rev-parse 'refs/tempo/checkpoints/${c1}^{tree}'`)).trim();
  await rpc("revertToCheckpoint", { workspaceId, checkpointId: c1 });

  const marker = await watch.until(
    "the revert marker",
    () => watch.itemsOf("revert_marker").find((i) => i.content.checkpointId === c1),
    2 * 60_000,
  );
  expect(marker.content.toTurnSeq).toBe(t1.seq);
  await watch.until("turn 2 marked reverted", () => watch.turns.get(t2.id)?.reverted === true, 60_000);
  expect(watch.turns.get(t1.id)?.reverted).toBe(false);
  expect((await rpc("listCheckpoints", { workspaceId })).some((c) => c.reason === "pre_revert")).toBe(true);

  expect(await workingTreeHash(workspaceId)).toBe(tree);
  expect((await rpcRetry("readFile", { workspaceId, path: fileA })).content).toBe("v1\n");
  expect((await rpcFails("readFile", { workspaceId, path: fileB })).code).toBe("NOT_FOUND");

  const t3 = await promptAndWait(
    watch,
    sessionId,
    "If this message contains a line that starts with 'Note:', repeat that line verbatim. Otherwise reply NO NOTE.",
  );
  expect(t3.status).toBe("completed");
  expect(watch.agentText({ turnId: t3.id })).toContain(
    `reverted the files to the state after turn ${t1.seq}`,
  );
});

test("AT-14 a repo with only conductor.json runs its setup and run scripts with CONDUCTOR_PORT set", async () => {
  await requireChannels();
  const project = await testProject();
  expect(
    project.settings.scripts ?? {},
    "project overrides must not set scripts; they win over conductor.json",
  ).toEqual({});
  const tag = nonce();
  const { summary, watch } = await newWorkspace();
  await watch.waitState(["ready"], 15 * 60_000);
  const workspaceId = summary.id;

  const setup = `echo E2E_SETUP_${tag}_PORT=$CONDUCTOR_PORT`;
  const run = `echo E2E_RUN_${tag}_PORT=$CONDUCTOR_PORT && exec python3 -m http.server $CONDUCTOR_PORT --bind 127.0.0.1`;
  // The workspace keeps only conductor.json: higher-precedence files go (01, Precedence).
  const conductorJson = JSON.stringify({ scripts: { setup, run } });
  await sh(
    workspaceId,
    ["rm -f .tempo/settings.yaml", `cat > conductor.json <<'EOF'`, conductorJson, "EOF"].join("\n"),
  );

  const effective = await watch.until(
    "the conductor.json settings in effect",
    () => (watch.detail?.settings.scripts.setup === setup ? watch.detail : undefined),
    2 * 60_000,
  );
  expect(effective.settings.scripts.run["default"]?.command).toBe(run);
  if (effective.settingsSources) expect(effective.settingsSources["scripts.setup"]).toBe("conductor.json");

  const setupRun = await rpcRetry("rerunSetup", { workspaceId });
  expect(setupRun.kind).toBe("setup");
  expect(await scriptEnded(watch, setupRun.id, 5 * 60_000)).toMatchObject({ status: "exited", exitCode: 0 });
  expect(await scriptLog(watch, setupRun.id)).toContain(`E2E_SETUP_${tag}_PORT=3000`);
  await watch.until("setup_status succeeded", () => watch.detail?.setupStatus === "succeeded", 60_000);

  const runRun = await rpcRetry("runScript", { workspaceId, scriptId: "default" });
  expect(runRun.kind).toBe("run");
  await watch.until(
    "the run script's output",
    () => (watch.scriptOutput.get(runRun.id) ?? "").includes(`E2E_RUN_${tag}_PORT=3000`),
    2 * 60_000,
  );
  await watch.until("port 3000 detected", () => watch.detail?.ports.find((p) => p.port === 3000), 60_000);
  await rpc("stopScript", { workspaceId, runId: runRun.id });
  expect(["killed", "exited"]).toContain((await scriptEnded(watch, runRun.id, 60_000)).status);
});

test("AT-15 a terminal runs commands; after a reconnect the session and scrollback are still there", async () => {
  await requireChannels();
  const tag = nonce();
  const { summary, watch } = await newWorkspace();
  await watch.waitState(["ready"], 15 * 60_000);

  const first = await Terminal.open(summary.id, "t2", 120, 40);
  first.type(`export E2E_VAR=${tag}; echo "mark-${tag}-$((6*7))"; seq 1 200\r`);
  await first.waitFor(`mark-${tag}-42`);
  first.type('echo "size=$(stty size)="\r');
  const size = await first.until("stty size", () => /size=(\d+) (\d+)=/.exec(first.screen), 30_000);
  expect(Number(size[2])).toBe(120);
  first.resize(100, 30);
  first.type('echo "resized=$(stty size)="\r');
  const resized = await first.until(
    "stty size after resize",
    () => /resized=(\d+) (\d+)=/.exec(first.screen),
    30_000,
  );
  expect(Number(resized[2])).toBe(100);
  expect(Number(resized[1])).toBeLessThanOrEqual(30);
  first.close();

  expect((await rpc("listTerminals", { workspaceId: summary.id })).map((t) => t.terminalId)).toContain("t2");

  const second = await Terminal.open(summary.id, "t2", 100, 30);
  // tmux redraws the screen of the same session on attach.
  await second.until("the screen restored", () => /resized=\d+ 100=/.test(second.screen), 30_000);
  second.type(
    `echo "same-$E2E_VAR-shell"; echo "found=$(tmux capture-pane -p -S - | grep -c "mark-${tag}-4[2]")="\r`,
  );
  await second.waitFor(`same-${tag}-shell`);
  const found = await second.until("scrollback search", () => /found=(\d+)=/.exec(second.screen), 30_000);
  expect(
    Number(found[1]),
    "the line that scrolled off the screen is in the scrollback",
  ).toBeGreaterThanOrEqual(1);
  second.close();
});

test("AT-16 a Vite preview opened from Tempo works with hot reload; the bare preview URL shows the preview 404 page; Reset preview access stops an open preview; an agent passes a Playwright MCP check on localhost", async ({
  page,
}) => {
  await requireChannels();
  const tag = nonce();
  const { summary, watch } = await newWorkspace();
  const sessionId = await readySession(watch);
  const dir = `/tmp/e2e-vite-${tag}`;
  await sh(
    summary.id,
    [
      "set -e",
      `mkdir -p ${dir} && cd ${dir}`,
      `printf '%s\\n' '{"name":"e2e-vite","private":true,"type":"module"}' > package.json`,
      `printf '%s\\n' '<!doctype html><html><body><div id="app">loading</div><script type="module" src="/main.js"></script></body></html>' > index.html`,
      `printf '%s\\n' 'document.getElementById("app").textContent = "E2E-${tag}-v1";' 'if (import.meta.hot) import.meta.hot.accept();' > main.js`,
      `npm install --no-audit --no-fund --loglevel=error vite@${VITE_VERSION} > /tmp/e2e-vite-install.log 2>&1`,
      "setsid nohup ./node_modules/.bin/vite --port 5173 --strictPort --host 127.0.0.1 > /tmp/e2e-vite.log 2>&1 < /dev/null &",
    ].join("\n"),
    10 * 60_000,
  );

  const port = await watch.until(
    "port 5173 detected",
    () => watch.detail?.ports.find((p) => p.port === 5173),
    3 * 60_000,
  );
  if (E2E.previewDomain) expect(port.url).toBe(previewUrl(5173, summary.id));
  const PREVIEW_404 = "This preview opens only from Tempo.";
  const bare = await fetch(port.url);
  expect(bare.status, "the bare preview URL in a fresh browser").toBe(404);
  expect(await bare.text()).toContain(PREVIEW_404);

  const { url: entry } = await rpc("openPreview", { workspaceId: summary.id, port: 5173 });
  expect(entry.slice(0, port.url.length + 20)).toBe(`${port.url}/__tempo/enter?code=`);
  expect(entry.slice(port.url.length + 20)).toMatch(/^[a-z0-9]{32}$/);
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.goto(entry);
  await expect(page).toHaveURL(`${port.url}/`);
  await expect(page.locator("#app")).toHaveText(`E2E-${tag}-v1`, { timeout: 60_000 });
  await sh(summary.id, `sed -i 's/-v1/-v2/' ${dir}/main.js`);
  await expect(page.locator("#app")).toHaveText(`E2E-${tag}-v2`, { timeout: 60_000 });
  const host = new URL(port.url).host;
  expect(
    sockets.some((u) => new URL(u).host === host),
    "hot reload runs over a WebSocket through the preview",
  ).toBe(true);

  expect((await fetch(entry)).status, "an entry link works once").toBe(404);

  await rpc("rotatePreviewKey", { workspaceId: summary.id });
  await page.reload();
  await expect(page.locator("body")).toContainText(PREVIEW_404, { timeout: 30_000 });
  await page.goto((await rpc("openPreview", { workspaceId: summary.id, port: 5173 })).url);
  await expect(page.locator("#app")).toHaveText(`E2E-${tag}-v2`, { timeout: 60_000 });

  const check = await promptAndWait(
    watch,
    sessionId,
    'Use the Playwright MCP browser tools to open http://localhost:5173 and read the text of the element with id "app". ' +
      "Do not use curl or a shell for this. Reply with that text only.",
  );
  expect(check.status).toBe("completed");
  expect(watch.agentText({ turnId: check.id })).toContain(`E2E-${tag}-v2`);
  const browserCalls = watch
    .itemsOf("tool_call", { turnId: check.id })
    .filter((t) =>
      /playwright|browser_/i.test(`${t.content.title} ${JSON.stringify(t.content.rawInput ?? null)}`),
    );
  expect(browserCalls.length, "the agent used the Playwright MCP server").toBeGreaterThan(0);
});
