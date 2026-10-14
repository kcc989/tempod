import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 10, Components: RepositoryCiDO's own SQLite. */
export const pipelines = sqliteTable("pipelines", {
  revision: integer("revision").primaryKey(),
  source: text("source").notNull(),
  specJson: text("spec_json"),
  createdAt: integer("created_at").notNull(),
});

export const ciRuns = sqliteTable("runs", {
  id: text("id").primaryKey(),
  number: integer("number").notNull(),
  branch: text("branch").notNull(),
  sha: text("sha").notNull(),
  revision: integer("revision").notNull(),
  attempt: integer("attempt").notNull(),
  trigger: text("trigger", { enum: ["push", "manual", "rerun"] }).notNull(),
  status: text("status", { enum: ["queued", "running", "completed"] }).notNull(),
  conclusion: text("conclusion", { enum: ["success", "failure", "cancelled"] }),
  requiredJson: text("required_json").notNull(),
  egressJson: text("egress_json").notNull(),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
});

export const ciJobs = sqliteTable(
  "jobs",
  {
    runId: text("run_id").notNull(),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    needsJson: text("needs_json").notNull(),
    command: text("command").notNull(),
    timeoutMinutes: integer("timeout_minutes").notNull(),
    status: text("status", { enum: ["queued", "running", "completed"] }).notNull(),
    conclusion: text("conclusion", { enum: ["success", "failure", "cancelled", "timed_out", "skipped"] }),
    exitCode: integer("exit_code"),
    summary: text("summary"),
    token: text("token"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.key] })],
);

export const ciBranches = sqliteTable("branches", {
  name: text("name").primaryKey(),
  sha: text("sha").notNull(),
});

export const ciKv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const repositoryCiSchema = { pipelines, ciRuns, ciJobs, ciBranches, ciKv };
