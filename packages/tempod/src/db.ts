import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { newId } from "@tempo/protocol";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  seq     INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  payload TEXT NOT NULL,
  bytes   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS processes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('script','agent')),
  pid         INTEGER,
  started_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class TempodDb {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    if (this.getMeta("incarnation") === null) this.setMeta("incarnation", newId());
    if (this.getMeta("last_seq") === null) this.setMeta("last_seq", "0");
    // Processes recorded by an earlier run (for example, a disk restored from a snapshot) no longer exist.
    this.db.exec("DELETE FROM processes;");
  }

  getMeta(key: string): string | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  get incarnation(): string {
    return this.getMeta("incarnation")!;
  }

  addProcess(id: string, kind: "script" | "agent", pid: number | null): void {
    this.db
      .query("INSERT OR REPLACE INTO processes (id, kind, pid, started_at) VALUES (?, ?, ?, ?)")
      .run(id, kind, pid, Date.now());
  }

  removeProcess(id: string): void {
    this.db.query("DELETE FROM processes WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
