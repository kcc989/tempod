import { unwrap, type Result, type Session } from "@tempo/protocol";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { internals, seedCredentials, seedProject, seedWorkspace, waitFor, driveToState } from "./fakes.ts";

describe("create op with fakes", () => {
  it("starts the container, connects, clones, reads settings and becomes ready, then runs the first turn", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub, tempod, container } = await seedWorkspace(seeded, { prompt: "Add a README" });
    expect((await stub.getWorkspace({})).ok).toBe(true);
    for (let i = 0; i < 10; i++) {
      await runDurableObjectAlarm(stub);
      const d = await stub.getWorkspace({});
      if (d.ok && d.value.state === "ready") break;
    }
    await waitFor(async () => tempod.requestsOf("session.prompt").length === 1, 5000, "first prompt");
    expect(container.starts).toHaveLength(1);
    expect(container.intercepts).toEqual(["http:backups.sandbox.internal", "all", "https:*"]);
    expect(tempod.requestsOf("repo.clone")[0].branch).toBe("tempo/add-a-readme");
    expect(tempod.requestsOf("repo.clone")[0].url).toBe("https://github.com/acme/app.git");
    const prompt = tempod.requestsOf("session.prompt")[0];
    expect(prompt.content.at(-1)).toEqual({ type: "text", text: "Add a README" });
    const d = await stub.getWorkspace({});
    expect(d.ok && d.value.state).toBe("working");
    const row = await env.DB.prepare("SELECT state, summary_rev FROM workspaces WHERE id = ?")
      .bind(d.ok ? d.value.id : "")
      .first();
    expect(row?.state).toBe("working");
    await runInDurableObject(stub, (instance) => {
      expect(internals(instance as never).core.liveSessions.size).toBe(1);
    });
  });
});

describe("first-prompt branch naming", () => {
  it("renames a ready workspace before sending its first prompt and keeps later prompts from renaming it", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub, tempod } = await seedWorkspace(seeded);
    await driveToState(stub, ["ready"]);
    const session = unwrap((await stub.createSession({ agent: "claude" })) as unknown as Result<Session>);
    const input = {
      sessionId: session.id,
      text: "Fix café login / redirect!",
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    };
    expect((await stub.sendPrompt(input)).ok).toBe(true);
    await waitFor(async () => tempod.requestsOf("session.prompt").length === 1);
    expect(tempod.requestsOf("git.renameBranch")[0].to).toBe("tempo/fix-cafe-login-redirect");
    expect(await stub.getWorkspace({})).toMatchObject({
      ok: true,
      value: { branch: "tempo/fix-cafe-login-redirect" },
    });
    expect((await stub.sendPrompt({ ...input, text: "Add tests" })).ok).toBe(true);
    expect(tempod.requestsOf("git.renameBranch")).toHaveLength(1);
  });

  it("preserves a manual override saved before the first prompt", async () => {
    const seeded = await seedProject();
    await seedCredentials(seeded.userId);
    const { stub, tempod } = await seedWorkspace(seeded);
    await driveToState(stub, ["ready"]);
    expect((await stub.renameBranch({ branch: "feature/my-name" })).ok).toBe(true);
    const session = unwrap((await stub.createSession({ agent: "claude" })) as unknown as Result<Session>);
    expect(
      (
        await stub.sendPrompt({
          sessionId: session.id,
          text: "Fix login",
          mentions: [],
          attachmentIds: [],
          reviewCommentIds: [],
        })
      ).ok,
    ).toBe(true);
    await waitFor(async () => tempod.requestsOf("session.prompt").length === 1);
    expect(tempod.requestsOf("git.renameBranch")).toHaveLength(1);
    expect(await stub.getWorkspace({})).toMatchObject({ ok: true, value: { branch: "feature/my-name" } });
  });

  it("adds a suffix when another active workspace uses the prompt name", async () => {
    const seeded = await seedProject();
    const first = await seedWorkspace(seeded, { prompt: "Fix login" });
    const detail = await first.stub.getWorkspace({});
    if (!detail.ok) throw new Error("workspace failed");
    await waitFor(
      async () =>
        (await env.DB.prepare("SELECT branch FROM workspaces WHERE id = ?").bind(detail.value.id).first())
          ?.branch === "tempo/fix-login",
    );
    const second = await seedWorkspace(seeded, { slug: "fox", prompt: "Fix login" });
    expect(await second.stub.getWorkspace({})).toMatchObject({
      ok: true,
      value: { branch: "tempo/fix-login-2" },
    });
  });
});

describe("prompt naming during setup", () => {
  it("leaves existing source branches unchanged", async () => {
    const seeded = await seedProject();
    const { stub } = await seedWorkspace(seeded, { source: { kind: "branch" }, prompt: "Fix login" });
    const detail = await stub.getWorkspace({});
    expect(detail.ok && detail.value.branch).not.toBe("tempo/fix-login");
  });
});
