import { Schema } from "effect";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { newId, type TempodEvent } from "@tempo/protocol";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { TempodClient, type EventHandler } from "../../src/do/workspace/tempod-client.ts";
import { applyTempodEvent } from "../../src/do/workspace/events.ts";
import {
  DEFAULT_EFFECTIVE,
  FakeTempod,
  FakeContainer,
  installFakes,
  internals,
  seedProject,
  seedWorkspace,
  sqlRows,
  waitFor,
} from "./fakes.ts";

class Socket extends EventTarget {
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  receive(seq: number, event: TempodEvent): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ type: "event", seq, ts: Date.now(), event }) }),
    );
  }
}

type Stub = DurableObjectStub<WorkspaceDO>;

const transport = (stub: Stub, handler?: EventHandler) =>
  runInDurableObject(stub, (instance: WorkspaceDO) => {
    const { core, runner } = internals(instance);
    const socket = new Socket();

    const client = new TempodClient(
      core,
      socket,
      handler ?? ((event) => applyTempodEvent({ core, runner }, event)),
      () => {},
    );

    return { socket, client };
  });

const isolated = async () => {
  const w = await seedWorkspace(await seedProject());
  await waitFor(async () => {
    await runDurableObjectAlarm(w.stub);
    const detail = await w.stub.getWorkspace({});

    return detail.ok && detail.value.state === "ready";
  });
  await runInDurableObject(w.stub, async (instance: WorkspaceDO, state: DurableObjectState) => {
    const { core } = internals(instance);
    core.closingTempod = true;
    const client = core.tempod;
    client?.close();
    await client?.drained();
    core.tempod = null;
    state.storage.sql.exec("UPDATE ops SET status = 'cancelled'");
    state.storage.sql.exec("DELETE FROM events");
    state.storage.sql.exec("UPDATE workspace SET state = 'sleeping', tempod_acked_seq = 0");
    state.storage.deleteAlarm();
  });

  return w;
};

const notice = (id: string): TempodEvent => ({
  kind: "item.created",
  sessionId: newId(),
  turnId: null,
  item: {
    id,
    kind: "notice",
    status: "completed",
    content: { level: "info", text: "replayed" },
    createdAt: Date.now(),
  },
});

describe("daemon transport recovery", () => {
  it("rolls back a failed local event and blocks later events until replay", async () => {
    const { stub } = await isolated();

    const id = newId(),
      laterId = newId();

    const first = notice(id),
      later = notice(laterId);

    const failing = await runInDurableObject(stub, (instance: WorkspaceDO) => {
      const { core, runner } = internals(instance);
      const socket = new Socket();

      const client = new TempodClient(
        core,
        socket,
        (event) => {
          applyTempodEvent({ core, runner }, event);
          throw new Error("injected event failure");
        },
        () => {},
      );

      return { socket, client };
    });

    await runInDurableObject(stub, () => {
      failing.socket.receive(1, first);
      failing.socket.receive(2, later);
    });
    await waitFor(() => failing.client.closed);
    expect(await sqlRows(stub, "SELECT id FROM items WHERE id IN (?, ?)", id, laterId)).toEqual([]);
    expect(await sqlRows(stub, "SELECT seq FROM events")).toEqual([]);
    expect((await sqlRows(stub, "SELECT tempod_acked_seq, items_rev FROM workspace"))[0]).toMatchObject({
      tempod_acked_seq: 0,
      items_rev: 0,
    });
    const replay = await transport(stub);
    await runInDurableObject(stub, () => {
      replay.socket.receive(1, first);
      replay.socket.receive(1, first);
      replay.socket.receive(2, later);
    });
    await waitFor(
      async () => (await sqlRows(stub, "SELECT tempod_acked_seq FROM workspace"))[0]?.tempod_acked_seq === 2,
    );
    expect(await sqlRows(stub, "SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect((await sqlRows(stub, "SELECT items_rev FROM workspace"))[0]?.items_rev).toBe(2);
    await runInDurableObject(stub, () => replay.client.close());
  });

  it("retries rejected credential offers without storing their secrets or acknowledging later events", async () => {
    const { stub } = await isolated();

    const offer = vi
      .fn()
      .mockRejectedValueOnce(new Error("credential service unavailable"))
      .mockResolvedValue(undefined);

    const event: TempodEvent = {
      kind: "credential.changed",
      provider: "codex",
      content: "private-test-credential",
      lastRefresh: Date.now(),
    };

    const failing = await transport(stub, () => offer());
    await runInDurableObject(stub, () => {
      failing.socket.receive(1, event);
      failing.socket.receive(2, notice(newId()));
    });
    await waitFor(() => failing.client.closed);
    expect(await sqlRows(stub, "SELECT seq FROM events")).toEqual([]);
    expect((await sqlRows(stub, "SELECT tempod_acked_seq FROM workspace"))[0]?.tempod_acked_seq).toBe(0);
    const replay = await transport(stub, () => offer());
    await runInDurableObject(stub, () => replay.socket.receive(1, event));
    await waitFor(
      async () => (await sqlRows(stub, "SELECT tempod_acked_seq FROM workspace"))[0]?.tempod_acked_seq === 1,
    );
    expect(offer).toHaveBeenCalledTimes(2);
    expect(await sqlRows(stub, "SELECT payload_json FROM events")).toEqual([{ payload_json: "{}" }]);
    await runInDurableObject(stub, () => replay.client.close());
  });

  it("does not send an already aborted request and removes listeners when a response arrives", async () => {
    const { stub } = await isolated();
    const { client, socket } = await transport(stub);
    await runInDurableObject(stub, async () => {
      await expect(
        client.request("env.set", { env: {} }, { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: "TEMPOD_TIMEOUT" });
      expect(socket.sent).toEqual([]);
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const pending = client.request("env.set", { env: {} }, { signal: controller.signal });
      const req = JSON.parse(socket.sent[0]!);
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "res", id: req.id, ok: true, result: {} }),
        }),
      );
      await expect(pending).resolves.toEqual({});
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      client.close();
    });
  });

  it("cancels an in-flight daemon request and ignores its late response", async () => {
    const { stub } = await isolated();
    const { client, socket } = await transport(stub);
    await runInDurableObject(stub, async () => {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const pending = client.request("env.set", { env: {} }, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "TEMPOD_TIMEOUT" });
      const req = JSON.parse(socket.sent[0]!);
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "res", id: req.id, ok: true, result: {} }),
        }),
      );
      expect(remove).toHaveBeenCalledOnce();
      client.close();
    });
  });

  it("a stalled health fetch obeys the op's abort signal", async () => {
    const { stub } = await isolated();
    await runInDurableObject(stub, async (instance: WorkspaceDO) => {
      const { core } = internals(instance);
      core.updateWs({ tempodToken: "health-test-token" });

      const fetch = vi.fn(
        (_input: RequestInfo | URL, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          }),
      );

      const container = new FakeContainer(new FakeTempod(), () => "health-test-token");
      container.running = true;
      vi.spyOn(container, "getTcpPort").mockReturnValue({
        fetch,
        connect: () => {
          throw new Error("unused");
        },
      });
      core.container = container;
      const { waitHealthy } = await import("../../src/do/workspace/container.ts");
      const controller = new AbortController();
      const probe = waitHealthy(core, controller.signal);
      controller.abort();
      await expect(probe).rejects.toMatchObject({ code: "CONTAINER_START_FAILED" });
      expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
    });
  });

  it("recovers a waiting setup after the actual DO is aborted with its daemon socket closed", async () => {
    const seeded = await seedProject({ settingsJson: JSON.stringify({ scripts: { setup: "echo setup" } }) });
    const seededWorkspace = await seedWorkspace(seeded);
    let stub = seededWorkspace.stub;
    const tempod = seededWorkspace.tempod;
    tempod.on("settings.read", () => ({
      effective: { ...DEFAULT_EFFECTIVE, scripts: { ...DEFAULT_EFFECTIVE.scripts, setup: "echo setup" } },
      warnings: [],
      errors: [],
    }));

    for (let i = 0; i < 5; i++) await runDurableObjectAlarm(stub);
    await waitFor(() => tempod.requestsOf("script.start").length === 1);
    const runId = tempod.requestsOf("script.start")[0]!.runId;
    const beforeRow = (await sqlRows(stub, "SELECT tempod_token, tempod_acked_seq FROM workspace"))[0]!;
    const before = beforeRow.tempod_token;
    await runInDurableObject(stub, async (instance: WorkspaceDO, state: DurableObjectState) => {
      const { core } = internals(instance);
      core.closingTempod = true;
      await core.tempod?.drained();
      tempod.close(1000);
      core.tempod?.close();
      core.tempod = null;
      core.scheduleAlarm = () => undefined;
      await state.storage.deleteAlarm();
    });
    await expect(
      runInDurableObject(stub, (_instance: WorkspaceDO, state: DurableObjectState) => {
        state.abort("core recovery test restart", { retryAlarm: false });
      }),
    ).rejects.toThrow("core recovery test restart");
    stub = env.WORKSPACE.get(stub.id);
    const replacement = new FakeTempod();
    replacement.resume(
      tempod.incarnation,
      Schema.decodeUnknownSync(Schema.Number)(beforeRow.tempod_acked_seq),
    );
    const { container } = await installFakes(stub, replacement);
    container.running = true;
    await runDurableObjectAlarm(stub);
    await waitFor(() => replacement.hellos.length > 0);
    expect(container.starts).toEqual([]);
    expect((await sqlRows(stub, "SELECT tempod_token FROM workspace"))[0]!.tempod_token).toBe(before);
    expect(replacement.requestsOf("script.start")).toEqual([]);
    await runInDurableObject(stub, () =>
      replacement.emit({ kind: "script.exited", runId, exitCode: 0, signal: null, timedOut: false }),
    );
    await waitFor(
      async () =>
        (await sqlRows(stub, "SELECT setup_status FROM workspace"))[0]?.setup_status === "succeeded",
    );

    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
    expect((await sqlRows(stub, "SELECT state FROM workspace"))[0]?.state).toBe("ready");
  }, 20_000);
});
