import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TempodDb } from "../src/db.ts";
import { Outbox, type OutboxSink } from "../src/outbox.ts";
import { cleanupDirs, tmpDir } from "./helpers.ts";

afterAll(cleanupDirs);

class FakeSink implements OutboxSink {
  sent: Array<{ seq: number; event: { kind: string; [k: string]: unknown } }> = [];
  buffered = 0;
  mode: "ok" | "backpressure" | "dead" = "ok";
  send(data: string): number {
    if (this.mode === "dead") return 0;
    const msg = JSON.parse(data);
    expect(msg.type).toBe("event");
    expect(typeof msg.ts).toBe("number");
    this.sent.push({ seq: msg.seq, event: msg.event });
    if (this.mode === "backpressure") {
      this.buffered = 10 * 1024 * 1024;
      return -1;
    }
    return data.length;
  }
  getBufferedAmount(): number {
    return this.buffered;
  }
  seqs(): number[] {
    return this.sent.map((s) => s.seq);
  }
}

const open = (path = join(tmpDir(), "tempod.db"), limits = { maxEvents: 50_000, maxBytes: 200 * 1024 * 1024 }) => {
  const db = new TempodDb(path);
  return { db, outbox: new Outbox(db, limits), path };
};

const port = (n: number) => ({ kind: "ports.changed" as const, ports: [n] });

describe("outbox", () => {
  test("assigns increasing seq and only sends after hello", () => {
    const { outbox } = open();
    const sink = new FakeSink();
    expect(outbox.append(port(3000))).toBe(1);
    expect(outbox.append(port(3001))).toBe(2);
    outbox.attach(sink);
    expect(sink.sent).toHaveLength(0);
    outbox.handshake(outbox.incarnation, 0);
    expect(sink.seqs()).toEqual([1, 2]);
    outbox.append(port(3002));
    expect(sink.seqs()).toEqual([1, 2, 3]);
  });

  test("ack deletes acknowledged events; a matching hello resends the rest", () => {
    const { outbox } = open();
    for (let i = 0; i < 5; i++) outbox.append(port(3000 + i));
    const a = new FakeSink();
    outbox.attach(a);
    outbox.handshake(outbox.incarnation, 0);
    outbox.ack(3);
    expect(outbox.pendingCount).toBe(2);
    outbox.detach(a);
    outbox.append(port(4000));
    const b = new FakeSink();
    outbox.attach(b);
    outbox.handshake(outbox.incarnation, 4);
    expect(b.seqs()).toEqual([5, 6]);
    expect(outbox.pendingCount).toBe(2);
  });

  test("a different incarnation gets incarnation.changed at seq 1 and the pending events renumbered", () => {
    const { outbox } = open();
    for (let i = 0; i < 4; i++) outbox.append(port(3000 + i));
    outbox.ack(2);
    const sink = new FakeSink();
    outbox.attach(sink);
    const { matched } = outbox.handshake("01otherincarnation000000000", 99);
    expect(matched).toBe(false);
    expect(sink.seqs()).toEqual([1, 2, 3]);
    expect(sink.sent[0]!.event).toEqual({ kind: "incarnation.changed", incarnation: outbox.incarnation });
    expect(sink.sent[1]!.event).toEqual(port(3002));
    expect(sink.sent[2]!.event).toEqual(port(3003));
    expect(outbox.append(port(5000))).toBe(4);
  });

  test("a null incarnation (first connect ever) is a mismatch", () => {
    const { outbox } = open();
    const sink = new FakeSink();
    outbox.attach(sink);
    outbox.handshake(null, 0);
    expect(sink.sent.map((s) => s.event.kind)).toEqual(["incarnation.changed"]);
  });

  test("a DO ahead of a restored disk: new events get seqs above lastAckedSeq", () => {
    const { outbox } = open();
    outbox.append(port(3000));
    const sink = new FakeSink();
    outbox.attach(sink);
    outbox.handshake(outbox.incarnation, 10);
    expect(sink.sent).toHaveLength(0);
    expect(outbox.pendingCount).toBe(0);
    expect(outbox.append(port(3001))).toBe(11);
    expect(sink.seqs()).toEqual([11]);
  });

  test("incarnation and seq survive a restart; acked rows stay gone", () => {
    const first = open();
    first.outbox.append(port(3000));
    first.outbox.append(port(3001));
    first.outbox.ack(1);
    const inc = first.outbox.incarnation;
    first.db.close();
    const second = open(first.path);
    expect(second.outbox.incarnation).toBe(inc);
    expect(second.outbox.pendingCount).toBe(1);
    expect(second.outbox.append(port(3002))).toBe(3);
  });

  test("overflow drops the oldest events and sends one outbox.overflow", () => {
    const { outbox } = open(undefined, { maxEvents: 10, maxBytes: 1_000_000 });
    for (let i = 0; i < 11; i++) outbox.append(port(3000 + i));
    const sink = new FakeSink();
    outbox.attach(sink);
    outbox.handshake(outbox.incarnation, 0);
    const overflow = sink.sent.filter((s) => s.event.kind === "outbox.overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.event["dropped"]).toBe(11 - 9);
    expect(sink.sent[0]!.seq).toBe(3);
    expect(outbox.pendingCount).toBeLessThanOrEqual(10);
  });

  test("overflow by bytes", () => {
    const { outbox } = open(undefined, { maxEvents: 1_000, maxBytes: 2_000 });
    const big = { kind: "log" as const, level: "info" as const, msg: "x".repeat(400) };
    for (let i = 0; i < 6; i++) outbox.append(big);
    expect(outbox.pendingBytes).toBeLessThanOrEqual(2_000);
    const sink = new FakeSink();
    outbox.attach(sink);
    outbox.handshake(outbox.incarnation, 0);
    expect(sink.sent.some((s) => s.event.kind === "outbox.overflow")).toBe(true);
  });

  test("backpressure stops sending until pump after drain", () => {
    const { outbox } = open();
    for (let i = 0; i < 3; i++) outbox.append(port(3000 + i));
    const sink = new FakeSink();
    sink.mode = "backpressure";
    outbox.attach(sink);
    outbox.handshake(outbox.incarnation, 0);
    expect(sink.seqs()).toEqual([1]);
    sink.mode = "ok";
    sink.buffered = 0;
    outbox.pump();
    expect(sink.seqs()).toEqual([1, 2, 3]);
    expect(outbox.drained).toBe(true);
  });

  test("a dropped send is retried on the next pump", () => {
    const { outbox } = open();
    const sink = new FakeSink();
    outbox.attach(sink);
    outbox.handshake(outbox.incarnation, 0);
    sink.mode = "dead";
    outbox.append(port(3000));
    expect(sink.sent).toHaveLength(0);
    sink.mode = "ok";
    outbox.pump();
    expect(sink.seqs()).toEqual([1]);
  });
});
