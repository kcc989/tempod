import { test as base, expect, type Page, type WebSocketRoute } from "@playwright/test";
import {
  API,
  FN_NAMES,
  type FnOutput,
  DEFAULT_SETTINGS,
  TempoError,
  type FnName,
  type FnInput,
  type Item,
  type Project,
  type ReviewComment,
  type Session,
  type Turn,
  type WorkspaceDetail,
  type WorkspaceServerMessage,
  type HubServerMessage,
  type ScriptRun,
} from "@tempo/protocol";
import { Schema } from "effect";
import { detail, session, turn, userMessage, agentMessage } from "../../../apps/tempo/test/ui/fixtures";

export class WebFixture {
  workspace: WorkspaceDetail = detail({
    hasUnpushedCommits: true,
    title: "Build keeled",
    changes: {
      files: [{ path: "README.md", status: "M", additions: 1, deletions: 1 }],
      additions: 1,
      deletions: 1,
    },
    settings: {
      ...DEFAULT_SETTINGS,
      scripts: {
        ...DEFAULT_SETTINGS.scripts,
        run: { dev: { command: "bun run dev", cwd: "", default: true } },
      },
    },
  });
  project: Project = {
    id: "p1",
    installationId: 1,
    repoId: 1,
    owner: "kcc989",
    name: "keeled",
    defaultBranch: "main",
    settings: {},
    sortOrder: 0,
  };
  sessions: Session[] = [
    session({
      title: "Claude chat",
      modes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
      modeId: "default",
      steering: true,
    }),
    session({ id: "s2", title: "Second chat", sortOrder: 1 }),
  ];
  turns: Turn[] = [turn({ status: "completed", endedAt: 2000 })];
  items: Item[] = [
    userMessage("i1", "Review the README"),
    agentMessage("i2", "Ready to review **keeled**.", { status: "completed" }),
  ];
  comments: ReviewComment[] = [];
  runs: ScriptRun[] = [];
  calls: { name: FnName; input: Schema.JsonObject }[] = [];
  failures = new Map<FnName, TempoError>();
  hold = new Map<FnName, Promise<void>>();
  workspaceSockets: WebSocketRoute[] = [];
  hubSockets: WebSocketRoute[] = [];
  unexpected: string[] = [];
  errors: string[] = [];
  private seq = 2;

  async install(page: Page) {
    page.on("pageerror", (error) => this.errors.push(error.message));
    await page.route("**/api/setup/status", (route) =>
      route.fulfill({
        json: { configured: true, installUrl: "https://github.com/apps/tempo/installations/new" },
      }),
    );
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({
        json: {
          user: { id: "owner", name: "Owner", email: "owner@example.com", image: null },
          session: { id: "owner-session", token: "fixture-session", expiresAt: "2099-01-01T00:00:00Z" },
        },
      }),
    );
    await page.route("**/__fixture/*", async (route) => {
      const name = Schema.decodeUnknownSync(Schema.Literals(FN_NAMES))(
        new URL(route.request().url()).pathname.split("/").at(-1),
      );

      const input = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
        route.request().postDataJSON(),
      );

      Schema.decodeUnknownSync(API[name].input)(input);
      this.calls.push({ name, input });
      await this.hold.get(name);
      const failure = this.failures.get(name);

      if (failure) return route.fulfill({ json: { ok: false, error: failure.toBody() } });
      const value = this.respond(name, input);
      Schema.decodeUnknownSync(API[name].output)(value);

      return route.fulfill({ json: { ok: true, value } });
    });
    await page.route("**/api/workspaces/*/attachments", async (route) =>
      route.fulfill({
        json: { attachmentId: "attachment-1", name: "notes.txt", mime: "text/plain", size: 5 },
      }),
    );
    await page.routeWebSocket("**/api/ws/**", (socket) => {
      const path = new URL(socket.url()).pathname;

      if (path === "/api/ws/hub") {
        this.hubSockets.push(socket);
        socket.send(
          JSON.stringify({ type: "hello", v: 1, workspaces: [this.workspace] } satisfies HubServerMessage),
        );
      } else if (path.includes("/terminal/")) {
        socket.send(JSON.stringify({ type: "ready" }));
        socket.send(Buffer.from("$ fixture terminal\r\n"));
      } else {
        this.workspaceSockets.push(socket);
        socket.send(
          JSON.stringify({
            type: "hello",
            v: 1,
            workspace: this.workspace,
            sessions: this.sessions,
            turns: this.turns,
            itemsRev: this.seq,
          } satisfies WorkspaceServerMessage),
        );
        socket.send(
          JSON.stringify({
            type: "items",
            items: this.items,
            itemsRev: this.seq,
            done: true,
          } satisfies WorkspaceServerMessage),
        );
      }

      socket.onMessage((data) => {
        if (Schema.is(Schema.String)(data) && JSON.parse(data).type === "ping")
          socket.send('{"type":"pong"}');
      });
    });
  }

  emit(message: WorkspaceServerMessage) {
    for (const socket of this.workspaceSockets) socket.send(JSON.stringify(message));
  }

  updateWorkspace(patch: Partial<WorkspaceDetail>) {
    this.workspace = { ...this.workspace, ...patch, rev: this.workspace.rev + 1 };
    this.emit({ type: "workspace", workspace: this.workspace });

    for (const socket of this.hubSockets)
      socket.send(JSON.stringify({ type: "workspace", summary: this.workspace } satisfies HubServerMessage));
  }

  updateSession(id: string, patch: Partial<Session>) {
    const updated = { ...this.sessions.find((s) => s.id === id)!, ...patch };
    this.sessions = this.sessions.map((s) => (s.id === id ? updated : s));
    this.emit({ type: "session", session: updated });
  }

  private respond(name: FnName, input: Schema.JsonObject): FnOutput<FnName> {
    switch (name) {
      case "listProjects":
        return [this.project];
      case "listInstallations":
        return [{ installationId: 1, accountLogin: "kcc989", accountType: "User" }];
      case "listWorkspaces":
        return [this.workspace];
      case "createWorkspace":
        return this.workspace;
      case "listInstallationRepos":
        return [{ repoId: 1, owner: "kcc989", name: "keeled", defaultBranch: "main", private: false }];
      case "listModels":
        return [
          {
            agent: "claude",
            currentValue: "fixture-opus",
            options: [
              { value: "fixture-opus", name: "Fixture Opus" },
              { value: "fixture-sonnet", name: "Fixture Sonnet" },
            ],
          },
        ];
      case "getCredentialStatus":
        return {
          claude: { set: true, updatedAt: 1000 },
          codex: { set: false, updatedAt: null, lastRefresh: null },
          openrouter: { set: false, updatedAt: null },
          anthropic: { set: false, updatedAt: null },
          openai: { set: false, updatedAt: null },
        };
      case "getChanges":
        return { files: this.workspace.changes?.files ?? [], baseSha: "base", headSha: "head" };
      case "getFileDiff":
        return {
          diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old README\n+new README\n",
        };
      case "listRoles":
        return [];
      case "listFiles":
        return {
          paths: ["README.md", "src/main.ts", ...Array.from({ length: 220 }, (_, i) => `src/file-${i}.ts`)],
        };
      case "readFile":
        return { content: "export const keeled = true;\n", encoding: "utf8", size: 28 };
      case "searchFiles":
        return [{ path: "src/main.ts", line: 1, text: "export const keeled = true;" }];
      case "listReviewComments":
        return this.comments;
      case "addReviewComment": {
        const comment: ReviewComment = {
          id: `comment-${this.comments.length + 1}`,
          path: String(input.path),
          body: String(input.body),
          lineStart: Schema.decodeUnknownSync(Schema.NullishOr(Schema.Number))(input.lineStart) ?? null,
          lineEnd: Schema.decodeUnknownSync(Schema.NullishOr(Schema.Number))(input.lineEnd) ?? null,
          side: Schema.decodeUnknownSync(API.addReviewComment.input)(input).side ?? null,
          status: "draft",
          sentTurnId: null,
          createdAt: 1000,
        };

        this.comments.push(comment);

        return comment;
      }

      case "deleteReviewComment":
        this.comments = this.comments.filter((c) => c.id !== input.commentId);

        return {};
      case "listScriptRuns":
        return this.runs.map((r) => ({ ...r, logTail: "" }));
      case "listTerminals":
        return [];
      case "listBranches":
        return [{ name: "main" }, { name: "feature" }];
      case "listOpenPullRequests":
        return [];
      case "listProjectSecretNames":
        return { names: [] };
      case "listCustomAgents":
        return [];
      case "refreshPullRequest":
        return {
          prNumber: this.workspace.prNumber,
          prState: this.workspace.prState,
          checksState: this.workspace.checksState,
        };
      case "listCheckRuns":
        return [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/kcc989/keeled/actions/runs/1",
          },
        ];
      case "markViewed":
        return {};
      case "setSessionMode":
        this.updateSession(String(input.sessionId), { modeId: String(input.modeId) });

        return {};
      case "closeSession":
        this.updateSession(String(input.sessionId), { status: "closed" });

        return {};
      case "renameSession":
        this.updateSession(String(input.sessionId), { title: String(input.title) });

        return {};
      case "renameWorkspace":
        this.updateWorkspace({ title: String(input.title) });

        return {};
      case "setBaseBranch":
        this.updateWorkspace({ baseBranch: String(input.baseBranch) });

        return {};
      case "setPinned":
        this.updateWorkspace({ pinned: Boolean(input.pinned) });

        return {};
      case "sleepWorkspace":
        this.updateWorkspace({ state: "sleeping" });

        return {};
      case "wakeWorkspace":
        this.updateWorkspace({ state: "ready" });

        return {};
      case "archiveWorkspace":
        this.updateWorkspace({ state: "archived", archivedAt: 2000 });

        return {};
      case "restoreWorkspace":
        this.updateWorkspace({ state: "ready", archivedAt: null });

        return {};
      case "commitAndPush":
        this.updateWorkspace({
          pushed: true,
          hasUnpushedCommits: false,
          changes: { files: [], additions: 0, deletions: 0 },
        });

        return { commitSha: "pushed" };
      case "createPullRequest":
        this.updateWorkspace({ prNumber: 42, prState: "open", checksState: "pending" });

        return { number: 42, url: "https://github.com/kcc989/keeled/pull/42" };
      case "mergePullRequest":
        this.updateWorkspace({ prState: "merged" });

        return {};
      case "sendPrompt": {
        const args = Schema.decodeUnknownSync(API.sendPrompt.input)(input);

        const next = turn({
          id: `t${++this.seq}`,
          sessionId: args.sessionId,
          seq: this.seq,
          status: this.workspace.runningTurnId ? "queued" : "running",
          queuePos: this.workspace.runningTurnId ? this.turns.length : null,
          prompt: {
            text: args.text,
            mentions: args.mentions ?? [],
            attachmentIds: args.attachmentIds ?? [],
            reviewCommentIds: args.reviewCommentIds ?? [],
          },
        });

        this.turns.push(next);
        this.emit({ type: "turn", turn: next });
        this.updateWorkspace({ runningTurnId: this.workspace.runningTurnId ?? next.id, state: "working" });

        return next;
      }

      case "editQueuedTurn": {
        const updated = {
          ...this.turns.find((t) => t.id === input.turnId)!,
          prompt: { ...this.turns.find((t) => t.id === input.turnId)!.prompt, text: String(input.text) },
        };

        this.turns = this.turns.map((t) => (t.id === updated.id ? updated : t));
        this.emit({ type: "turn", turn: updated });

        return updated;
      }

      case "deleteQueuedTurn":
        this.turns = this.turns.filter((t) => t.id !== input.turnId);
        this.emit({ type: "turn.deleted", turnId: String(input.turnId) });

        return {};
      case "cancelTurn": {
        const ended = {
          ...this.turns.find((t) => t.id === input.turnId)!,
          status: "cancelled" as const,
          endedAt: 3000,
        };

        this.turns = this.turns.map((t) => (t.id === ended.id ? ended : t));
        this.emit({ type: "turn", turn: ended });
        this.updateWorkspace({ runningTurnId: null, state: "ready" });

        return {};
      }

      case "respondPermission": {
        const item = this.items.find(
          (i) => i.kind === "permission" && i.content.requestId === input.requestId,
        );

        if (item?.kind === "permission")
          this.emit({
            type: "item.upsert",
            item: {
              ...item,
              status: "completed",
              rev: 4,
              content: { ...item.content, chosenOptionId: String(input.optionId) },
            },
            itemsRev: 4,
          });

        return {};
      }

      case "runScript": {
        const run: ScriptRun = {
          id: "run-1",
          kind: "run",
          scriptId: String(input.scriptId),
          command: "bun run dev",
          status: "running",
          exitCode: null,
          signal: null,
          startedAt: 1000,
          endedAt: null,
        };

        this.runs = [run];
        this.emit({ type: "script.run", run });
        this.emit({ type: "script.output", runId: run.id, stream: "stdout", data: "Ready on port 3000\n" });

        return run;
      }

      case "stopScript": {
        const run = { ...this.runs[0]!, status: "exited" as const, exitCode: 0, endedAt: 2000 };
        this.runs = [run];
        this.emit({ type: "script.run", run });

        return {};
      }

      default:
        this.unexpected.push(name);

        return {};
    }
  }

  inputs<K extends FnName>(name: K): FnInput<K>[] {
    return this.calls
      .filter((c) => c.name === name)
      .map((c) => Schema.decodeUnknownSync(API[name].input)(c.input));
  }
}

export const test = base.extend<{ fixture: WebFixture }>({
  fixture: async ({ page }, use) => {
    const fixture = new WebFixture();
    await fixture.install(page);
    await use(fixture);
    expect(fixture.errors, "browser runtime errors").toEqual([]);
    expect(fixture.unexpected, "unhandled fixture calls").toEqual([]);
  },
});

export { expect };
