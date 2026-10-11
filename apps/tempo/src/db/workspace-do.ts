import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** WorkspaceDO SQLite (02). DDL lives in do-migrations.ts; these tables type the queries. */

export const workspace = sqliteTable("workspace", {
  id: integer("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  defaultAgent: text("default_agent").notNull(),
  pinned: integer("pinned").notNull(),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
  branch: text("branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  sourceJson: text("source_json").notNull(),
  state: text("state").notNull(),
  stateSince: integer("state_since").notNull(),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  attention: text("attention").notNull(),
  setupStatus: text("setup_status").notNull(),
  previewToken: text("preview_token").notNull(),
  settingsJson: text("settings_json").notNull(),
  pushed: integer("pushed").notNull(),
  prNumber: integer("pr_number"),
  prState: text("pr_state"),
  checksState: text("checks_state"),
  lastActivityAt: integer("last_activity_at").notNull(),
  lastViewedAt: integer("last_viewed_at"),
  tempodToken: text("tempod_token"),
  tempodIncarnation: text("tempod_incarnation"),
  lastPushedSha: text("last_pushed_sha"),
  forcePushLease: integer("force_push_lease").notNull(),
  autoRestartsJson: text("auto_restarts_json").notNull(),
  tempodAckedSeq: integer("tempod_acked_seq").notNull(),
  imageRef: text("image_ref"),
  summaryRev: integer("summary_rev").notNull(),
  itemsRev: integer("items_rev").notNull(),
});

export const ops = sqliteTable("ops", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  step: text("step").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull(),
  nextRunAt: integer("next_run_at").notNull(),
  inputJson: text("input_json").notNull(),
  stateJson: text("state_json").notNull(),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull(),
  title: text("title").notNull(),
  acpSessionId: text("acp_session_id"),
  status: text("status").notNull(),
  modeId: text("mode_id"),
  configJson: text("config_json").notNull(),
  modesJson: text("modes_json").notNull(),
  configOptionsJson: text("config_options_json").notNull(),
  commandsJson: text("commands_json").notNull(),
  capabilitiesJson: text("capabilities_json").notNull(),
  usageJson: text("usage_json").notNull(),
  handoffPending: integer("handoff_pending").notNull(),
  pendingNote: text("pending_note"),
  generalPromptSent: integer("general_prompt_sent").notNull(),
  sortOrder: integer("sort_order").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  closedAt: integer("closed_at"),
});

export const turns = sqliteTable("turns", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  queuePos: integer("queue_pos"),
  status: text("status").notNull(),
  promptJson: text("prompt_json").notNull(),
  stopReason: text("stop_reason"),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  checkpointId: text("checkpoint_id"),
  reverted: integer("reverted").notNull(),
  queuedAt: integer("queued_at").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
});

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  turnId: text("turn_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  contentJson: text("content_json").notNull(),
  rev: integer("rev").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  incarnation: text("incarnation").notNull(),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  receivedAt: integer("received_at").notNull(),
});

export const checkpoints = sqliteTable("checkpoints", {
  id: text("id").primaryKey(),
  turnId: text("turn_id"),
  reason: text("reason").notNull(),
  commitSha: text("commit_sha").notNull(),
  treeSha: text("tree_sha").notNull(),
  parentSha: text("parent_sha").notNull(),
  baseSha: text("base_sha").notNull(),
  r2Key: text("r2_key"),
  bundleBytes: integer("bundle_bytes"),
  localOnly: integer("local_only").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  imageRef: text("image_ref").notNull(),
  createdAt: integer("created_at").notNull(),
  lastRestoredAt: integer("last_restored_at"),
  unusable: integer("unusable").notNull(),
});

export const homeBackups = sqliteTable("home_backups", {
  id: text("id").primaryKey(),
  recordJson: text("record_json").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const reviewComments = sqliteTable("review_comments", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  lineStart: integer("line_start"),
  lineEnd: integer("line_end"),
  side: text("side"),
  body: text("body").notNull(),
  status: text("status").notNull(),
  sentTurnId: text("sent_turn_id"),
  createdAt: integer("created_at").notNull(),
});

export const scriptRuns = sqliteTable("script_runs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  scriptId: text("script_id"),
  command: text("command").notNull(),
  status: text("status").notNull(),
  exitCode: integer("exit_code"),
  signal: text("signal"),
  logTail: text("log_tail").notNull(),
  r2Key: text("r2_key"),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
});

export const ports = sqliteTable("ports", {
  port: integer("port").primaryKey(),
  firstSeenAt: integer("first_seen_at").notNull(),
});

export const permissions = sqliteTable("permissions", {
  requestId: text("request_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  turnId: text("turn_id").notNull(),
  itemId: text("item_id").notNull(),
  optionsJson: text("options_json").notNull(),
  status: text("status").notNull(),
  chosenOptionId: text("chosen_option_id"),
  createdAt: integer("created_at").notNull(),
  answeredAt: integer("answered_at"),
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  turnId: text("turn_id"),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  r2Key: text("r2_key").notNull(),
  containerPath: text("container_path"),
  createdAt: integer("created_at").notNull(),
});

export const egressLog = sqliteTable("egress_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  method: text("method").notNull(),
  host: text("host").notNull(),
  path: text("path").notNull(),
  status: integer("status").notNull(),
  ms: integer("ms").notNull(),
  rule: integer("rule").notNull(),
});

export const workspaceSchema = {
  workspace,
  ops,
  sessions,
  turns,
  items,
  events,
  checkpoints,
  snapshots,
  homeBackups,
  reviewComments,
  scriptRuns,
  ports,
  permissions,
  attachments,
  egressLog,
};

export type WorkspaceRowDO = typeof workspace.$inferSelect;
export type OpRow = typeof ops.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type CheckpointRow = typeof checkpoints.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type ScriptRunRow = typeof scriptRuns.$inferSelect;
export type ReviewCommentRow = typeof reviewComments.$inferSelect;
export type PermissionRow = typeof permissions.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;

