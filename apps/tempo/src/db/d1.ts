import { sql } from "drizzle-orm";
import { primaryKey, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    egressPolicy: text("egress_policy", { enum: ["open", "allowlist"] })
      .notNull()
      .default("allowlist"),
    egressAllowlistJson: text("egress_allowlist_json").notNull().default("[]"),
    secretsJson: text("secrets_json").notNull().default("[]"),
    injectorsJson: text("injectors_json").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("environments_user_name").on(t.userId, t.name),
    check("environments_egress_policy", sql`${t.egressPolicy} IN ('open','allowlist')`),
  ],
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
    environmentId: text("environment_id").references(() => environments.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("projects_user_repo").on(t.userId, t.repoId)],
);

export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    transport: text("transport", { enum: ["stdio", "http", "sse"] }).notNull(),
    enabled: integer("enabled").notNull().default(1),
    command: text("command"),
    argsJson: text("args_json").notNull().default("[]"),
    envJson: text("env_json").notNull().default("[]"),
    url: text("url"),
    headersJson: text("headers_json").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("mcp_servers_transport", sql`${t.transport} IN ('stdio','http','sse')`),
    uniqueIndex("mcp_servers_user_name").on(t.userId, t.name),
  ],
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
    uniqueIndex("workspaces_active_slug")
      .on(t.projectId, t.slug)
      .where(sql`archived_at IS NULL`),
    uniqueIndex("workspaces_active_branch")
      .on(t.projectId, t.branch)
      .where(sql`archived_at IS NULL`),
    index("workspaces_by_activity").on(t.userId, t.archivedAt, sql`last_activity_at DESC`),
  ],
);

/** Pointer to a custom agent file in the user's Artifacts repo (02, Custom agents). */
export const customAgents = sqliteTable(
  "custom_agents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    baseAgent: text("base_agent").notNull(),
    repo: text("repo").notNull(),
    path: text("path").notNull(),
    commitSha: text("commit_sha").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    check("custom_agents_base_agent", sql`${t.baseAgent} IN ('claude','codex','opencode','pi')`),
    uniqueIndex("custom_agents_active_name")
      .on(t.userId, t.name)
      .where(sql`deleted_at IS NULL`),
  ],
);

export type CustomAgentRow = typeof customAgents.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;
export type McpServerRow = typeof mcpServers.$inferSelect;
export type InstallationRow = typeof githubInstallations.$inferSelect;

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    text: text("text").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.name] })],
);
