import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId } from "@tempo/protocol";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { internals, seedCredentials, seedProject, seedWorkspace, waitFor } from "./fakes.ts";

/** Regressions for review findings outside the area suites. */

type Stub = DurableObjectStub<WorkspaceDO>;

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
  runInDurableObject(
    stub,
    (_i: unknown, state: DurableObjectState) =>
      state.storage.sql
        .exec("SELECT kind, status, error_detail FROM ops ORDER BY created_at, rowid")
        .toArray() as Array<{
        kind: string;
        status: string;
        error_detail: string | null;
      }>,
  );

describe("regressions", () => {
  it("a prompt sent while the workspace is stopping queues a wake (03, sendPrompt step 5)", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub, tempod } = await seedWorkspace(seeded);
    await driveToReady(stub);
    const created = await stub.createSession({ agent: "claude" });
    const sessionId = (created as unknown as { value?: { id: string } }).value?.id ?? "";
    expect(sessionId).not.toBe("");
    await waitFor(() => tempod.requestsOf("session.start").length === 1, 5000, "session start");
    await runInDurableObject(stub, (instance: unknown) => {
      internals(instance as WorkspaceDO).core.setState("stopping");
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
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => state.storage.deleteAlarm());
  });

  it("keeps a fast turn completed when daemon lifecycle events arrive before the prompt acknowledgement", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub, tempod } = await seedWorkspace(seeded);
    await driveToReady(stub);
    const session = await stub.createSession({ agent: "claude" });
    const sessionId = (session as unknown as { value?: { id: string } }).value?.id;
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
    await runInDurableObject(stub, async (instance: unknown) => {
      const core = internals(instance as WorkspaceDO).core;
      const { waitHealthy } = await import("../../src/do/workspace/container.ts");
      core.container!.start({ image: "workspace", enableInternet: false });
      await expect(waitHealthy(core, AbortSignal.timeout(400))).rejects.toMatchObject({
        code: "CONTAINER_START_FAILED",
        detail: expect.stringContaining("health returned 503"),
      });
    });
  });

  it("a restore queued behind an archive that failed leaves the workspace alone", async () => {
    const seeded = await seedProject();
    const { stub } = await seedWorkspace(seeded);
    await driveToReady(stub);
    await runInDurableObject(stub, (instance: unknown) => {
      const { core, runner } = internals(instance as WorkspaceDO);
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
    await runInDurableObject(stub, (instance: unknown) => {
      const { core } = internals(instance as WorkspaceDO);
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
