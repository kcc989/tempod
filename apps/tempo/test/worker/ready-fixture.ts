import { workspaceStub } from "../../src/do/workspace/stub.ts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "./test-env.ts";
import { newId, randomToken, type AgentId, type Settings } from "@tempo/protocol";
import { workspace } from "../../src/db/workspace-do.ts";
import { json } from "../../src/db/json.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import {
  DEFAULT_EFFECTIVE,
  OWNER_GITHUB_ID,
  installFakes,
  internals,
  seedCredentials,
  seedProject,
} from "./fakes.ts";

export interface ReadyFixtureOptions {
  readonly title?: string;
  readonly slug?: string;
  readonly branch?: string;
  readonly settings?: Settings;
  readonly credentials?: readonly AgentId[];
}

/** Fresh, sessionless ready state for RPC contracts; lifecycle tests must use seedWorkspace. */
export const seedReadyWorkspace = async (options: ReadyFixtureOptions = {}) => {
  const seeded = await seedProject();

  if (options.credentials?.length) await seedCredentials(seeded.userId, options.credentials);
  const workspaceId = newId();
  const slug = options.slug ?? `ready-${workspaceId}`;
  const branch = options.branch ?? `tempo/${slug}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO workspaces (id, project_id, user_id, slug, title, branch, base_branch, state, attention, default_agent, pinned, last_activity_at, created_at, summary_rev) VALUES (?, ?, ?, ?, ?, ?, 'main', 'ready', 'none', 'claude', 0, ?, ?, 0)",
  )
    .bind(workspaceId, seeded.projectId, seeded.userId, slug, options.title ?? slug, branch, now, now)
    .run();
  const stub = workspaceStub(env.WORKSPACE, workspaceId);
  const { container, tempod } = await installFakes(stub);
  await runInDurableObject(stub, async (instance: WorkspaceDO) => {
    const core = internals(instance).core;
    core.db
      .insert(workspace)
      .values({
        id: 1,
        workspaceId,
        projectId: seeded.projectId,
        userId: seeded.userId,
        slug,
        title: options.title ?? slug,
        branch,
        baseBranch: "main",
        sourceJson: json.source.write({ kind: "new" }),
        defaultAgent: "claude",
        pinned: 0,
        createdAt: now,
        archivedAt: null,
        state: "ready",
        stateSince: now,
        errorCode: null,
        errorDetail: null,
        attention: "none",
        setupStatus: "none",
        previewKey: randomToken(32),
        settingsJson: json.settings.write(options.settings ?? DEFAULT_EFFECTIVE),
        pushed: 0,
        prNumber: null,
        prState: null,
        checksState: null,
        lastActivityAt: now,
        lastViewedAt: now,
        tempodToken: randomToken(32),
        tempodIncarnation: tempod.incarnation,
        tempodAckedSeq: 0,
        lastPushedSha: null,
        forcePushLease: 0,
        autoRestartsJson: "[]",
        imageRef: container.images["workspace"] ?? null,
        summaryRev: 0,
        itemsRev: 0,
      })
      .run();
    core.setKv("author", { name: "Owner", email: `${OWNER_GITHUB_ID}+owner@users.noreply.github.com` });
    container.running = true;
    core.tempodVersion = tempod.version;
    await core.lifecycle.load();
    await instance.reconnectTempod();
    core.publish();
  });

  return { workspaceId, stub, seeded, tempod, container, slug, branch };
};
