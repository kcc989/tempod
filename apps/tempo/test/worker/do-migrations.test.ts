import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";
import { newId } from "@tempo/protocol";
import { WORKSPACE_MIGRATIONS, runMigrations } from "../../src/db/do-migrations.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";

/** 02: sessions.status drops 'broken' and review_comments.status drops 'resolved' (0004). */

type Row = Record<string, any>;

const tablesOf = (sql: SqlStorage): string[] =>
  sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .toArray()
    .map((r) => r.name);

describe("WORKSPACE_MIGRATIONS order", () => {
  it("has strictly increasing `when` values, so the migrator applies every entry", () => {
    for (let n = 1; n < WORKSPACE_MIGRATIONS.length; n++)
      expect(WORKSPACE_MIGRATIONS[n]!.when, WORKSPACE_MIGRATIONS[n]!.tag).toBeGreaterThan(
        WORKSPACE_MIGRATIONS[n - 1]!.when,
      );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.tag)).toEqual([
      "0000_init",
      "0001_steering_pending",
      "0002_file_cache",
      "0002_turn_usage",
      "0003_preview_access",
      "0004_drop_unused_statuses",
      "0005_browser_run",
      "0006_environments",
      "0007_custom_agents",
      "0008_artifacts",
      "0009_lifecycle",
    ]);
  });
});

describe("DO migration 0004_drop_unused_statuses", () => {
  it("rebuilds sessions, turns and review_comments with the new CHECKs and keeps every row", async () => {
    const stub = env.WORKSPACE.getByName(newId());
    await runInDurableObject(stub, async (_i: WorkspaceDO, state: DurableObjectState) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE turns");
      for (const name of tablesOf(sql)) sql.exec(`DROP TABLE "${name}"`);
      const db = drizzle(state.storage);
      const before = WORKSPACE_MIGRATIONS.findIndex((m) => m.tag === "0004_drop_unused_statuses");
      expect(before).toBeGreaterThan(0);
      await runMigrations(db, WORKSPACE_MIGRATIONS.slice(0, before));

      const session = (id: string, status: string, order: number) =>
        sql.exec(
          "INSERT INTO sessions (id, agent, title, status, mode_id, sort_order, created_at, updated_at, usage_json) VALUES (?, 'codex', 'Chat', ?, 'auto', ?, 1, 2, '{\"used\":5}')",
          id,
          status,
          order,
        );
      session("s-broken", "broken", 1);
      session("s-idle", "idle", 2);
      sql.exec(
        "INSERT INTO turns (id, session_id, seq, queue_pos, status, prompt_json, queued_at, steering_pending, usage_json) VALUES ('t1', 's-broken', 1, NULL, 'completed', '{\"text\":\"a\"}', 10, 0, '{\"totalTokens\":3}'), ('t2', 's-idle', 2, 1, 'queued', '{\"text\":\"b\"}', 20, 1, NULL)",
      );
      sql.exec(
        "INSERT INTO review_comments (id, path, line_start, line_end, side, body, status, sent_turn_id, created_at) VALUES ('r-resolved', 'a.ts', 1, 2, 'new', 'Fix', 'resolved', 't1', 5), ('r-draft', 'b.ts', NULL, NULL, NULL, 'Why?', 'draft', NULL, 6)",
      );

      await runMigrations(db, WORKSPACE_MIGRATIONS);

      expect(
        sql
          .exec<Row>(
            "SELECT id, status, agent, title, mode_id, usage_json, sort_order FROM sessions ORDER BY sort_order",
          )
          .toArray(),
      ).toEqual([
        {
          id: "s-broken",
          status: "closed",
          agent: "codex",
          title: "Chat",
          mode_id: "auto",
          usage_json: '{"used":5}',
          sort_order: 1,
        },
        {
          id: "s-idle",
          status: "idle",
          agent: "codex",
          title: "Chat",
          mode_id: "auto",
          usage_json: '{"used":5}',
          sort_order: 2,
        },
      ]);
      expect(
        sql
          .exec<Row>(
            "SELECT id, session_id, seq, queue_pos, status, steering_pending, usage_json FROM turns ORDER BY seq",
          )
          .toArray(),
      ).toEqual([
        {
          id: "t1",
          session_id: "s-broken",
          seq: 1,
          queue_pos: null,
          status: "completed",
          steering_pending: 0,
          usage_json: '{"totalTokens":3}',
        },
        {
          id: "t2",
          session_id: "s-idle",
          seq: 2,
          queue_pos: 1,
          status: "queued",
          steering_pending: 1,
          usage_json: null,
        },
      ]);
      expect(
        sql
          .exec<Row>(
            "SELECT id, status, path, line_start, side, sent_turn_id FROM review_comments ORDER BY created_at",
          )
          .toArray(),
      ).toEqual([
        { id: "r-resolved", status: "sent", path: "a.ts", line_start: 1, side: "new", sent_turn_id: "t1" },
        { id: "r-draft", status: "draft", path: "b.ts", line_start: null, side: null, sent_turn_id: null },
      ]);

      expect(() => session("s-new", "broken", 3)).toThrow(/CHECK/);
      expect(() =>
        sql.exec(
          "INSERT INTO review_comments (id, path, body, status, created_at) VALUES ('r-new', 'c.ts', 'x', 'resolved', 7)",
        ),
      ).toThrow(/CHECK/);
      session("s-closed", "closed", 3);

      const schema = (name: string) =>
        sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?", name).one().sql;
      expect(schema("turns")).toMatch(/REFERENCES\s+"?sessions"?\s*\(id\)/);
      expect(() =>
        sql.exec(
          "INSERT INTO turns (id, session_id, seq, status, prompt_json, queued_at) VALUES ('t9', 'no-such-session', 9, 'queued', '{}', 1)",
        ),
      ).toThrow(/FOREIGN KEY/);
      expect(schema("turns_by_status")).toMatch(/ON turns\s*\(status, queue_pos\)/);
      expect(tablesOf(sql).filter((t) => t.endsWith("_new"))).toEqual([]);
      expect(sql.exec("SELECT * FROM __drizzle_migrations").toArray()).toHaveLength(
        WORKSPACE_MIGRATIONS.length,
      );
    });
  });
});

describe("deployed workspace upgrade", () => {
  it.each(["file-cache", "previous release"])(
    "upgrades the deployed %s schema without losing rows and can run again",
    async (release) => {
      const stub = env.WORKSPACE.getByName(newId());
      await runInDurableObject(stub, async (_i: WorkspaceDO, state: DurableObjectState) => {
        const sql = state.storage.sql;
        sql.exec("DROP TABLE turns");
        for (const name of tablesOf(sql)) sql.exec(`DROP TABLE "${name}"`);
        const db = drizzle(state.storage);
        const oldTags = ["0000_init", "0001_steering_pending", "0002_file_cache"];
        const previous =
          release === "file-cache"
            ? WORKSPACE_MIGRATIONS.filter((m) => oldTags.includes(m.tag))
            : WORKSPACE_MIGRATIONS.filter(
                (m) => !["0007_custom_agents", "0008_artifacts", "0009_lifecycle"].includes(m.tag),
              )
                .map((m) => (m.tag === "0002_turn_usage" ? { ...m, when: 1791835200000 } : m))
                .sort((a, b) => a.when - b.when);
        await runMigrations(db, previous);
        expect(
          sql
            .exec<{ created_at: number }>(
              "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
            )
            .one().created_at,
        ).toBe(release === "file-cache" ? 1791849600000 : 1792180800000);
        sql.exec(
          "INSERT INTO sessions (id, agent, title, status, sort_order, created_at, updated_at) VALUES ('legacy-session', 'codex', 'Existing chat', 'idle', 0, 1, 2)",
        );
        sql.exec(
          "INSERT INTO turns (id, session_id, seq, status, prompt_json, queued_at) VALUES ('legacy-turn', 'legacy-session', 1, 'completed', '{}', 3)",
        );
        sql.exec(
          "INSERT INTO file_cache (path, response_json, bytes, updated_at) VALUES ('README.md', '{}', 13, 4)",
        );
        await runMigrations(db, WORKSPACE_MIGRATIONS);
        await runMigrations(db, WORKSPACE_MIGRATIONS);
        expect(sql.exec("SELECT id, title, status FROM sessions").toArray()).toEqual([
          { id: "legacy-session", title: "Existing chat", status: "idle" },
        ]);
        expect(sql.exec("SELECT id, prompt_json, usage_json FROM turns").toArray()).toEqual([
          { id: "legacy-turn", prompt_json: "{}", usage_json: null },
        ]);
        expect(sql.exec("SELECT path, response_json, bytes, updated_at FROM file_cache").toArray()).toEqual([
          { path: "README.md", response_json: "{}", bytes: 13, updated_at: 4 },
        ]);
        expect(sql.exec("SELECT * FROM __drizzle_migrations").toArray()).toHaveLength(
          WORKSPACE_MIGRATIONS.length,
        );
      });
    },
  );
});
