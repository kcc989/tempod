import {
  AGENT_IDS,
  ATTENTIONS,
  CHECKS_STATES,
  PROJECT_MEMBER_ROLES,
  PROJECT_VISIBILITIES,
  PR_STATES,
  WORKSPACE_STATES,
} from "@tempo/protocol";
import { sql } from "drizzle-orm";
import { primaryKey, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organization, user } from "./auth-schema.ts";

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
    installationId: integer("installation_id").references(() => githubInstallations.installationId),
    repoId: integer("repo_id"),
    provider: text("provider", { enum: ["github", "artifacts"] })
      .notNull()
      .default("github"),
    artifactRepoId: text("artifact_repo_id"),
    cloneUrl: text("clone_url"),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    settingsJson: text("settings_json").notNull().default("{}"),
    sortOrder: integer("sort_order").notNull().default(0),
    environmentId: text("environment_id").references(() => environments.id, { onDelete: "set null" }),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    visibility: text("visibility", { enum: PROJECT_VISIBILITIES }).notNull().default("private"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("projects_namespace_repo").on(sql`coalesce(${t.organizationId}, ${t.userId})`, t.repoId),
    uniqueIndex("projects_artifact_repo").on(t.artifactRepoId),
    uniqueIndex("projects_namespace_slug").on(
      sql`coalesce(${t.organizationId}, ${t.userId})`,
      sql`lower(${t.slug})`,
    ),
    index("projects_organization").on(t.organizationId),
    check("projects_provider", sql`${t.provider} IN ('github','artifacts')`),
    check("projects_visibility", sql`${t.visibility} IN ('public','private')`),
    check(
      "projects_repository",
      sql`(${t.provider} = 'github' AND ${t.installationId} IS NOT NULL AND ${t.repoId} IS NOT NULL) OR (${t.provider} = 'artifacts' AND ${t.artifactRepoId} IS NOT NULL AND ${t.cloneUrl} IS NOT NULL)`,
    ),
  ],
);

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    headBranch: text("head_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    state: text("state", { enum: ["open", "draft", "merged", "closed"] }).notNull(),
    headSha: text("head_sha"),
    baseSha: text("base_sha"),
    mergeSha: text("merge_sha"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    mergedAt: integer("merged_at"),
  },
  (t) => [
    uniqueIndex("pull_requests_project_number").on(t.projectId, t.number),
    uniqueIndex("pull_requests_project_open_head")
      .on(t.projectId, t.headBranch)
      .where(sql`state IN ('open','draft')`),
    check("pull_requests_state", sql`${t.state} IN ('open','draft','merged','closed')`),
  ],
);

export const issueNumbers = sqliteTable(
  "issue_numbers",
  {
    projectId: text("project_id")
      .primaryKey()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    lastNumber: integer("last_number").notNull(),
  },
  (t) => [check("issue_numbers_nonnegative", sql`${t.lastNumber} >= 0`)],
);

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    state: text("state", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [
    uniqueIndex("issues_project_number").on(t.projectId, t.number),
    index("issues_project_state_number").on(t.projectId, t.state, sql`${t.number} DESC`),
    check("issues_state", sql`${t.state} IN ('open','closed')`),
  ],
);

export const issueComments = sqliteTable(
  "issue_comments",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("issue_comments_issue_created").on(t.issueId, t.createdAt, t.id)],
);

export const repositoryLabels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    color: text("color").notNull(),
    description: text("description").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("labels_project_name").on(t.projectId, t.nameKey),
    check("labels_color", sql`length(${t.color}) = 6 AND ${t.color} NOT GLOB '*[^0-9a-f]*'`),
  ],
);

export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => repositoryLabels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.labelId] })],
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
    state: text("state", { enum: WORKSPACE_STATES }).notNull(),
    attention: text("attention", { enum: ATTENTIONS }).notNull().default("none"),
    defaultAgent: text("default_agent", { enum: AGENT_IDS }).notNull(),
    prNumber: integer("pr_number"),
    prState: text("pr_state", { enum: PR_STATES }),
    checksState: text("checks_state", { enum: CHECKS_STATES }),
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

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    definitionJson: text("definition_json").notNull(),
    version: integer("version").notNull(),
    sha: text("sha").notNull(),
    starter: text("starter"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    uniqueIndex("agents_active_handle")
      .on(t.userId, t.handle)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex("agents_active_name")
      .on(t.userId, t.name)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const projectAgents = sqliteTable(
  "project_agents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    enabled: integer("enabled").notNull().default(1),
    hooksJson: text("hooks_json").notNull().default("[]"),
    autoSend: integer("auto_send").notNull().default(0),
    maxRuns: integer("max_runs").notNull().default(3),
    timeout: text("timeout").notNull().default("20m"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("project_agents_project_agent").on(t.projectId, t.agentId)],
);

export const agentMigrations = sqliteTable("agent_migrations", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  migratedAt: integer("migrated_at").notNull(),
});

export type AgentRow = typeof agents.$inferSelect;

export type ProjectAgentRow = typeof projectAgents.$inferSelect;

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

export const agentProposalApplications = sqliteTable(
  "agent_proposal_applications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    guard: integer("guard").notNull(),
  },
  (t) => [check("agent_proposal_guard", sql`${t.guard} = 1`)],
);

/** 11, Project roles. */
export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: PROJECT_MEMBER_ROLES }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_user").on(t.userId),
    check("project_members_role", sql`${t.role} IN ('read','write','admin')`),
  ],
);

export const projectStars = sqliteTable(
  "project_stars",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] }), index("project_stars_project").on(t.projectId)],
);

export type PullRequestRow = typeof pullRequests.$inferSelect;

export type IssueRow = typeof issues.$inferSelect;

export type IssueCommentRow = typeof issueComments.$inferSelect;

export type RepositoryLabelRow = typeof repositoryLabels.$inferSelect;
