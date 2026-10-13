import { Predicate } from "effect";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { randomBase64Url } from "../lib/crypto.ts";

/**
 * DO migrations (02, Conventions): run in the DO constructor inside blockConcurrencyWhile.
 * Forward only (05). Each migration is a list of statements; the DDL is the spec's, verbatim.
 */
type Migrations = ReadonlyArray<{
  readonly tag: string;
  readonly when: number;
  /** A function runs each time the migrations load, for values that must differ per DO. */
  readonly statements: ReadonlyArray<string | (() => string)>;
}>;

const toConfig = (list: Migrations) => ({
  journal: { entries: list.map((m, idx) => ({ idx, when: m.when, tag: m.tag, breakpoints: true })) },
  migrations: Object.fromEntries(
    list.map((m, idx) => [
      `m${idx.toString().padStart(4, "0")}`,
      m.statements.map((st) => (Predicate.isFunction(st) ? st() : st)).join("\n--> statement-breakpoint\n"),
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
  {
    tag: "0001_steering_pending",
    when: 1791748800000,
    statements: [
      "ALTER TABLE turns ADD COLUMN steering_pending INTEGER NOT NULL DEFAULT 0 CHECK (steering_pending IN (0, 1))",
    ],
  },
  {
    tag: "0002_file_cache",
    when: 1791849600000,
    statements: [
      `CREATE TABLE file_cache (
  path           TEXT PRIMARY KEY,
  response_json  TEXT,
  bytes          INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0
)`,
    ],
  },
  {
    tag: "0002_turn_usage",
    when: 1791849600001,
    statements: ["ALTER TABLE turns ADD COLUMN usage_json TEXT"],
  },
  {
    tag: "0003_preview_access",
    when: 1791921600000,
    statements: [
      "ALTER TABLE workspace ADD COLUMN preview_key TEXT NOT NULL DEFAULT ''",
      () => `UPDATE workspace SET preview_key = '${randomBase64Url(32)}'`,
      `CREATE TABLE preview_codes (
  code_hash   TEXT PRIMARY KEY,
  port        INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
)`,
    ],
  },
  {
    // 02 drops session status 'broken' and review status 'resolved'. SQLite cannot alter a CHECK, so
    // the tables are rebuilt. turns is rebuilt too: it references sessions, which must not be dropped
    // while a table still points at it.
    tag: "0004_drop_unused_statuses",
    when: 1792008000000,
    statements: [
      `CREATE TABLE sessions_new (
  id                   TEXT PRIMARY KEY,
  agent                TEXT NOT NULL CHECK (agent IN ('claude','codex','opencode','pi')),
  title                TEXT NOT NULL DEFAULT '',
  acp_session_id       TEXT,
  status               TEXT NOT NULL CHECK (status IN ('starting','idle','running','closed')),
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
      `INSERT INTO sessions_new (id, agent, title, acp_session_id, status, mode_id, config_json, modes_json,
  config_options_json, commands_json, capabilities_json, usage_json, handoff_pending, pending_note,
  general_prompt_sent, sort_order, created_at, updated_at, closed_at)
SELECT id, agent, title, acp_session_id, CASE status WHEN 'broken' THEN 'closed' ELSE status END, mode_id,
  config_json, modes_json, config_options_json, commands_json, capabilities_json, usage_json, handoff_pending,
  pending_note, general_prompt_sent, sort_order, created_at, updated_at, closed_at
FROM sessions`,
      `CREATE TABLE turns_new (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions_new(id),
  seq            INTEGER NOT NULL UNIQUE,
  queue_pos      INTEGER,
  steering_pending INTEGER NOT NULL DEFAULT 0 CHECK (steering_pending IN (0, 1)),
  status         TEXT NOT NULL CHECK (status IN ('queued','running','completed','cancelled','failed','interrupted')),
  prompt_json    TEXT NOT NULL,
  stop_reason    TEXT,
  error_code     TEXT,
  error_detail   TEXT,
  checkpoint_id  TEXT,
  reverted       INTEGER NOT NULL DEFAULT 0,
  queued_at      INTEGER NOT NULL,
  started_at     INTEGER,
  ended_at       INTEGER,
  usage_json     TEXT
)`,
      `INSERT INTO turns_new (id, session_id, seq, queue_pos, steering_pending, status, prompt_json, stop_reason,
  error_code, error_detail, checkpoint_id, reverted, queued_at, started_at, ended_at, usage_json)
SELECT id, session_id, seq, queue_pos, steering_pending, status, prompt_json, stop_reason, error_code,
  error_detail, checkpoint_id, reverted, queued_at, started_at, ended_at, usage_json
FROM turns`,
      "DROP TABLE turns",
      "DROP TABLE sessions",
      "ALTER TABLE sessions_new RENAME TO sessions",
      "ALTER TABLE turns_new RENAME TO turns",
      "CREATE INDEX turns_by_status ON turns(status, queue_pos)",
      `CREATE TABLE review_comments_new (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  line_start    INTEGER,
  line_end      INTEGER,
  side          TEXT CHECK (side IN ('old','new')),
  body          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft','sent')),
  sent_turn_id  TEXT,
  created_at    INTEGER NOT NULL
)`,
      `INSERT INTO review_comments_new (id, path, line_start, line_end, side, body, status, sent_turn_id, created_at)
SELECT id, path, line_start, line_end, side, body, CASE status WHEN 'resolved' THEN 'sent' ELSE status END,
  sent_turn_id, created_at
FROM review_comments`,
      "DROP TABLE review_comments",
      "ALTER TABLE review_comments_new RENAME TO review_comments",
    ],
  },
  {
    tag: "0005_browser_run",
    when: 1792094400000,
    statements: ["ALTER TABLE workspace ADD COLUMN browser_session_id TEXT"],
  },
  {
    tag: "0006_environments",
    when: 1792180800000,
    statements: [
      "ALTER TABLE workspace ADD COLUMN environment_id TEXT",
      `CREATE TABLE environment_proposals (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','applied','dismissed')),
  proposal_json  TEXT NOT NULL
)`,
    ],
  },
  {
    tag: "0007_custom_agents",
    when: 1792267200000,
    statements: [
      "ALTER TABLE sessions ADD COLUMN custom_agent_id TEXT",
      "ALTER TABLE sessions ADD COLUMN custom_agent_name TEXT",
      "ALTER TABLE sessions ADD COLUMN custom_agent_commit TEXT",
      "ALTER TABLE sessions ADD COLUMN profile_json TEXT",
      "ALTER TABLE sessions ADD COLUMN profile_issues_json TEXT NOT NULL DEFAULT '[]'",
    ],
  },
  {
    tag: "0008_artifacts",
    when: 1792353600000,
    statements: [
      `CREATE TABLE items_new (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_id       TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('user_message','agent_message','agent_thought','tool_call',
                                             'plan','permission','notice','handoff','revert_marker','error',
                                             'artifact')),
  status        TEXT NOT NULL CHECK (status IN ('streaming','pending','in_progress','completed','failed','cancelled')),
  content_json  TEXT NOT NULL,
  rev           INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
)`,
      `INSERT INTO items_new (id, session_id, turn_id, kind, status, content_json, rev, created_at, updated_at)
SELECT id, session_id, turn_id, kind, status, content_json, rev, created_at, updated_at FROM items`,
      "DROP TABLE items",
      "ALTER TABLE items_new RENAME TO items",
      "CREATE INDEX items_by_session ON items(session_id, created_at)",
      "CREATE INDEX items_by_rev ON items(rev)",
      `CREATE TABLE artifacts (
  id           TEXT NOT NULL,
  version      INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  turn_id      TEXT,
  item_id      TEXT NOT NULL,
  path         TEXT NOT NULL,
  name         TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  mime         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image','markdown','pdf','html','text')),
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  staged_path  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('uploading','ready','lost')),
  attempt      INTEGER NOT NULL DEFAULT 0,
  r2_key       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (id, version)
)`,
      `CREATE TABLE artifact_codes (
  code_hash    TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
)`,
    ],
  },
  {
    tag: "0009_lifecycle",
    when: 1792440000000,
    statements: [
      `CREATE TABLE lifecycle_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('agent','tempo','role')),
  occurred_at    INTEGER NOT NULL,
  change_id      TEXT,
  turn_id        TEXT,
  role_run_id    TEXT,
  session_id     TEXT,
  agent          TEXT,
  causation_id   TEXT,
  dedupe_key     TEXT NOT NULL UNIQUE,
  payload_json   TEXT NOT NULL,
  dispatched_at  INTEGER
)`,
      `CREATE INDEX lifecycle_by_change ON lifecycle_events(change_id, seq)`,
      `CREATE INDEX lifecycle_by_causation ON lifecycle_events(causation_id)`,
      `CREATE INDEX lifecycle_undispatched ON lifecycle_events(seq) WHERE dispatched_at IS NULL`,
      `CREATE TABLE role_runs (
  id                TEXT PRIMARY KEY,
  change_id         TEXT NOT NULL,
  parent_run_id     TEXT,
  depth             INTEGER NOT NULL,
  role_name         TEXT NOT NULL,
  scope             TEXT NOT NULL CHECK (scope IN ('builtin','user','repo')),
  role_sha          TEXT NOT NULL,
  trigger_event_id  TEXT NOT NULL,
  session_id        TEXT,
  agent             TEXT,
  access            TEXT NOT NULL CHECK (access IN ('read-only','write')),
  status            TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','timed_out')),
  round             INTEGER NOT NULL,
  continues_used    INTEGER NOT NULL DEFAULT 0,
  tokens            INTEGER NOT NULL DEFAULT 0,
  pin_checkpoint_id TEXT,
  result_json       TEXT,
  error_code        TEXT,
  error_detail      TEXT,
  deadline_at       INTEGER,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  UNIQUE (trigger_event_id, role_name)
)`,
      `CREATE INDEX role_runs_by_change ON role_runs(change_id, created_at)`,
      `ALTER TABLE sessions ADD COLUMN role_run_id TEXT`,
      `ALTER TABLE turns ADD COLUMN change_id TEXT`,
      `ALTER TABLE turns ADD COLUMN origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','role','continue'))`,
      `CREATE TABLE checkpoints_new (id TEXT PRIMARY KEY, turn_id TEXT, reason TEXT NOT NULL CHECK (reason IN ('turn_end','pre_revert','pre_sleep','pre_archive','sigterm','role_pin')), commit_sha TEXT NOT NULL, tree_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, base_sha TEXT NOT NULL, r2_key TEXT, bundle_bytes INTEGER, local_only INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
      `INSERT INTO checkpoints_new SELECT * FROM checkpoints`,
      `DROP TABLE checkpoints`,
      `ALTER TABLE checkpoints_new RENAME TO checkpoints`,
    ],
  },
  {
    tag: "0010_agents",
    when: 1792526400000,
    statements: [
      `CREATE TABLE runs (
        id TEXT PRIMARY KEY, change_id TEXT NOT NULL, parent_run_id TEXT, agent_id TEXT, attachment_id TEXT,
        handle TEXT NOT NULL, agent_version INTEGER, agent_sha TEXT NOT NULL, trigger_event_id TEXT NOT NULL,
        decision_p REAL, session_id TEXT, origin_session_id TEXT, agent TEXT,
        access TEXT NOT NULL CHECK(access IN ('read-only','write')),
        output_kind TEXT NOT NULL CHECK(output_kind IN ('plan','review','note')),
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','timed_out')),
        follow_up_sent INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, pin_checkpoint_id TEXT,
        warning TEXT CHECK(warning IN ('files_changed')), result_json TEXT, sent_turn_id TEXT,
        error_code TEXT, error_detail TEXT, deadline_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
        UNIQUE(trigger_event_id, handle))`,
      `INSERT INTO runs(id,change_id,parent_run_id,handle,agent_sha,trigger_event_id,session_id,agent,access,output_kind,status,follow_up_sent,tokens,pin_checkpoint_id,result_json,error_code,error_detail,deadline_at,created_at,started_at,ended_at)
        SELECT id,change_id,parent_run_id,role_name,role_sha,trigger_event_id,session_id,agent,access,
        CASE WHEN json_type(result_json,'$.findings') IS NOT NULL THEN 'review' ELSE 'note' END,
        status,
        CASE WHEN continues_used > 0 THEN 1 ELSE 0 END,tokens,pin_checkpoint_id,result_json,
        replace(error_code,'ROLE_','RUN_'),error_detail,deadline_at,created_at,started_at,ended_at FROM role_runs`,
      "DROP TABLE role_runs",
      "CREATE INDEX runs_by_change ON runs(change_id,created_at)",
      "ALTER TABLE sessions RENAME COLUMN role_run_id TO run_id",
      `CREATE TABLE turns_new (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL UNIQUE,
        queue_pos INTEGER, steering_pending INTEGER NOT NULL DEFAULT 0 CHECK(steering_pending IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','failed','interrupted')),
        prompt_json TEXT NOT NULL, stop_reason TEXT, error_code TEXT, error_detail TEXT, checkpoint_id TEXT,
        reverted INTEGER NOT NULL DEFAULT 0, queued_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
        usage_json TEXT, change_id TEXT, origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','run','continue')))`,
      `INSERT INTO turns_new SELECT id,session_id,seq,queue_pos,steering_pending,status,prompt_json,stop_reason,error_code,error_detail,checkpoint_id,reverted,queued_at,started_at,ended_at,usage_json,change_id,CASE origin WHEN 'role' THEN 'run' ELSE origin END FROM turns`,
      "DROP TABLE turns",
      "ALTER TABLE turns_new RENAME TO turns",
      "CREATE INDEX turns_by_status ON turns(status,queue_pos)",
      `CREATE TABLE lifecycle_events_new (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('agent','tempo','run')),occurred_at INTEGER NOT NULL,
        change_id TEXT,turn_id TEXT,run_id TEXT,session_id TEXT,agent TEXT,causation_id TEXT,dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,dispatched_at INTEGER)`,
      `INSERT INTO lifecycle_events_new SELECT seq,id,replace(type,'role.run.','run.'),CASE source WHEN 'role' THEN 'run' ELSE source END,occurred_at,change_id,turn_id,role_run_id,session_id,agent,causation_id,dedupe_key,
        CASE WHEN type LIKE 'role.run.%' THEN json_set(json_remove(payload_json,'$.role','$.scope','$.round','$.roleSha'),'$.handle',json_extract(payload_json,'$.role'),'$.agentId',NULL)
          WHEN type = 'tempo.change.created' AND json_type(payload_json,'$.role') IS NOT NULL THEN json_set(json_remove(payload_json,'$.role'),'$.handle',json_extract(payload_json,'$.role')) ELSE payload_json END,
        dispatched_at FROM lifecycle_events`,
      `UPDATE lifecycle_events_new SET payload_json = json_set(payload_json,'$.agentVersion',NULL,'$.agentSha',coalesce((SELECT agent_sha FROM runs WHERE id = run_id),''),'$.outputKind',coalesce((SELECT output_kind FROM runs WHERE id = run_id),'note')) WHERE type = 'run.started'`,
      `UPDATE lifecycle_events_new SET payload_json = json_set(payload_json,'$.errorCode',replace(json_extract(payload_json,'$.errorCode'),'ROLE_','RUN_')) WHERE type = 'run.failed'`,
      "DROP TABLE lifecycle_events",
      "ALTER TABLE lifecycle_events_new RENAME TO lifecycle_events",
      "CREATE INDEX lifecycle_by_change ON lifecycle_events(change_id,seq)",
      "CREATE INDEX lifecycle_by_causation ON lifecycle_events(causation_id)",
      "CREATE INDEX lifecycle_undispatched ON lifecycle_events(seq) WHERE dispatched_at IS NULL",
      `CREATE TABLE checkpoints_new(id TEXT PRIMARY KEY,turn_id TEXT,reason TEXT NOT NULL CHECK(reason IN ('turn_end','pre_revert','pre_sleep','pre_archive','sigterm','run_pin')),commit_sha TEXT NOT NULL,tree_sha TEXT NOT NULL,parent_sha TEXT NOT NULL,base_sha TEXT NOT NULL,r2_key TEXT,bundle_bytes INTEGER,local_only INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
      "INSERT INTO checkpoints_new SELECT id,turn_id,CASE reason WHEN 'role_pin' THEN 'run_pin' ELSE reason END,commit_sha,tree_sha,parent_sha,base_sha,r2_key,bundle_bytes,local_only,created_at FROM checkpoints",
      "DROP TABLE checkpoints",
      "ALTER TABLE checkpoints_new RENAME TO checkpoints",
      `CREATE TABLE items_new(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('user_message','agent_message','agent_thought','tool_call','plan','permission','notice','handoff','revert_marker','error','artifact','run','agent_proposal')),
        status TEXT NOT NULL CHECK(status IN ('streaming','pending','in_progress','completed','failed','cancelled')),content_json TEXT NOT NULL,rev INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
      "INSERT INTO items_new SELECT * FROM items",
      "DROP TABLE items",
      "ALTER TABLE items_new RENAME TO items",
      "CREATE INDEX items_by_session ON items(session_id,created_at)",
      "CREATE INDEX items_by_rev ON items(rev)",
    ],
  },
  {
    tag: "0011_agent_proposals",
    when: 1792612800000,
    statements: [
      `CREATE TABLE agent_proposals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected')), proposal_json TEXT NOT NULL)`,
    ],
  },
  {
    tag: "0012_session_agents",
    when: 1792699200000,
    statements: [
      "ALTER TABLE sessions RENAME COLUMN custom_agent_id TO agent_id",
      "ALTER TABLE sessions RENAME COLUMN custom_agent_name TO agent_name",
      "ALTER TABLE sessions RENAME COLUMN custom_agent_commit TO agent_sha",
      "ALTER TABLE sessions ADD COLUMN agent_version INTEGER",
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
