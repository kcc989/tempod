import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema.ts";

export * from "./auth-schema.ts";

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull().unique(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type", { enum: ["User", "Organization"] }).notNull(),
    suspendedAt: integer("suspended_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [check("github_installations_account_type", sql`${t.accountType} IN ('User','Organization')`)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallations.installationId),
    repoId: integer("repo_id").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    settingsJson: text("settings_json").notNull().default("{}"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("projects_user_repo").on(t.userId, t.repoId)],
);

export const WORKSPACE_STATE_SQL = sql`('creating','starting','setting_up','ready','working','stopping','sleeping','archiving','archived','error')`;

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull().default(""),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    state: text("state").notNull(),
    attention: text("attention").notNull().default("none"),
    defaultAgent: text("default_agent").notNull(),
    prNumber: integer("pr_number"),
    prState: text("pr_state"),
    checksState: text("checks_state"),
    pinned: integer("pinned").notNull().default(0),
    lastActivityAt: integer("last_activity_at").notNull(),
    createdAt: integer("created_at").notNull(),
    archivedAt: integer("archived_at"),
    summaryRev: integer("summary_rev").notNull().default(0),
  },
  (t) => [
    check(
      "workspaces_state",
      sql`${t.state} IN ('creating','starting','setting_up','ready','working','stopping','sleeping','archiving','archived','error')`,
    ),
    check("workspaces_attention", sql`${t.attention} IN ('none','unread','needs_input','error')`),
    check("workspaces_default_agent", sql`${t.defaultAgent} IN ('claude','codex','opencode','pi')`),
    check("workspaces_pr_state", sql`${t.prState} IN ('open','draft','merged','closed')`),
    check("workspaces_checks_state", sql`${t.checksState} IN ('pending','success','failure')`),
    uniqueIndex("workspaces_active_slug").on(t.projectId, t.slug).where(sql`archived_at IS NULL`),
    uniqueIndex("workspaces_active_branch").on(t.projectId, t.branch).where(sql`archived_at IS NULL`),
    index("workspaces_by_activity").on(t.userId, t.archivedAt, sql`last_activity_at DESC`),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type InstallationRow = typeof githubInstallations.$inferSelect;
