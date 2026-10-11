import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

/**
 * DO migrations (02, Conventions): run in the DO constructor inside blockConcurrencyWhile.
 * Forward only (05). Each migration is a list of statements; the DDL is the spec's, verbatim.
 */
type Migrations = ReadonlyArray<{
  readonly tag: string;
  readonly when: number;
  readonly statements: ReadonlyArray<string>;
}>;

const toConfig = (list: Migrations) => ({
  journal: { entries: list.map((m, idx) => ({ idx, when: m.when, tag: m.tag, breakpoints: true })) },
  migrations: Object.fromEntries(
    list.map((m, idx) => [
      `m${idx.toString().padStart(4, "0")}`,
      m.statements.join("\n--> statement-breakpoint\n"),
    ]),
  ),
});

export const runMigrations = (db: DrizzleSqliteDODatabase<any>, list: Migrations): Promise<void> =>
  migrate(db, toConfig(list));

export const WORKSPACE_MIGRATIONS: Migrations = [
  {
    tag: "0000_init",
    when: 1760140800000,
    statements: [
      `CREATE TABLE workspace (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id        TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  slug                TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  default_agent       TEXT NOT NULL,
  pinned              INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  archived_at         INTEGER,
  branch              TEXT NOT NULL,
  base_branch         TEXT NOT NULL,
  source_json         TEXT NOT NULL,
  state               TEXT NOT NULL,
  state_since         INTEGER NOT NULL,
  error_code          TEXT,
  error_detail        TEXT,
  attention           TEXT NOT NULL DEFAULT 'none',
  setup_status        TEXT NOT NULL DEFAULT 'none'
                      CHECK (setup_status IN ('none','running','succeeded','failed','skipped')),
  preview_token       TEXT NOT NULL,
  settings_json       TEXT NOT NULL DEFAULT '{}',
  pushed              INTEGER NOT NULL DEFAULT 0,
  pr_number           INTEGER,
  pr_state            TEXT,
  checks_state        TEXT,
  last_activity_at    INTEGER NOT NULL,
  last_viewed_at      INTEGER,
  tempod_token        TEXT,
  tempod_incarnation  TEXT,
  last_pushed_sha     TEXT,
  force_push_lease    INTEGER NOT NULL DEFAULT 0,
  auto_restarts_json  TEXT NOT NULL DEFAULT '[]',
  tempod_acked_seq    INTEGER NOT NULL DEFAULT 0,
  image_ref           TEXT,
  summary_rev         INTEGER NOT NULL DEFAULT 0,
  items_rev           INTEGER NOT NULL DEFAULT 0
)`,
      `CREATE TABLE ops (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('create','wake','sleep','archive','restore','revert',
                                             'commit_push','housekeeping')),
  step          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempt       INTEGER NOT NULL DEFAULT 0,
  next_run_at   INTEGER NOT NULL,
  input_json    TEXT NOT NULL DEFAULT '{}',
  state_json    TEXT NOT NULL DEFAULT '{}',
  error_code    TEXT,
  error_detail  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
)`,
      `CREATE INDEX ops_due ON ops(status, next_run_at)`,
      `CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  agent                TEXT NOT NULL CHECK (agent IN ('claude','codex','opencode','pi')),
  title                TEXT NOT NULL DEFAULT '',
  acp_session_id       TEXT,
  status               TEXT NOT NULL CHECK (status IN ('starting','idle','running','closed','broken')),
  mode_id              TEXT,
  config_json          TEXT NOT NULL DEFAULT '{}',
  modes_json           TEXT NOT NULL DEFAULT '[]',
  config_options_json  TEXT NOT NULL DEFAULT '[]',
  commands_json        TEXT NOT NULL DEFAULT '[]',
  capabilities_json    TEXT NOT NULL DEFAULT '{}',
  usage_json           TEXT NOT NULL DEFAULT '{}',
  handoff_pending      INTEGER NOT NULL DEFAULT 0,
  pending_note         TEXT,
  general_prompt_sent  INTEGER NOT NULL DEFAULT 0,
  sort_order           INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  closed_at            INTEGER
)`,
      `CREATE TABLE turns (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  seq            INTEGER NOT NULL UNIQUE,
  queue_pos      INTEGER,
  status         TEXT NOT NULL CHECK (status IN ('queued','running','completed','cancelled','failed','interrupted')),
  prompt_json    TEXT NOT NULL,
  stop_reason    TEXT,
  error_code     TEXT,
  error_detail   TEXT,
  checkpoint_id  TEXT,
  reverted       INTEGER NOT NULL DEFAULT 0,
  queued_at      INTEGER NOT NULL,
  started_at     INTEGER,
  ended_at       INTEGER
)`,
      `CREATE INDEX turns_by_status ON turns(status, queue_pos)`,
      `CREATE TABLE items (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_id       TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('user_message','agent_message','agent_thought','tool_call',
                                             'plan','permission','notice','handoff','revert_marker','error')),
  status        TEXT NOT NULL CHECK (status IN ('streaming','pending','in_progress','completed','failed','cancelled')),
  content_json  TEXT NOT NULL,
  rev           INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
)`,
      `CREATE INDEX items_by_session ON items(session_id, created_at)`,
      `CREATE INDEX items_by_rev ON items(rev)`,
      `CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  incarnation   TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  UNIQUE (incarnation, seq)
)`,
      `CREATE TABLE checkpoints (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT,
  reason        TEXT NOT NULL CHECK (reason IN ('turn_end','pre_revert','pre_sleep','pre_archive','sigterm')),
  commit_sha    TEXT NOT NULL,
  tree_sha      TEXT NOT NULL,
  parent_sha    TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  r2_key        TEXT,
  bundle_bytes  INTEGER,
  local_only    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
)`,
      `CREATE TABLE snapshots (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  image_ref         TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_restored_at  INTEGER,
  unusable          INTEGER NOT NULL DEFAULT 0
)`,
      `CREATE TABLE home_backups (
  id           TEXT PRIMARY KEY,
  record_json  TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
)`,
      `CREATE TABLE review_comments (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  line_start    INTEGER,
  line_end      INTEGER,
  side          TEXT CHECK (side IN ('old','new')),
  body          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft','sent','resolved')),
  sent_turn_id  TEXT,
  created_at    INTEGER NOT NULL
)`,
      `CREATE TABLE script_runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('setup','run','archive')),
  script_id    TEXT,
  command      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','exited','killed','failed_to_start','timed_out')),
  exit_code    INTEGER,
  signal       TEXT,
  log_tail     TEXT NOT NULL DEFAULT '',
  r2_key       TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
)`,
      `CREATE TABLE ports (
  port           INTEGER PRIMARY KEY,
  first_seen_at  INTEGER NOT NULL
)`,
      `CREATE TABLE permissions (
  request_id        TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  options_json      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','answered','cancelled')),
  chosen_option_id  TEXT,
  created_at        INTEGER NOT NULL,
  answered_at       INTEGER
)`,
      `CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT,
  name            TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  r2_key          TEXT NOT NULL,
  container_path  TEXT,
  created_at      INTEGER NOT NULL
)`,
      `CREATE TABLE egress_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  method  TEXT NOT NULL,
  host    TEXT NOT NULL,
  path    TEXT NOT NULL,
  status  INTEGER NOT NULL,
  ms      INTEGER NOT NULL,
  rule    INTEGER NOT NULL
)`,
    ],
  },
];

export const CREDENTIAL_MIGRATIONS: Migrations = [
  {
    tag: "0000_init",
    when: 1760140800000,
    statements: [
      `CREATE TABLE secrets (
  key         TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  meta_json   TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
)`,
      `CREATE TABLE codex_leases (
  workspace_id  TEXT PRIMARY KEY,
  since         INTEGER NOT NULL
)`,
    ],
  },
];

export const USER_HUB_MIGRATIONS: Migrations = [
  {
    tag: "0000_init",
    when: 1760140800000,
    statements: [
      `CREATE TABLE summaries (
  workspace_id  TEXT PRIMARY KEY,
  summary_json  TEXT NOT NULL,
  rev           INTEGER NOT NULL
)`,
    ],
  },
];
