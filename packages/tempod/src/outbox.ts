import { MAX_MESSAGE_BYTES, type TempodEvent } from "@tempo/protocol";
import type { TempodDb } from "./db.ts";
import type { Logger } from "./log.ts";

export interface OutboxSink {
  send(data: string): number;
  getBufferedAmount(): number;
}

export interface OutboxLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
}

const HIGH_WATER = 4 * 1024 * 1024;
const BATCH = 256;

interface Row {
  seq: number;
  ts: number;
  payload: string;
}

/**
 * Durable event outbox (01, Outbox). Pending rows always form one contiguous seq range, because rows
 * are only removed from the oldest end (ack, overflow, implicit ack in hello).
 */
export class Outbox {
  private sink: OutboxSink | null = null;
  private live = false;
  private sentUpTo = 0;
  private lastSeq: number;
  private count: number;
  private bytes: number;
  private appending = false;
  /** Test hook: called with every appended event. */
  onAppend: ((seq: number, event: TempodEvent) => void) | undefined;

  constructor(
    private readonly store: TempodDb,
    private readonly limits: OutboxLimits,
    private readonly log?: Logger,
  ) {
    this.lastSeq = Number(store.getMeta("last_seq") ?? "0");
    const agg = store.db
      .query<{ n: number; b: number }, []>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM outbox")
      .get()!;
    this.count = agg.n;
    this.bytes = agg.b;
    const max = store.db.query<{ m: number | null }, []>("SELECT MAX(seq) AS m FROM outbox").get()!.m;
    if (max !== null && max > this.lastSeq) this.setLastSeq(max);
  }

  get incarnation(): string {
    return this.store.incarnation;
  }

  get seq(): number {
    return this.lastSeq;
  }

  get pendingCount(): number {
    return this.count;
  }

  get pendingBytes(): number {
    return this.bytes;
  }

  get isLive(): boolean {
    return this.live && this.sink !== null;
  }

  private setLastSeq(seq: number): void {
    this.lastSeq = seq;
    this.store.setMeta("last_seq", String(seq));
  }

  append(event: TempodEvent): number {
    const payload = JSON.stringify(event);
    const size = Buffer.byteLength(payload);
    const ts = Date.now();
    const seq = this.lastSeq + 1;
    this.store.db.transaction(() => {
      this.store.db
        .query("INSERT INTO outbox (seq, ts, kind, payload, bytes) VALUES (?, ?, ?, ?, ?)")
        .run(seq, ts, event.kind, payload, size);
      this.setLastSeq(seq);
    })();
    this.count += 1;
    this.bytes += size;
    this.onAppend?.(seq, event);
    if (!this.appending) {
      this.appending = true;
      try {
        if (size > MAX_MESSAGE_BYTES - 256) this.log?.warn("event larger than the message limit", { kind: event.kind, size });
        this.enforceCap();
      } finally {
        this.appending = false;
      }
    }
    this.pump();
    return seq;
  }

  private enforceCap(): void {
    const { maxEvents, maxBytes } = this.limits;
    if (this.count <= maxEvents && this.bytes <= maxBytes) return;
    const targetCount = Math.floor(maxEvents * 0.9);
    const targetBytes = Math.floor(maxBytes * 0.9);
    let count = this.count;
    let bytes = this.bytes;
    let cut = 0;
    let dropped = 0;
    let after = 0;
    while (count > targetCount || bytes > targetBytes) {
      const rows = this.store.db
        .query<{ seq: number; bytes: number }, [number, number]>(
          "SELECT seq, bytes FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?",
        )
        .all(after, 1024);
      if (rows.length === 0) break;
      for (const r of rows) {
        if (count <= targetCount && bytes <= targetBytes) break;
        count -= 1;
        bytes -= r.bytes;
        cut = r.seq;
        dropped += 1;
      }
      after = rows[rows.length - 1]!.seq;
    }
    if (dropped === 0) return;
    this.store.db.query("DELETE FROM outbox WHERE seq <= ?").run(cut);
    this.count = count;
    this.bytes = bytes;
    this.append({ kind: "outbox.overflow", dropped });
  }

  ack(upTo: number): void {
    if (!Number.isFinite(upTo)) return;
    this.removeUpTo(upTo);
  }

  private removeUpTo(upTo: number): void {
    const agg = this.store.db
      .query<{ n: number; b: number }, [number]>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM outbox WHERE seq <= ?",
      )
      .get(upTo)!;
    if (agg.n === 0) return;
    this.store.db.query("DELETE FROM outbox WHERE seq <= ?").run(upTo);
    this.count -= agg.n;
    this.bytes -= agg.b;
  }

  attach(sink: OutboxSink): void {
    this.sink = sink;
    this.live = false;
  }

  detach(sink: OutboxSink): void {
    if (this.sink === sink) {
      this.sink = null;
      this.live = false;
    }
  }

  /**
   * Applies `hello`. A matching incarnation resumes after `lastAckedSeq`. Otherwise the DO holds none of
   * this incarnation's events: pending events are renumbered to start at seq 2, and seq 1 becomes
   * `incarnation.changed`, so the DO sees one gap-free stream that starts at 1.
   */
  handshake(incarnation: string | null, lastAckedSeq: number): { matched: boolean } {
    const matched = incarnation === this.incarnation;
    if (matched) {
      this.removeUpTo(lastAckedSeq);
      // A disk restored from an older snapshot can be behind the DO: new events must not reuse its seqs.
      if (lastAckedSeq > this.lastSeq) this.setLastSeq(lastAckedSeq);
      this.sentUpTo = lastAckedSeq;
    } else {
      const db = this.store.db;
      db.transaction(() => {
        const lo = db.query<{ m: number | null }, []>("SELECT MIN(seq) AS m FROM outbox").get()!.m;
        if (lo !== null) {
          db.query("UPDATE outbox SET seq = -(seq - ? + 2)").run(lo);
          db.query("UPDATE outbox SET seq = -seq").run();
        }
        const event: TempodEvent = { kind: "incarnation.changed", incarnation: this.incarnation };
        const payload = JSON.stringify(event);
        db.query("INSERT INTO outbox (seq, ts, kind, payload, bytes) VALUES (1, ?, ?, ?, ?)").run(
          Date.now(),
          event.kind,
          payload,
          Buffer.byteLength(payload),
        );
        this.count += 1;
        this.bytes += Buffer.byteLength(payload);
        this.setLastSeq(this.count);
      })();
      this.sentUpTo = 0;
    }
    this.live = true;
    this.pump();
    return { matched };
  }

  pump(): void {
    const sink = this.sink;
    if (!sink || !this.live) return;
    const query = this.store.db.query<Row, [number, number]>(
      "SELECT seq, ts, payload FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?",
    );
    while (sink.getBufferedAmount() < HIGH_WATER) {
      const rows = query.all(this.sentUpTo, BATCH);
      if (rows.length === 0) return;
      for (const row of rows) {
        const r = sink.send(`{"type":"event","seq":${row.seq},"ts":${row.ts},"event":${row.payload}}`);
        if (r === 0) return;
        this.sentUpTo = row.seq;
        if (r === -1) return;
      }
    }
  }

  /** True when every pending event was handed to the socket and its buffer is empty. */
  get drained(): boolean {
    if (!this.sink || !this.live) return this.count === 0;
    return this.sentUpTo >= this.lastSeq && this.sink.getBufferedAmount() === 0;
  }

  async flush(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      this.pump();
      if (this.drained) return true;
      if (Date.now() >= end) return false;
      await Bun.sleep(20);
    }
  }
}
