import { afterAll, afterEach, describe, expect, test, spyOn } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AcpFields, MAX_MESSAGE_BYTES, TempodEvent, type TempodEventOf } from "@tempo/protocol";
import { Schema } from "effect";
import { SessionMapper } from "../src/acp/mapper.ts";
import {
  boundContent,
  capList,
  jsonBytes,
  offloadBlobs,
  splitText,
  tailLines,
  TRUNCATED,
} from "../src/bounds.ts";
import { TempodDb } from "../src/db.ts";
import { killGroup, run } from "../src/exec.ts";
import { Outbox, type OutboxSink } from "../src/outbox.ts";
import { processEnv } from "../src/tempod.ts";
import {
  cleanupDirs,
  DoClient,
  isAlive,
  quietLogger,
  sleep,
  startTempod,
  tmpDir,
  type Harness,
} from "./helpers.ts";

afterAll(cleanupDirs);

let h: Harness | null = null;

afterEach(async () => {
  await h?.close();
  h = null;
});

const validate = Schema.decodeUnknownSync(TempodEvent);

describe("size helpers", () => {
  test("splitText never splits a surrogate pair", () => {
    const parts = splitText(`${"a".repeat(4)}😀${"b".repeat(4)}`, 5);
    expect(parts.join("")).toBe(`${"a".repeat(4)}😀${"b".repeat(4)}`);

    for (const p of parts) expect(p.length).toBeLessThanOrEqual(5);
    expect(parts[0]).toBe("aaaa");
  });

  test("tailLines keeps the newest lines that fit", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `\u001b[31mline ${i}\u001b[0m`);
    expect(tailLines(lines, 1_000_000)).toBe(lines.join("\n"));
    const cut = tailLines(lines, 2_000);
    expect(jsonBytes(cut)).toBeLessThanOrEqual(2_000);
    expect(cut.endsWith("line 199\u001b[0m")).toBe(true);
    expect(cut.split("\n").length).toBeLessThan(200);
  });

  test("capList keeps the longest prefix that fits", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ path: `file-${i}.ts` }));
    const capped = capList(items, 500);
    expect(jsonBytes(capped)).toBeLessThanOrEqual(500);
    expect(capped).toEqual(items.slice(0, capped.length));
    expect(capped.length).toBeGreaterThan(5);
  });

  test("boundContent cuts long strings with a marker and always fits", () => {
    const small = { text: "short" };
    expect(boundContent(small, 1000)).toBe(small);

    const big = {
      title: "t",
      content: [{ type: "diff", oldText: "a".repeat(200_000), newText: "b".repeat(200_000) }],
      rawOutput: { o: "c".repeat(300_000) },
    };

    const cut = boundContent(big, 100_000);
    expect(jsonBytes(cut)).toBeLessThanOrEqual(100_000);

    const diff = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.String)))(
      cut["content"],
    )[0]!;

    expect(diff["oldText"]!.endsWith(TRUNCATED)).toBe(true);
    expect(cut["title"]).toBe("t");

    const many = {
      entries: Array.from({ length: 50_000 }, (_, i) => ({ content: `entry ${i}`, status: "pending" })),
    };

    const cutMany = boundContent(many, 50_000);
    expect(jsonBytes(cutMany)).toBeLessThanOrEqual(50_000);
    expect(Array.isArray(cutMany["entries"])).toBe(true);
  });

  test("offloadBlobs replaces large images and resource blobs, and keeps small ones", () => {
    const saved: string[] = [];

    const save = (data: string, mime: string | null) => {
      saved.push(`${mime}:${data.length}`);

      return {
        uri: `file:///home/tempo/attachments/t1/img${saved.length}.png`,
        name: `img${saved.length}.png`,
      };
    };

    const value = [
      { type: "content", content: { type: "image", data: "A".repeat(100), mimeType: "image/png" } },
      { type: "content", content: { type: "image", data: "B".repeat(2_000), mimeType: "image/png" } },
      {
        type: "content",
        content: {
          type: "resource",
          resource: { uri: "x", blob: "C".repeat(2_000), mimeType: "application/pdf" },
        },
      },
    ];

    const out = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ content: AcpFields })))(
      offloadBlobs(value, save, 1_000),
    );

    expect(out[0]!.content).toEqual(value[0]!.content);
    expect(out[1]!.content).toMatchObject({
      type: "resource_link",
      uri: "file:///home/tempo/attachments/t1/img1.png",
      mimeType: "image/png",
      size: 1500,
    });
    expect(out[2]!.content).toMatchObject({ type: "resource_link", mimeType: "application/pdf" });
    expect(saved).toEqual(["image/png:2000", "application/pdf:2000"]);

    const noSave = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ content: AcpFields })))(
      offloadBlobs(value, () => null, 1_000),
    );

    expect(noSave[1]!.content["type"]).toBe("text");
  });
});

describe("mapper bounds", () => {
  const setup = (attachments?: string) => {
    const events: TempodEvent[] = [];
    let n = 0;

    const deps = {
      emit: (e) => events.push(validate(e)),
      log: quietLogger(),
      newId: () => `item${++n}`,
      mergeMs: 10_000,
      maxBytes: 8 * 1024,
    } satisfies ConstructorParameters<typeof SessionMapper>[1];

    const mapper = new SessionMapper("s1", attachments ? { ...deps, attachments } : deps);

    const of = <K extends TempodEvent["kind"]>(k: K) =>
      events.filter((e): e is TempodEventOf<K> => e.kind === k);

    return { mapper, events, of };
  };

  test("a large tool image is saved under attachments/<turnId>/ and linked", () => {
    const dir = tmpDir("att-");
    const { mapper, of } = setup(dir);
    mapper.startTurn("01turn");
    const data = Buffer.alloc(300 * 1024, 9).toString("base64");
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "tc",
      title: "Shot",
      status: "completed",
      content: [{ type: "content", content: { type: "image", data, mimeType: "image/jpeg" } }],
    });
    const item = of("item.created")[0]!.item;

    const link = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ content: AcpFields })))(
      item.content["content"],
    )[0]!.content;

    expect(link["type"]).toBe("resource_link");
    const path = String(link["uri"]).slice("file://".length);
    expect(path.startsWith(join(dir, "01turn") + "/")).toBe(true);
    expect(path.endsWith(".jpg")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).byteLength).toBe(300 * 1024);
    mapper.handle({ sessionUpdate: "tool_call_update", toolCallId: "tc", title: "Shot 2" });
    const upd = of("item.updated")[0]!;
    expect(jsonBytes(upd)).toBeLessThan(10_000);
    mapper.endTurn("completed");
  });

  test("every event stays under the limit: big tool updates, big first chunks, big deltas", () => {
    const { mapper, events, of } = setup();
    mapper.startTurn("t1");
    mapper.handle({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "q".repeat(2_000_000) },
    });
    mapper.handle({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "r".repeat(700_000) },
    });
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "tc",
      title: "Edit",
      status: "pending",
      rawInput: { content: "s".repeat(2_000_000) },
    });
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc",
      status: "completed",
      content: [{ type: "diff", path: "/w/x", oldText: "o".repeat(900_000), newText: "n".repeat(900_000) }],
    });
    mapper.endTurn("completed");

    for (const e of events) expect(jsonBytes(e)).toBeLessThan(MAX_MESSAGE_BYTES - 1024);
    const deltas = of("item.delta");
    expect(deltas.map((d) => d.append.text).join("")).toBe("r".repeat(700_000));
    expect(deltas.length).toBeGreaterThanOrEqual(6);
    const first = of("item.created")[0]!.item;
    expect(String(first.content["text"]).endsWith(TRUNCATED)).toBe(true);
  });
});

describe("outbox and response limits", () => {
  class Sink implements OutboxSink {
    sent: string[] = [];
    send(data: string): number {
      this.sent.push(data);

      return data.length;
    }
    getBufferedAmount(): number {
      return 0;
    }
  }

  test("an event over the limit is never queued; a log warning takes its place", () => {
    const db = new TempodDb(join(tmpDir(), "tempod.db"));
    const log = quietLogger();
    const outbox = new Outbox(db, { maxEvents: 100, maxBytes: 100 * 1024 * 1024 }, log);
    const sink = new Sink();
    outbox.attach(sink);
    outbox.handshake(outbox.incarnation, 0);
    outbox.append({
      kind: "script.output",
      runId: "r",
      stream: "stdout",
      data: "x".repeat(MAX_MESSAGE_BYTES),
    });

    const msg = Schema.decodeUnknownSync(
      Schema.Struct({
        event: Schema.Struct({
          kind: Schema.String,
          level: Schema.String,
          data: Schema.Struct({ kind: Schema.String, size: Schema.Number }),
        }),
      }),
    )(JSON.parse(sink.sent[0]!));

    expect(msg.event.kind).toBe("log");
    expect(msg.event.level).toBe("warn");
    expect(msg.event.data.kind).toBe("script.output");
    expect(msg.event.data.size).toBeGreaterThan(MAX_MESSAGE_BYTES);

    for (const s of sink.sent) expect(Buffer.byteLength(s)).toBeLessThan(MAX_MESSAGE_BYTES);
    db.close();
  });

  test("a response over 1 MiB becomes INTERNAL; a failing handler is answered once", async () => {
    h = startTempod();
    const c = new DoClient(h.base);
    await c.hello();
    const handlers = h.app.handlers;

    const handler = spyOn(handlers, "terminal.list").mockImplementation(async () => ({
      terminalIds: ["x".repeat(MAX_MESSAGE_BYTES)],
    }));

    expect(await c.req("terminal.list", {})).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    handler.mockImplementation(() => Promise.reject(new Error("boom")));
    expect(await c.req("terminal.list", {})).toMatchObject({
      ok: false,
      error: { code: "INTERNAL", message: "boom" },
    });
    handler.mockRestore();
  });

  test("a failing outbox never throws into the caller", async () => {
    h = startTempod();
    h.app.outbox.append = () => {
      throw new Error("SQLITE_FULL");
    };

    expect(() => h!.app.emit({ kind: "ports.changed", ports: [3000] })).not.toThrow();
    expect(h.log.lines.some((l) => l.includes("event not queued") && l.includes("SQLITE_FULL"))).toBe(true);
  });
});

describe("exec", () => {
  test("a timeout kills the whole group and returns without waiting for the pipes", async () => {
    const dir = tmpDir("exec-");
    const pidFile = join(dir, "bg.pid");
    const t0 = Date.now();

    const r = await run(["bash", "-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], {
      timeoutMs: 300,
      killGraceMs: 200,
    });

    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r.timedOut).toBe(true);
    const bg = Number(readFileSync(pidFile, "utf8"));

    for (let i = 0; i < 40 && isAlive(bg); i++) await sleep(25);
    expect(isAlive(bg)).toBe(false);
  });

  test("output, exit code and input", async () => {
    const r = await run(["bash", "-c", "cat; echo err >&2; exit 3"], { input: "piped" });
    expect(r).toMatchObject({ code: 3, stdout: "piped", stderr: "err\n", timedOut: false });
    expect(killGroup(999_999_999, "SIGTERM")).toBe(false);
  });

  test("child env drops TEMPOD_* vars", () => {
    process.env["TEMPOD_TOKEN"] = "secret";
    process.env["TEMPOD_PORT"] = "7070";

    try {
      const env = processEnv();
      expect(env["TEMPOD_TOKEN"]).toBeUndefined();
      expect(env["TEMPOD_PORT"]).toBeUndefined();
      expect(env["PATH"]).toBe(process.env["PATH"]!);
    } finally {
      delete process.env["TEMPOD_TOKEN"];
      delete process.env["TEMPOD_PORT"];
    }
  });
});
