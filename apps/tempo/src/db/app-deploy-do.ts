import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 12, Components: AppDeployDO's own SQLite. */
export const deployConfigs = sqliteTable("configs", {
  revision: integer("revision").primaryKey(),
  source: text("source").notNull(),
  specJson: text("spec_json"),
  createdAt: integer("created_at").notNull(),
});

export const deployments = sqliteTable("deployments", {
  id: text("id").primaryKey(),
  number: integer("number").notNull(),
  target: text("target").notNull(),
  stage: text("stage").notNull(),
  branch: text("branch").notNull(),
  sha: text("sha").notNull(),
  revision: integer("revision").notNull(),
  trigger: text("trigger", { enum: ["manual", "agent", "auto", "redeploy"] }).notNull(),
  status: text("status", { enum: ["queued", "running", "completed"] }).notNull(),
  conclusion: text("conclusion", { enum: ["success", "failure", "cancelled", "timed_out"] }),
  exitCode: integer("exit_code"),
  summary: text("summary"),
  workspaceId: text("workspace_id"),
  planJson: text("plan_json").notNull(),
  token: text("token"),
  accountId: text("account_id"),
  cfTokenId: text("cf_token_id"),
  tokenExpiresAt: integer("token_expires_at"),
  tokenRevoked: integer("token_revoked").notNull(),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
  phase: text("phase", { enum: ["canary", "promoted", "full", "rolled_back"] }),
  canaryUntil: integer("canary_until"),
  rolledBackAt: integer("rolled_back_at"),
  gateFailure: text("gate_failure"),
  rolloutJson: text("rollout_json"),
});

/** 12, Gradual rollout: Events. */
export const deployEvents = sqliteTable("events", {
  id: text("id").primaryKey(),
  deploymentId: text("deployment_id").notNull(),
  type: text("type", {
    enum: [
      "deploy.version.uploaded",
      "deploy.traffic.changed",
      "deploy.rolled_back",
      "prod.error.seen",
      "prod.error.fixed",
    ],
  }).notNull(),
  at: integer("at").notNull(),
  payloadJson: text("payload_json").notNull(),
});

export const deployKv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

/** 12, Production errors. */
export const prodErrors = sqliteTable("errors", {
  id: text("id").primaryKey(),
  issueKey: text("issue_key").notNull(),
  worker: text("worker"),
  versionId: text("version_id"),
  deploymentId: text("deployment_id"),
  title: text("title").notNull(),
  text: text("text").notNull(),
  occurrences: integer("occurrences").notNull(),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  fixWorkspaceId: text("fix_workspace_id"),
  fixClaimedAt: integer("fix_claimed_at"),
  fixCheckAt: integer("fix_check_at"),
  fixedAt: integer("fixed_at"),
});

/** 13, L-ADR-3: project profile revisions. */
export const profiles = sqliteTable("profiles", {
  revision: integer("revision").primaryKey(),
  source: text("source").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const manifests = sqliteTable("manifests", {
  sha256: text("sha256").primaryKey(),
  revision: integer("revision").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const appDeploySchema = {
  deployConfigs,
  deployments,
  deployKv,
  deployEvents,
  prodErrors,
  profiles,
  manifests,
};
