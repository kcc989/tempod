PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE projects_migration_workspaces AS SELECT * FROM workspaces;
--> statement-breakpoint
CREATE TABLE projects_migration_attachments AS SELECT * FROM project_agents;
--> statement-breakpoint
CREATE TABLE projects_migration_receipts AS SELECT * FROM agent_proposal_applications;
--> statement-breakpoint
CREATE TABLE projects_new (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  installation_id INTEGER REFERENCES github_installations(installation_id),
  repo_id INTEGER,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github','artifacts')),
  artifact_repo_id TEXT,
  clone_url TEXT,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT projects_repository CHECK (
    (provider = 'github' AND installation_id IS NOT NULL AND repo_id IS NOT NULL) OR
    (provider = 'artifacts' AND artifact_repo_id IS NOT NULL AND clone_url IS NOT NULL)
  )
);
--> statement-breakpoint
INSERT INTO projects_new (id, user_id, installation_id, repo_id, repo_owner, repo_name, default_branch, settings_json, sort_order, environment_id, created_at, updated_at)
SELECT id, user_id, installation_id, repo_id, repo_owner, repo_name, default_branch, settings_json, sort_order, environment_id, created_at, updated_at FROM projects;
--> statement-breakpoint
DROP TABLE projects;
--> statement-breakpoint
ALTER TABLE projects_new RENAME TO projects;
--> statement-breakpoint
CREATE UNIQUE INDEX projects_user_repo ON projects(user_id, repo_id);
--> statement-breakpoint
CREATE UNIQUE INDEX projects_user_artifact_repo ON projects(user_id, artifact_repo_id);
--> statement-breakpoint
INSERT INTO workspaces SELECT * FROM projects_migration_workspaces;
--> statement-breakpoint
INSERT INTO project_agents SELECT * FROM projects_migration_attachments;
--> statement-breakpoint
INSERT INTO agent_proposal_applications SELECT * FROM projects_migration_receipts;
--> statement-breakpoint
DROP TABLE projects_migration_attachments;
--> statement-breakpoint
DROP TABLE projects_migration_receipts;
--> statement-breakpoint
DROP TABLE projects_migration_workspaces;
--> statement-breakpoint
CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','draft','merged','closed')),
  head_sha TEXT,
  base_sha TEXT,
  merge_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  merged_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX pull_requests_project_number ON pull_requests(project_id, number);
--> statement-breakpoint
CREATE UNIQUE INDEX pull_requests_project_open_head ON pull_requests(project_id, head_branch) WHERE state IN ('open','draft');
--> statement-breakpoint
PRAGMA defer_foreign_keys = OFF;
