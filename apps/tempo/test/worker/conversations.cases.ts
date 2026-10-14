import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { env, runInDurableObject } from "cloudflare:test";
import { ConversationArtifact, newId, type ConversationArtifact as Artifact } from "@tempo/protocol";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  conversationKey,
  markConversationDirty,
  saveConversation,
} from "../../src/do/workspace/conversations.ts";
import { getProjectConversation, listProjectConversations } from "../../src/server/handlers/conversations.ts";
import { unlinkProject } from "../../src/server/handlers/projects.ts";
import { internals, seedProject, seedWorkspace } from "./fakes.ts";

const seed = async () => {
  const project = await seedProject();
  const w = await seedWorkspace(project, { prompt: "Remember this conversation" });
  await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
    const { core, runner } = internals(i);

    for (const op of core.ctx.storage.sql.exec("SELECT id FROM ops WHERE kind = 'create'").toArray())
      runner.cancel(String(op["id"]));
    core.updateWs({ state: "sleeping" });
    core.container = undefined;
    await core.ctx.storage.deleteAlarm();
  });
  const ctx = { env, user: { id: project.userId, name: "Owner", email: "owner@example.com", image: null } };
  const key = conversationKey(project.projectId, w.workspaceId);

  return { ...w, project, ctx, key };
};

describe("project conversation artifacts", () => {
  it("stores complete, ordered transcripts without a container or connected UI", async () => {
    const w = await seed();
    const itemId = newId();
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const { core } = internals(i);
      const s = core.ctx.storage.sql.exec("SELECT id FROM sessions").one();
      core.insertItem({
        id: itemId,
        sessionId: String(s["id"]),
        turnId: null,
        kind: "agent_message",
        status: "streaming",
        content: { text: "Hello" },
      });
      core.appendItemText(itemId, " again");
      await saveConversation(core);
      expect(core.kv("conversationDueAt")).toBeUndefined();
    });
    const obj = (await env.DATA.get(w.key))!;
    const artifact = Schema.decodeUnknownSync(ConversationArtifact)(await obj.json());
    expect(artifact).toMatchObject({
      version: 1,
      projectId: w.project.projectId,
      conversationId: w.workspaceId,
    });
    expect(artifact.sessions).toHaveLength(1);
    expect(artifact.turns[0]?.prompt.text).toBe("Remember this conversation");
    expect(artifact.items.find((i) => i.id === itemId)?.content).toEqual({ text: "Hello again" });
    expect(obj.httpMetadata?.contentType).toBe("application/json");
    expect(JSON.stringify(artifact)).not.toMatch(/tempodToken|previewToken|settingsJson|acpSessionId/);
  });

  it("retains dirty state on upload failure and retries through the durable alarm", async () => {
    const w = await seed();
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const { core } = internals(i);
      const put = vi.spyOn(core.env.DATA, "put").mockRejectedValueOnce(new Error("R2 unavailable"));
      await expect(saveConversation(core)).rejects.toThrow("R2 unavailable");
      expect(core.kv("conversationDueAt")).toBeTypeOf("number");
      put.mockRestore();
      core.setKv("conversationDueAt", Date.now() - 1);
    });
    await runInDurableObject(w.stub, (i: WorkspaceDO) => i.alarm());
    expect(await env.DATA.head(w.key)).not.toBeNull();
  });

  it("does not clear changes made during an upload or overwrite them with an older upload", async () => {
    const w = await seed();
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const { core } = internals(i);
      const put = core.env.DATA.put.bind(core.env.DATA);
      let release!: () => void;

      const gate = new Promise<void>((r) => {
        release = r;
      });

      const spy = vi.spyOn(core.env.DATA, "put").mockImplementationOnce(async (...args) => {
        await gate;

        return put(...args);
      });

      const first = saveConversation(core);
      core.updateWs({ title: "New title" });
      markConversationDirty(core);
      const second = saveConversation(core, true);
      release();
      await Promise.all([first, second]);
      spy.mockRestore();
      expect(core.kv("conversationDueAt")).toBeUndefined();
    });
    expect((await (await env.DATA.get(w.key))!.json<Artifact>()).title).toBe("New title");
  });

  it("lists project artifacts and checks project ownership and identity on reads", async () => {
    const w = await seed();
    const other = await seedProject();
    await w.stub.persistConversation();
    expect((await listProjectConversations(w.ctx, { projectId: w.project.projectId })).conversations).toEqual(
      [expect.objectContaining({ conversationId: w.workspaceId, projectId: w.project.projectId })],
    );
    expect(
      (await getProjectConversation(w.ctx, { projectId: w.project.projectId, conversationId: w.workspaceId }))
        .items.length,
    ).toBeGreaterThan(0);
    await expect(listProjectConversations(w.ctx, { projectId: other.projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      getProjectConversation(w.ctx, { projectId: w.project.projectId, conversationId: "../../other" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getProjectConversation(
        { ...w.ctx, user: { ...w.ctx.user, id: other.userId } },
        { projectId: other.projectId, conversationId: w.workspaceId },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the final conversation readable after workspace deletion", async () => {
    const w = await seed();
    await runInDurableObject(w.stub, (i: WorkspaceDO) => {
      const { core } = internals(i);
      core.updateWs({ state: "archived", title: "Final title", archivedAt: Date.now() });
    });
    expect((await w.stub.deleteWorkspace({})).ok).toBe(true);
    expect(
      await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(w.workspaceId).first(),
    ).toBeNull();

    const artifact = await getProjectConversation(w.ctx, {
      projectId: w.project.projectId,
      conversationId: w.workspaceId,
    });

    expect(artifact.title).toBe("Final title");
    expect(artifact.items[0]?.content).toMatchObject({ text: "Remember this conversation" });
    expect(
      (await listProjectConversations(w.ctx, { projectId: w.project.projectId })).conversations,
    ).toHaveLength(1);
  });

  it("does not delete a workspace if the final artifact upload fails", async () => {
    const w = await seed();
    await runInDurableObject(w.stub, async (i: WorkspaceDO) => {
      const { core } = internals(i);
      core.updateWs({ state: "archived" });
      const put = vi.spyOn(core.env.DATA, "put").mockRejectedValueOnce(new Error("unavailable"));
      const result = await i.deleteWorkspace({});
      put.mockRestore();
      expect(result.ok).toBe(false);
      expect(core.wsOrNull()).not.toBeNull();
    });
    expect(
      await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(w.workspaceId).first(),
    ).not.toBeNull();
  });

  it("keeps the project linked when an archived workspace cannot save its final transcript", async () => {
    const w = await seed();
    await runInDurableObject(w.stub, (i: WorkspaceDO) => internals(i).core.updateWs({ state: "archived" }));
    await env.DB.prepare("UPDATE workspaces SET state = 'archived', archived_at = ? WHERE id = ?")
      .bind(Date.now(), w.workspaceId)
      .run();

    const get = vi.spyOn(env.DATA, "put").mockRejectedValueOnce(new Error("Unavailable"));

    try {
      await expect(unlinkProject(w.ctx, { projectId: w.project.projectId })).rejects.toMatchObject({
        code: "INTERNAL",
      });
    } finally {
      get.mockRestore();
    }

    expect(
      await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(w.project.projectId).first(),
    ).not.toBeNull();
  });
});
