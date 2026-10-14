import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Artifacts forward migration", () => {
  it("preserves projects, environments, workspaces, agent attachments and proposal receipts", async () => {
    const db = env.TEST_LEGACY_DB;

    if (!db) throw new Error("Legacy migration test database is not configured");
    const migrations = env.TEST_MIGRATIONS;

    if (!migrations) throw new Error("Test D1 migrations are not configured");
    const forgeIndex = migrations.findIndex((migration) => migration.name.includes("0007_artifacts"));

    if (forgeIndex < 0) throw new Error("Artifacts migration is missing");
    await applyD1Migrations(db, migrations.slice(0, forgeIndex));
    await db.batch([
      db.prepare(
        "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','Owner','owner@example.com',1,1,2)",
      ),
      db.prepare(
        "INSERT INTO github_installations (id,user_id,installation_id,account_login,account_type,created_at) VALUES ('installation','owner',42,'owner','User',3)",
      ),
      db.prepare(
        "INSERT INTO environments (id,user_id,name,created_at,updated_at) VALUES ('environment','owner','Preserve environment',3,4)",
      ),
      db.prepare(
        "INSERT INTO projects (id,user_id,installation_id,repo_id,repo_owner,repo_name,default_branch,settings_json,sort_order,environment_id,created_at,updated_at) VALUES ('project','owner',42,99,'owner','repo','main','{\"agent\":{\"default\":\"codex\"}}',7,'environment',4,5)",
      ),
      db.prepare(
        "INSERT INTO workspaces (id,project_id,user_id,slug,title,branch,base_branch,state,attention,default_agent,pr_number,pr_state,checks_state,pinned,last_activity_at,created_at,summary_rev) VALUES ('workspace','project','owner','lisbon','Keep me','tempo/lisbon','main','sleeping','unread','codex',12,'open','pending',1,9,6,17)",
      ),
      db.prepare(
        "INSERT INTO workspaces (id,project_id,user_id,slug,title,branch,base_branch,state,attention,default_agent,last_activity_at,created_at,archived_at,summary_rev) VALUES ('archived','project','owner','porto','Archived','tempo/porto','main','archived','none','claude',10,7,8,23)",
      ),
      db.prepare(
        "INSERT INTO agents (id,user_id,handle,name,definition_json,version,sha,created_at,updated_at) VALUES ('agent','owner','reviewer','Reviewer','{}',2,'sha',4,5)",
      ),
      db.prepare(
        "INSERT INTO project_agents (id,project_id,agent_id,enabled,hooks_json,auto_send,max_runs,timeout,created_at,updated_at) VALUES ('attachment','project','agent',1,'[]',1,4,'30m',5,6)",
      ),
      db.prepare(
        "INSERT INTO agent_proposal_applications (id,user_id,workspace_id,created_at,guard) VALUES ('receipt','owner','workspace',6,1)",
      ),
    ]);
    const projectsBefore = (await db.prepare("SELECT * FROM projects ORDER BY id").all()).results;
    const workspacesBefore = (await db.prepare("SELECT * FROM workspaces ORDER BY id").all()).results;
    const attachmentsBefore = (await db.prepare("SELECT * FROM project_agents").all()).results;
    const receiptsBefore = (await db.prepare("SELECT * FROM agent_proposal_applications").all()).results;
    const environmentsBefore = (await db.prepare("SELECT * FROM environments").all()).results;
    const counterIndex = migrations.findIndex((migration) => migration.name.includes("0009_issue_numbers"));

    if (counterIndex < 0) throw new Error("Issue counter migration is missing");
    await applyD1Migrations(db, migrations.slice(0, counterIndex));
    await db
      .prepare(
        "INSERT INTO issues (id,project_id,number,title,body,state,author_id,created_at,updated_at) VALUES ('legacy-issue','project',37,'Preserve issue','Preserve body','open','owner',10,11)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO issue_comments (id,issue_id,author_id,body,created_at,updated_at) VALUES ('legacy-comment','legacy-issue','owner','Preserve reply',12,13)",
      )
      .run();
    // 11, migration: later rows with a taken name get `<repo_owner>-<repo_name>`, then `-<id>`.
    await db.batch([
      db.prepare(
        "INSERT INTO projects (id,user_id,installation_id,repo_id,repo_owner,repo_name,default_branch,created_at,updated_at) VALUES ('same-name','owner',42,100,'fork','REPO','main',6,6)",
      ),
      db.prepare(
        "INSERT INTO projects (id,user_id,installation_id,repo_id,repo_owner,repo_name,default_branch,created_at,updated_at) VALUES ('third','owner',42,101,'fork','Repo','main',7,7)",
      ),
    ]);
    await applyD1Migrations(db, migrations);
    expect(
      (await db.prepare("SELECT id,slug FROM projects WHERE id <> 'project' ORDER BY id").all()).results,
    ).toEqual([
      { id: "same-name", slug: "fork-REPO" },
      { id: "third", slug: "fork-Repo-third" },
    ]);
    expect(
      await db
        .prepare("SELECT last_number FROM issue_numbers WHERE project_id='project'")
        .first("last_number"),
    ).toBe(37);
    expect(await db.prepare("SELECT title,body FROM issues WHERE id='legacy-issue'").first()).toEqual({
      title: "Preserve issue",
      body: "Preserve body",
    });
    expect(await db.prepare("SELECT body FROM issue_comments WHERE id='legacy-comment'").first("body")).toBe(
      "Preserve reply",
    );
    expect((await db.prepare("SELECT * FROM workspaces ORDER BY id").all()).results).toEqual(
      workspacesBefore,
    );
    const projectsAfter = (await db.prepare("SELECT * FROM projects WHERE id = 'project'").all()).results;
    expect(projectsAfter).toEqual(
      projectsBefore.map((p) => ({
        ...p,
        provider: "github",
        artifact_repo_id: null,
        clone_url: null,
        slug: "repo",
        visibility: "private",
        pinned_at: null,
      })),
    );
    expect((await db.prepare("SELECT * FROM project_agents").all()).results).toEqual(attachmentsBefore);
    expect((await db.prepare("SELECT * FROM agent_proposal_applications").all()).results).toEqual(
      receiptsBefore,
    );
    expect((await db.prepare("SELECT * FROM environments").all()).results).toEqual(environmentsBefore);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await db
      .prepare(
        "INSERT INTO projects (id,user_id,provider,artifact_repo_id,clone_url,repo_owner,repo_name,slug,default_branch,created_at,updated_at) VALUES ('native','owner','artifacts','artifact-id','https://git.example/repo.git','tempo','native','native','main',11,11)",
      )
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO projects (id,user_id,installation_id,repo_id,repo_owner,repo_name,slug,default_branch,created_at,updated_at) VALUES ('clash','owner',42,102,'x','y','Native','main',11,11)",
        )
        .run(),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT installation_id,repo_id FROM projects WHERE id='native'").first(),
    ).toEqual({ installation_id: null, repo_id: null });
    await db
      .prepare(
        "INSERT INTO pull_requests (id,project_id,number,title,body,head_branch,base_branch,state,created_at,updated_at) VALUES ('pull','native',1,'PR','','tempo/lisbon','main','open',12,12)",
      )
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO pull_requests (id,project_id,number,title,body,head_branch,base_branch,state,created_at,updated_at) VALUES ('duplicate','native',2,'Duplicate','','tempo/lisbon','main','draft',13,13)",
        )
        .run(),
    ).rejects.toThrow();
    await db.prepare("DELETE FROM projects WHERE id IN ('project','same-name','third')").run();
    expect((await db.prepare("SELECT * FROM workspaces").all()).results).toEqual([]);
    expect(await db.prepare("SELECT count(*) AS n FROM issue_numbers").first("n")).toBe(0);
    await expect(db.prepare("SELECT * FROM projects_migration_workspaces").all()).rejects.toThrow();
  });
});
