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
});

export const deployKv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const appDeploySchema = { deployConfigs, deployments, deployKv };
