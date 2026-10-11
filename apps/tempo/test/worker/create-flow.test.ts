import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { internals, seedCredentials, seedProject, seedWorkspace, waitFor } from "./fakes.ts";

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
    expect(tempod.requestsOf("repo.clone")[0].url).toBe("https://github.com/acme/app.git");
    const prompt = tempod.requestsOf("session.prompt")[0];
    expect(prompt.content.at(-1)).toEqual({ type: "text", text: "Add a README" });
    const d = await stub.getWorkspace({});
    expect(d.ok && d.value.state).toBe("working");
    const row = await env.DB.prepare("SELECT state, summary_rev FROM workspaces WHERE id = ?").bind(d.ok ? d.value.id : "").first();
    expect(row?.state).toBe("working");
    await runInDurableObject(stub, (instance) => {
      expect(internals(instance as never).core.liveSessions.size).toBe(1);
    });
  });
});
