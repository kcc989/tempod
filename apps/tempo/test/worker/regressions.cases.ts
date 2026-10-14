import type { WorkspaceStub } from "../../src/do/workspace/stub.ts";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Item, Session, Turn, newId, type WorkspaceSummary } from "@tempo/protocol";
import { Schema } from "effect";

import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import {
  fastRetries,
  emitEvent,
  internals,
  seedCredentials,
  seedProject,
  seedWorkspace,
  sqlRows,
  waitApplied,
  waitFor,
} from "./fakes.ts";

/** Regressions for review findings outside the area suites. */

type Stub = WorkspaceStub;

const stateOf = async (stub: Stub): Promise<string> => {
  const d = await stub.getWorkspace({});

  if (!d.ok) throw new Error(d.error.code);

  return d.value.state;
};

const driveToReady = async (stub: Stub) => {
  for (let i = 0; i < 20 && (await stateOf(stub)) !== "ready"; i++) await runDurableObjectAlarm(stub);
  expect(await stateOf(stub)).toBe("ready");
};

const opRows = (stub: Stub) =>
  runInDurableObject(stub, (_i, state: DurableObjectState) =>
    Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          status: Schema.String,
          error_detail: Schema.Union([Schema.String, Schema.Null]),
        }),
      ),
    )(
      state.storage.sql
        .exec("SELECT kind, status, error_detail FROM ops ORDER BY created_at, rowid")
        .toArray(),
    ),
  );

describe("regressions", () => {
  it("a prompt sent while the workspace is stopping queues a wake (03, sendPrompt step 5)", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub, tempod } = await seedWorkspace(seeded);
    await driveToReady(stub);
    const created = await stub.createSession({ agent: "claude" });

    const sessionId =
      Schema.decodeUnknownSync(
        Schema.Struct({ value: Schema.optional(Schema.Struct({ id: Schema.String })) }),
      )(created).value?.id ?? "";

    expect(sessionId).not.toBe("");
    await waitFor(() => tempod.requestsOf("session.start").length === 1, 5000, "session start");
    await runInDurableObject(stub, (instance: WorkspaceDO) => {
      internals(instance).core.setState("stopping");
    });

    const turn = await stub.sendPrompt({
      sessionId,
      text: "hi",
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    });

    expect(turn.ok).toBe(true);
    const ops = await opRows(stub);
    expect(ops.some((o) => o.kind === "wake" && (o.status === "pending" || o.status === "running"))).toBe(
      true,
    );
    await runInDurableObject(stub, (_i, state: DurableObjectState) => state.storage.deleteAlarm());
  });

  it("keeps a fast turn completed when daemon lifecycle events arrive before the prompt acknowledgement", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub, tempod } = await seedWorkspace(seeded);
    await driveToReady(stub);
    const session = await stub.createSession({ agent: "claude" });

    const sessionId = Schema.decodeUnknownSync(
      Schema.Struct({ value: Schema.optional(Schema.Struct({ id: Schema.String })) }),
    )(session).value?.id;

    if (!sessionId) throw new Error("session did not start");
    await waitFor(() => tempod.requestsOf("session.start").length === 1);
    tempod.on("session.prompt", async (params) => {
      tempod.emit({ kind: "turn.started", sessionId: params.sessionId, turnId: params.turnId });
      tempod.emit({
        kind: "turn.ended",
        sessionId: params.sessionId,
        turnId: params.turnId,
        stopReason: "end_turn",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      return { accepted: true };
    });

    const sent = await stub.sendPrompt({
      sessionId,
      text: "fast",
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    });

    if (!sent.ok) throw new Error(sent.error.code);
    await waitFor(async () => {
      const rows = await runInDurableObject(stub, (_instance: WorkspaceDO, state: DurableObjectState) =>
        state.storage.sql.exec("SELECT status FROM turns WHERE id = ?", sent.value.id).toArray(),
      );

      return rows[0]?.["status"] === "completed";
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const detail = await stub.getWorkspace({});

    if (!detail.ok) throw new Error(detail.error.code);
    expect(detail.value.runningTurnId).toBeNull();
    expect(detail.value.state).toBe("ready");
    expect(tempod.requestsOf("session.prompt")).toHaveLength(1);
  });

  it("keeps the health detail when the container never becomes healthy", async () => {
    const seeded = await seedProject();
    const { stub, tempod } = await seedWorkspace(seeded);
    tempod.healthy = false;
    await fastRetries(stub);
    await runInDurableObject(stub, async (instance: WorkspaceDO) => {
      const core = internals(instance).core;
      const { waitHealthy } = await import("../../src/do/workspace/container.ts");
      core.container!.start({ image: "workspace", enableInternet: false });
      await expect(waitHealthy(core, AbortSignal.timeout(100))).rejects.toMatchObject({
        code: "CONTAINER_START_FAILED",
        detail: expect.stringContaining("health returned 503"),
      });
    });
  });

  it("a restore queued behind an archive that failed leaves the workspace alone", async () => {
    const seeded = await seedProject();
    const { stub } = await seedWorkspace(seeded);
    await driveToReady(stub);
    await runInDurableObject(stub, (instance: WorkspaceDO) => {
      const { core, runner } = internals(instance);
      core.setState("error", { code: "INTERNAL" });
      runner.insert("restore");
    });

    for (let i = 0; i < 5; i++) await runDurableObjectAlarm(stub);
    expect(await stateOf(stub)).toBe("error");
    const restore = (await opRows(stub)).find((o) => o.kind === "restore");
    expect(restore?.status).toBe("cancelled");
  });

  it("a deleted workspace answers NOT_FOUND instead of failing on missing tables", async () => {
    const seeded = await seedProject();
    const { stub } = await seedWorkspace(seeded);
    await runInDurableObject(stub, (instance: WorkspaceDO) => {
      const { core } = internals(instance);
      core.updateWs({ state: "archived", archivedAt: Date.now() });
    });
    const del = await stub.deleteWorkspace({});
    expect(del.ok).toBe(true);
    const after = await stub.getWorkspace({});
    expect(after.ok ? "OK" : after.error.code).toBe("NOT_FOUND");
    await stub.logEgress({ ts: 1, method: "GET", host: "x", path: "/", status: 200, ms: 1, rule: 8 });
  });

  it("UserHubDO loads summaries from D1 only once", async () => {
    const seeded = await seedProject();
    const workspaceId = newId();
    await env.DB.prepare(
      "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, summary_rev) VALUES (?, ?, ?, 'lisbon', 'lisbon', 'tempo/lisbon', 'main', 'sleeping', 'none', 'claude', 0, 1, 1, 0)",
    )
      .bind(workspaceId, seeded.projectId, seeded.userId)
      .run();
    const hub = env.USER_HUB.getByName(seeded.userId);

    const open = async () => {
      const res = await hub.fetch("https://tempo.test/api/ws/hub", { headers: { Upgrade: "websocket" } });
      const ws = res.webSocket!;

      const first = new Promise<{ type: string; workspaces: Array<{ id: string }> }>((resolve) =>
        ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))), { once: true }),
      );

      ws.accept();
      const hello = await first;
      expect(hello.type).toBe("hello");
      ws.close();

      return hello;
    };

    await waitFor(async () => (await open()).workspaces.some((w) => w.id === workspaceId), 5000, "hub hello");
    await hub.remove(workspaceId);
    expect((await open()).workspaces.some((w) => w.id === workspaceId)).toBe(false);
  });
});

describe("JSON columns (02 Conventions: validated with Effect Schema on every read and write)", () => {
  const driveToStarted = async (stub: Stub) => {
    for (let i = 0; i < 20 && !["ready", "working"].includes(await stateOf(stub)); i++)
      await runDurableObjectAlarm(stub);
    expect(["ready", "working"]).toContain(await stateOf(stub));
  };

  const exec = (stub: Stub, query: string, ...binds: unknown[]) =>
    runInDurableObject(stub, (_i, state: DurableObjectState) => {
      state.storage.sql.exec(query, ...binds);
    });

  const insertItem = (stub: Stub, id: string, sessionId: string, kind: string, contentJson: string) =>
    exec(
      stub,
      "INSERT INTO items (id, session_id, turn_id, kind, status, content_json, rev, created_at, updated_at) VALUES (?, ?, NULL, ?, 'completed', ?, 1000000, 1, 1)",
      id,
      sessionId,
      kind,
      contentJson,
    );

  it("reads invalid stored values as safe fallbacks, so every wire shape still decodes", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub } = await seedWorkspace(seeded, { prompt: "Hello" });
    await driveToStarted(stub);
    const [turn] = await sqlRows(stub, "SELECT id, session_id FROM turns");
    const sessionId = String(turn!["session_id"]);
    await exec(
      stub,
      "UPDATE sessions SET modes_json = ?, usage_json = 'not json', capabilities_json = '\"x\"'",
      '[{"id":1}]',
    );
    await exec(stub, "UPDATE turns SET prompt_json = ?", '{"text":5}');
    await insertItem(stub, "tool-1", sessionId, "tool_call", '{"toolCallId":"t1","title":"Read file"}');
    await insertItem(stub, "notice-1", sessionId, "notice", "not json");

    const read = await runInDurableObject(stub, (i: WorkspaceDO) => {
      const { core } = internals(i);

      return {
        session: core.sessionToWire(core.sessionRow(sessionId)),
        turn: core.turnToWire(core.turnRow(String(turn!["id"]))),
        items: core.itemsSince(0, 500),
      };
    });

    expect(read.session).toMatchObject({ modes: [], usage: {}, steering: false });
    expect(read.turn.prompt).toEqual({ text: "", mentions: [], attachmentIds: [], reviewCommentIds: [] });
    // A tool call missing fields keeps what it has; unreadable content becomes the kind's empty content.
    expect(read.items.find((x) => x.id === "tool-1")!.content).toEqual({
      toolCallId: "t1",
      title: "Read file",
      locations: [],
      content: [],
    });
    expect(read.items.find((x) => x.id === "notice-1")!.content).toEqual({ level: "warning", text: "" });
    expect(() => Schema.decodeUnknownSync(Session)(read.session)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(Turn)(read.turn)).not.toThrow();

    for (const item of read.items) expect(() => Schema.decodeUnknownSync(Item)(item)).not.toThrow();
  });

  it("repairs item content that does not match its kind before storing it", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub, tempod } = await seedWorkspace(seeded, { prompt: "Hello" });
    await driveToStarted(stub);
    await waitFor(() => tempod.requestsOf("session.prompt").length === 1, 5000, "prompt");
    const p = tempod.requestsOf("session.prompt")[0];

    const created = (id: string, kind: string, content: import("@tempo/protocol").JsonDataFields) =>
      emitEvent(stub, tempod, {
        kind: "item.created",
        sessionId: p.sessionId,
        turnId: p.turnId,
        item: { id, kind, status: "completed", content, createdAt: Date.now() },
      });

    await created("n-1", "notice", { text: "Heads up" });
    const seq = await created("t-1", "tool_call", { toolCallId: "t1", title: "Edit", locations: "nope" });
    await waitApplied(stub, seq);

    const stored = async (id: string) =>
      JSON.parse(
        String((await sqlRows(stub, "SELECT content_json FROM items WHERE id = ?", id))[0]!["content_json"]),
      );

    expect(await stored("n-1")).toEqual({ level: "warning", text: "Heads up" });
    // Only the bad field is dropped; the rest of the tool call stays.
    expect(await stored("t-1")).toEqual({ toolCallId: "t1", title: "Edit", locations: [], content: [] });
  });

  it("refuses to write an invalid value: CredentialDO meta_json", async () => {
    const creds = env.CREDENTIALS.getByName(`user-${newId()}`);
    // Called on the instance: a throwing RPC call is reported by the pool as an unhandled rejection.
    await runInDurableObject(creds, async (i) => {
      const write = i.putSecret("openai.api_key", "sk-x", { lastRefresh: "soon" });
      await expect(write).rejects.toMatchObject({ code: "INTERNAL" });
    });
    expect(await creds.status()).toEqual([]);
  });

  it("reads bad meta_json as {} and skips a hub summary that does not decode", async () => {
    const userId = `user-${newId()}`;
    const creds = env.CREDENTIALS.getByName(userId);
    await creds.putSecret("codex.auth_json", "{}", { lastRefresh: 5 });
    await runInDurableObject(creds, (_i, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE secrets SET meta_json = 'nope'");
    });
    expect((await creds.status())[0]!.meta).toEqual({});
    expect((await creds.getCodexAuth())!.lastRefresh).toBe(0);

    const hub = env.USER_HUB.getByName(userId);

    const summary: WorkspaceSummary = {
      id: newId(),
      projectId: newId(),
      slug: "porto",
      title: "porto",
      branch: "tempo/porto",
      baseBranch: "main",
      state: "ready",
      attention: "none",
      defaultAgent: "claude",
      prNumber: null,
      prState: null,
      checksState: null,
      pinned: false,
      lastActivityAt: 1,
      createdAt: 1,
      archivedAt: null,
      rev: 1,
    };

    await hub.publish(summary);
    await runInDurableObject(hub, (_i, state: DurableObjectState) => {
      state.storage.sql.exec(
        "INSERT INTO summaries (workspace_id, summary_json, rev) VALUES ('broken', '{\"id\":\"broken\"}', 1)",
      );
    });
    const res = await hub.fetch("https://tempo.test/api/ws/hub", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;

    const hello = new Promise<{ workspaces: Array<{ id: string }> }>((resolve) =>
      ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))), { once: true }),
    );

    ws.accept();
    expect((await hello).workspaces.map((w) => w.id)).toEqual([summary.id]);
    ws.close();
  });
});
