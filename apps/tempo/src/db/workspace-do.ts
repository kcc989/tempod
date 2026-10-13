import {
  ARTIFACT_KINDS,
  ARTIFACT_STATUSES,
  AGENT_IDS,
  ATTENTIONS,
  CHECKPOINT_REASONS,
  CHECKS_STATES,
  ITEM_KINDS,
  ITEM_STATUSES,
  OP_KINDS,
  OP_STATUSES,
  PERMISSION_STATUSES,
  PR_STATES,
  REVIEW_SIDES,
  REVIEW_STATUSES,
  SCRIPT_KINDS,
  SCRIPT_RUN_STATUSES,
  SESSION_STATUSES,
  SETUP_STATUSES,
  TURN_STATUSES,
  WORKSPACE_STATES,
} from "@tempo/protocol";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** WorkspaceDO SQLite (02). DDL lives in do-migrations.ts; these tables type the queries. */
export const workspace = sqliteTable("workspace", {
  id: integer("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  defaultAgent: text("default_agent", { enum: AGENT_IDS }).notNull(),
  pinned: integer("pinned").notNull(),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
  branch: text("branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  sourceJson: text("source_json").notNull(),
  state: text("state", { enum: WORKSPACE_STATES }).notNull(),
  stateSince: integer("state_since").notNull(),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  attention: text("attention", { enum: ATTENTIONS }).notNull(),
  setupStatus: text("setup_status", { enum: SETUP_STATUSES }).notNull(),
  // Unused since 0003_preview_access; 05 Upgrades forbids dropping a column.
  previewToken: text("preview_token")
    .notNull()
    .$defaultFn(() => ""),
  previewKey: text("preview_key").notNull(),
  browserSessionId: text("browser_session_id"),
  settingsJson: text("settings_json").notNull(),
  pushed: integer("pushed").notNull(),
  prNumber: integer("pr_number"),
  prState: text("pr_state", { enum: PR_STATES }),
  checksState: text("checks_state", { enum: CHECKS_STATES }),
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
  environmentId: text("environment_id"),
});

export const ops = sqliteTable("ops", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: OP_KINDS }).notNull(),
  step: text("step").notNull(),
  status: text("status", { enum: OP_STATUSES }).notNull(),
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
  agent: text("agent", { enum: AGENT_IDS }).notNull(),
  title: text("title").notNull(),
  acpSessionId: text("acp_session_id"),
  status: text("status", { enum: SESSION_STATUSES }).notNull(),
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
  roleRunId: text("role_run_id"),
  customAgentId: text("custom_agent_id"),
  customAgentName: text("custom_agent_name"),
  customAgentCommit: text("custom_agent_commit"),
  profileJson: text("profile_json"),
  profileIssuesJson: text("profile_issues_json").notNull().default("[]"),
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
  changeId: text("change_id"),
  origin: text("origin").notNull().default("user"),
  steeringPending: integer("steering_pending").notNull().default(0),
  status: text("status", { enum: TURN_STATUSES }).notNull(),
  promptJson: text("prompt_json").notNull(),
  stopReason: text("stop_reason"),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  checkpointId: text("checkpoint_id"),
  reverted: integer("reverted").notNull(),
  queuedAt: integer("queued_at").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
  usageJson: text("usage_json"),
});

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  turnId: text("turn_id"),
  kind: text("kind", { enum: ITEM_KINDS }).notNull(),
  status: text("status", { enum: ITEM_STATUSES }).notNull(),
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
  reason: text("reason", { enum: CHECKPOINT_REASONS }).notNull(),
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
  side: text("side", { enum: REVIEW_SIDES }),
  body: text("body").notNull(),
  status: text("status", { enum: REVIEW_STATUSES }).notNull(),
  sentTurnId: text("sent_turn_id"),
  createdAt: integer("created_at").notNull(),
});

export const scriptRuns = sqliteTable("script_runs", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: SCRIPT_KINDS }).notNull(),
  scriptId: text("script_id"),
  command: text("command").notNull(),
  status: text("status", { enum: SCRIPT_RUN_STATUSES }).notNull(),
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
  status: text("status", { enum: PERMISSION_STATUSES }).notNull(),
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

export const previewCodes = sqliteTable("preview_codes", {
  codeHash: text("code_hash").primaryKey(),
  port: integer("port").notNull(),
  expiresAt: integer("expires_at").notNull(),
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

export const fileCache = sqliteTable("file_cache", {
  path: text("path").primaryKey(),
  responseJson: text("response_json"),
  bytes: integer("bytes").notNull().default(0),
  updatedAt: integer("updated_at").notNull().default(0),
});

export const environmentProposals = sqliteTable("environment_proposals", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  status: text("status", { enum: ["pending", "applied", "dismissed"] }).notNull(),
  proposalJson: text("proposal_json").notNull(),
});

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    itemId: text("item_id").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    mime: text("mime").notNull(),
    kind: text("kind", { enum: ARTIFACT_KINDS }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    stagedPath: text("staged_path").notNull(),
    status: text("status", { enum: ARTIFACT_STATUSES }).notNull(),
    attempt: integer("attempt").notNull().default(0),
    r2Key: text("r2_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] })],
);

export const artifactCodes = sqliteTable("artifact_codes", {
  codeHash: text("code_hash").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  version: integer("version").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const lifecycleEvents = sqliteTable("lifecycle_events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  type: text("type").notNull(),
  source: text("source").notNull(),
  occurredAt: integer("occurred_at").notNull(),
  changeId: text("change_id"),
  turnId: text("turn_id"),
  roleRunId: text("role_run_id"),
  sessionId: text("session_id"),
  agent: text("agent"),
  causationId: text("causation_id"),
  dedupeKey: text("dedupe_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  dispatchedAt: integer("dispatched_at"),
});

export const roleRuns = sqliteTable("role_runs", {
  id: text("id").primaryKey(),
  changeId: text("change_id").notNull(),
  parentRunId: text("parent_run_id"),
  depth: integer("depth").notNull(),
  roleName: text("role_name").notNull(),
  scope: text("scope").notNull(),
  roleSha: text("role_sha").notNull(),
  triggerEventId: text("trigger_event_id").notNull(),
  sessionId: text("session_id"),
  agent: text("agent"),
  access: text("access").notNull(),
  status: text("status").notNull(),
  round: integer("round").notNull(),
  continuesUsed: integer("continues_used").notNull().default(0),
  tokens: integer("tokens").notNull().default(0),
  pinCheckpointId: text("pin_checkpoint_id"),
  resultJson: text("result_json"),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  deadlineAt: integer("deadline_at"),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
});

export type LifecycleRow = typeof lifecycleEvents.$inferSelect;

export type RoleRunRow = typeof roleRuns.$inferSelect;

export const workspaceSchema = {
  lifecycleEvents,
  roleRuns,
  artifacts,
  artifactCodes,
  environmentProposals,
  fileCache,
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
  previewCodes,
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

export type ArtifactRow = typeof artifacts.$inferSelect;
