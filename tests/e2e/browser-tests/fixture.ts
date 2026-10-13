import type { Page, WebSocketRoute } from "@playwright/test";
import {
  API,
  FN_NAMES,
  type FnOutput,
  type FnName,
  type Item,
  type Project,
  type ReviewComment,
  type Session,
  type Turn,
  type WorkspaceServerMessage,
} from "@tempo/protocol";
import * as Schema from "effect/Schema";
import {
  agentMessage,
  detail,
  session,
  summary,
  turn,
  userMessage,
} from "../../../apps/tempo/test/ui/fixtures";

/** Synthetic channel/RPC data for the real browser components. No credentials or deployment. */
export async function browserFixture(page: Page) {
  let sessions: Session[] = [
    session({ steering: true }),
    session({ id: "s2", title: "Second chat", sortOrder: 1 }),
  ];

  let turns: Turn[] = [turn({ startedAt: Date.now() - 15_000 })];

  let items: Item[] = [
    userMessage("u1", "Build the interface", { createdAt: Date.now() - 15_000 }),
    agentMessage("a1", "Starting the implementation.", { createdAt: Date.now() - 14_000 }),
  ];

  let comments: ReviewComment[] = [];
  let itemsRev = 1;
  let nextId = 2;
  const sockets = new Set<WebSocketRoute>();
  const hubSockets = new Set<WebSocketRoute>();
  const requests: Array<{ name: FnName; input: Schema.JsonObject }> = [];

  const project: Project = {
    id: "p1",
    installationId: 1,
    repoId: 1,
    owner: "fixture",
    name: "tempo-browser",
    defaultBranch: "main",
    settings: {},
    sortOrder: 0,
  };

  const changes = [{ path: "src/main.ts", status: "M", additions: 1, deletions: 1, binary: false }];

  let workspace = detail({
    state: "working",
    runningTurnId: "t1",
    changes: { files: changes, additions: 1, deletions: 1 },
  });

  const broadcast = (message: WorkspaceServerMessage) => {
    for (const socket of sockets) socket.send(JSON.stringify(message));
  };

  const publishWorkspace = () => {
    broadcast({ type: "workspace", workspace });

    for (const socket of hubSockets) socket.send(JSON.stringify({ type: "workspace", summary: workspace }));
  };

  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      json: {
        user: { id: "owner", name: "Browser fixture", email: "fixture@example.invalid", image: null },
        session: { id: "browser-session", userId: "owner", expiresAt: "2099-01-01T00:00:00Z" },
      },
    }),
  );
  await page.route("**/api/setup/status", (route) =>
    route.fulfill({
      json: { configured: true, installUrl: "https://github.com/apps/fixture/installations/new" },
    }),
  );
  await page.route("**/api/v1/meta", (route) =>
    route.fulfill({
      json: { protocol: 1, serverVersion: "0.1.0", minMacClient: "0.1.0", latestMacClient: "0.1.1" },
    }),
  );
  await page.route("**/__fixture/rpc/*", async (route) => {
    const name = Schema.decodeUnknownSync(Schema.Literals(FN_NAMES))(route.request().url().split("/").pop());

    const input = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      route.request().postDataJSON(),
    );

    Schema.decodeUnknownSync(API[name].input)(input);

    requests.push({ name, input });
    let value: FnOutput<FnName> = {};

    switch (name) {
      case "listModels":
        value = [
          {
            agent: "claude",
            currentValue: "fixture-sonnet",
            options: [{ value: "fixture-sonnet", name: "Fixture Sonnet" }],
          },
          {
            agent: "codex",
            currentValue: "fixture-codex",
            options: [{ value: "fixture-codex", name: "Fixture Codex" }],
          },
        ];
        break;
      case "listProjects":
        value = [project];
        break;
      case "listWorkspaces":
        value = [workspace];
        break;
      case "getWorkspace":
        value = workspace;
        break;
      case "listInstallations":
        value = [{ installationId: 1, accountLogin: "fixture", accountType: "User" }];
        break;
      case "getCredentialStatus":
        value = {
          claude: { set: true, updatedAt: 1 },
          codex: { set: true, updatedAt: 1, lastRefresh: 1 },
          openrouter: { set: true, updatedAt: 1 },
          anthropic: { set: false, updatedAt: null },
          openai: { set: false, updatedAt: null },
        };
        break;
      case "listScriptRuns":
      case "listTerminals":
      case "listCheckRuns":
      case "listOpenPullRequests":
      case "listCustomAgents":
      case "listRoles":
        value = [];
        break;
      case "listFiles":
        value = { paths: ["src/main.ts", "README.md"] };
        break;
      case "searchFiles":
        value = [{ path: "src/main.ts", line: 1, text: "export const ready = true;" }];
        break;
      case "readFile":
        value = { content: "export const ready = true;", encoding: "utf8", size: 26 };
        break;
      case "getChanges":
        value = { files: changes, baseSha: "base", headSha: "head" };
        break;
      case "getFileDiff":
        value = {
          diff: "diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-export const ready = false;\n+export const ready = true;\n",
        };
        break;
      case "listReviewComments":
        value = comments;
        break;
      case "addReviewComment": {
        const args = Schema.decodeUnknownSync(API.addReviewComment.input)(input);

        const comment: ReviewComment = {
          id: `r${nextId++}`,
          path: args.path,
          lineStart: args.lineStart ?? null,
          lineEnd: args.lineEnd ?? null,
          side: args.side ?? null,
          body: args.body,
          status: "draft",
          sentTurnId: null,
          createdAt: Date.now(),
        };

        comments = [...comments, comment];
        value = comment;
        break;
      }

      case "sendPrompt": {
        const queued = turn({
          id: `t${nextId++}`,
          sessionId: String(input["sessionId"]),
          seq: nextId,
          status: "queued",
          queuePos: turns.filter((t) => t.status === "queued").length,
          startedAt: null,
          queuedAt: Date.now(),
          prompt: {
            text: String(input["text"]),
            mentions: Schema.decodeUnknownSync(API.sendPrompt.input)(input).mentions ?? [],
            attachmentIds: Schema.decodeUnknownSync(Schema.Array(Schema.String))(input["attachmentIds"]),
            reviewCommentIds: Schema.decodeUnknownSync(Schema.Array(Schema.String))(
              input["reviewCommentIds"],
            ),
          },
        });

        turns = [...turns, queued];
        broadcast({ type: "turn", turn: queued });

        if (input["delivery"] === "steer") {
          broadcast({ type: "turn", turn: { ...queued, steeringPending: true } });
          broadcast({ type: "turn.deleted", turnId: queued.id });
          turns = turns.filter((t) => t.id !== queued.id);
          value = turns[0] ?? queued;
        } else value = queued;
        comments = comments.map((c) =>
          queued.prompt.reviewCommentIds.includes(c.id) ? { ...c, status: "sent", sentTurnId: queued.id } : c,
        );
        break;
      }

      case "editQueuedTurn": {
        const old = turns.find((t) => t.id === input["turnId"])!;
        const updated = { ...old, prompt: { ...old.prompt, text: String(input["text"]) } };
        turns = turns.map((t) => (t.id === old.id ? updated : t));
        broadcast({ type: "turn", turn: updated });
        value = updated;
        break;
      }

      case "deleteQueuedTurn":
        turns = turns.filter((t) => t.id !== input["turnId"]);
        broadcast({ type: "turn.deleted", turnId: String(input["turnId"]) });
        break;
      case "respondPermission": {
        items = items.map((i) =>
          i.kind === "permission"
            ? {
                ...i,
                status: "completed",
                rev: ++itemsRev,
                content: { ...i.content, chosenOptionId: String(input["optionId"]) },
              }
            : i,
        );

        for (const item of items.filter((i) => i.kind === "permission"))
          broadcast({ type: "item.upsert", item, itemsRev });
        break;
      }

      case "createSession": {
        const chat = session({
          id: `s${nextId++}`,
          agent: Schema.decodeUnknownSync(API.createSession.input)(input).agent,
          title: "New chat",
          sortOrder: sessions.length,
        });

        sessions = [...sessions, chat];
        broadcast({ type: "session", session: chat });
        value = chat;
        break;
      }

      case "closeSession":
        sessions = sessions.map((s) => (s.id === input["sessionId"] ? { ...s, status: "closed" } : s));

        for (const s of sessions) broadcast({ type: "session", session: s });
        break;
      case "cancelTurn":
        turns = turns.map((t) =>
          t.id === input["turnId"] ? { ...t, status: "cancelled", endedAt: Date.now() } : t,
        );

        for (const t of turns) broadcast({ type: "turn", turn: t });
        workspace = { ...workspace, state: "ready", runningTurnId: null, rev: workspace.rev + 1 };
        publishWorkspace();
        break;
      case "runScript":
        value = {
          id: "run1",
          kind: "run",
          scriptId: input["scriptId"],
          command: "bun run dev",
          status: "running",
          exitCode: null,
          signal: null,
          startedAt: Date.now(),
          endedAt: null,
        };
        break;
    }

    Schema.decodeUnknownSync(API[name].output)(value);
    await route.fulfill({ json: { ok: true, value } });
  });

  await page.routeWebSocket(/\/api\/ws\//, (socket) => {
    if (socket.url().includes("/hub")) {
      hubSockets.add(socket);
      socket.send(JSON.stringify({ type: "hello", v: 1, workspaces: [summary(workspace)] }));
      socket.onClose(() => hubSockets.delete(socket));
    } else {
      sockets.add(socket);
      socket.send(JSON.stringify({ type: "hello", v: 1, workspace, sessions, turns, itemsRev }));
      socket.send(JSON.stringify({ type: "items", items, itemsRev, done: true }));
      socket.onClose(() => sockets.delete(socket));
    }

    socket.onMessage((raw) => {
      if (String(raw).includes('"ping"')) socket.send(JSON.stringify({ type: "pong" }));
    });
  });

  return {
    requests,
    broadcast,
    stream(text: string) {
      const item = items.find((i) => i.id === "a1")!;

      if (item.kind !== "agent_message") return;
      items = items.map((i) =>
        i.id === item.id ? { ...item, content: { text: item.content.text + text }, rev: ++itemsRev } : i,
      );
      broadcast({ type: "item.delta", itemId: item.id, append: { text }, itemsRev });
    },
    permission() {
      const item: Item = {
        id: "permission1",
        sessionId: "s1",
        turnId: "t1",
        kind: "permission",
        status: "pending",
        rev: ++itemsRev,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        content: {
          requestId: "permission1",
          toolCallId: "tool1",
          title: "Approve the plan",
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Reject", kind: "reject_once" },
          ],
        },
      };

      items = [...items, item];
      broadcast({ type: "item.upsert", item, itemsRev });
    },
    setRunScript() {
      workspace = {
        ...workspace,
        settings: {
          ...workspace.settings,
          scripts: {
            ...workspace.settings.scripts,
            run: { dev: { command: "bun run dev", cwd: "", default: true } },
          },
        },
        rev: workspace.rev + 1,
      };
      publishWorkspace();
    },
    longTranscript() {
      items = [
        ...items,
        ...Array.from({ length: 240 }, (_, i) =>
          agentMessage(`long${i}`, `Response ${i}: ${"Long transcript content. ".repeat(10)}`, {
            status: "completed",
            createdAt: 2000 + i,
          }),
        ),
      ];
      itemsRev += items.length;
    },
  };
}
