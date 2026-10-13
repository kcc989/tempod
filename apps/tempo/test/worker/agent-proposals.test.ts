import { Schema } from "effect";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentLibraryToolResult, newId, unwrap, type ToolReq, type ToolRes } from "@tempo/protocol";
import { seedReadyWorkspace } from "./ready-fixture.ts";
import { internals, seedProject, sqlRows } from "./fakes.ts";
import { runFn } from "../../src/server/run.ts";
import type { WorkspaceDO } from "../../src/do/workspace/index.ts";

const setup = async () => {
  const w = await seedReadyWorkspace({ credentials: ["claude"] });
  const session = unwrap(await w.stub.createSession({ agent: "claude" }));

  return { ...w, sid: session.id };
};

type Fixture = Awaited<ReturnType<typeof setup>>;

const tool = (w: Fixture, op: ToolReq["op"], params: Schema.Json, runId?: string) =>
  runInDurableObject(w.stub, () => w.tempod.tool({ op, sessionId: w.sid, params, runId }));

const toolValue = (reply: ToolRes): Schema.Json => {
  if (!reply.ok) throw new Error(reply.error.code);

  return reply.result;
};

const propose = async (w: Fixture, params: Schema.Json) =>
  Schema.decodeUnknownSync(Schema.Struct({ proposalId: Schema.String }))(
    toolValue(await tool(w, "propose_agent_change", params)),
  ).proposalId;

const definition = {
  handle: "migration-checker",
  name: "Migration checker",
  baseAgent: "claude",
  access: "read-only",
  outputKind: "review",
  prompt: "Check migrations",
};

const attach = {
  handle: "migration-checker",
  hooks: [{ event: "branch.pushed", when: "Does this change a migration?", threshold: 0.7 }],
};

const rows = (w: Fixture) =>
  env.DB.prepare("SELECT * FROM agents WHERE user_id=? AND handle='migration-checker'")
    .bind(w.seeded.userId)
    .all();

describe("agent proposals", () => {
  it("lists only the owner's library, stores a redacted card without writes, and applies atomically once across receipt recovery", async () => {
    const w = await setup();
    const other = await setup();
    await runInDurableObject(w.stub, (i: WorkspaceDO) =>
      internals(i).core.credentials().putSecret("project.test.env.PRIVATE", "private-test-value"),
    );

    const library = Schema.decodeUnknownSync(AgentLibraryToolResult)(
      toolValue(await tool(w, "list_agents", {})),
    );

    expect(library.agents.map((a) => a.handle).sort()).toEqual(["check-fixer", "planner", "reviewer"]);
    expect(library.attachments).toEqual([]);

    const id = await propose(w, {
      note: "Needed private-test-value",
      agent: { ...definition, prompt: "Check private-test-value" },
      attach,
    });

    expect((await rows(w)).results).toEqual([]);
    expect(await sqlRows(w.stub, "SELECT kind FROM items WHERE kind='agent_proposal'")).toEqual([
      { kind: "agent_proposal" },
    ]);
    const stored = unwrap(await w.stub.getWorkspace({})).agentProposals!;
    expect(stored[0]?.proposal).toMatchObject({
      note: "Needed [redacted]",
      agent: { prompt: "Check [redacted]" },
    });
    expect(stored[0]?.status).toBe("pending");
    expect(
      await sqlRows(w.stub, "SELECT * FROM events WHERE kind IN ('propose_agent_change','list_agents')"),
    ).toEqual([]);
    unwrap(await w.stub.resolveAgentProposal({ proposalId: id, apply: true }));
    const applied = await rows(w);
    expect(applied.results[0]?.version).toBe(1);
    expect(applied.results[0]?.user_id).toBe(w.seeded.userId);

    const library2 = Schema.decodeUnknownSync(AgentLibraryToolResult)(
      toolValue(await tool(w, "list_agents", {})),
    );

    expect(library2.attachments[0]?.hooks[0]).toMatchObject({
      event: "branch.pushed",
      when: attach.hooks[0]!.when,
      threshold: 0.7,
    });
    expect(
      Schema.decodeUnknownSync(AgentLibraryToolResult)(
        toolValue(await tool(other, "list_agents", {})),
      ).agents.some((a) => a.handle === definition.handle),
    ).toBe(false);
    unwrap(await w.stub.resolveAgentProposal({ proposalId: id, apply: true }));
    await runInDurableObject(w.stub, (i: WorkspaceDO) =>
      internals(i).core.ctx.storage.sql.exec("UPDATE agent_proposals SET status='pending' WHERE id=?", id),
    );
    unwrap(await w.stub.resolveAgentProposal({ proposalId: id, apply: true }));
    expect((await rows(w)).results[0]?.version).toBe(1);

    const update = await propose(w, {
      note: "More checks",
      agent: { ...definition, prompt: "Check forward and rollback" },
    });

    unwrap(await w.stub.resolveAgentProposal({ proposalId: update, apply: true }));
    expect((await rows(w)).results[0]?.version).toBe(2);
    expect(unwrap(await w.stub.getWorkspace({})).agentProposals?.every((p) => p.status === "applied")).toBe(
      true,
    );
  });
  it("rejects without writes, validates excess keys and byte limits, and prevents run sessions from using chat tools", async () => {
    const w = await setup();
    const id = await propose(w, { note: "Optional", agent: definition, attach });
    unwrap(await w.stub.resolveAgentProposal({ proposalId: id, apply: false }));
    expect((await rows(w)).results).toEqual([]);
    expect(unwrap(await w.stub.getWorkspace({})).agentProposals?.[0]?.status).toBe("rejected");
    expect(await w.stub.resolveAgentProposal({ proposalId: id, apply: true })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    for (const invalid of [
      { note: "x", extra: true },
      { note: "x".repeat(65537) },
      {
        note: "x",
        agent: {
          ...definition,
          mcp: {
            playwright: true,
            servers: [
              { name: "bad", type: "stdio", command: "node", args: [], env: { TOKEN: "literal-secret" } },
            ],
          },
        },
      },
    ])
      expect(
        await tool(w, "propose_agent_change", Schema.decodeUnknownSync(Schema.Json)(invalid)),
      ).toMatchObject({
        ok: false,
        error: { code: "AGENT_INVALID" },
      });
    expect(await tool(w, "list_agents", {}, newId())).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_RUNNING" },
    });
    await runInDurableObject(w.stub, (i: WorkspaceDO) =>
      internals(i).core.ctx.storage.sql.exec("UPDATE sessions SET run_id=? WHERE id=?", newId(), w.sid),
    );
    expect(await tool(w, "propose_agent_change", { note: "x" })).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_RUNNING" },
    });
    expect(await tool(w, "list_agents", {})).toMatchObject({ ok: false, error: { code: "RUN_NOT_RUNNING" } });
  });
  it("rolls back the definition, attachment and receipt on conflicting names and rejects missing attachment targets", async () => {
    const w = await setup();
    toolValue(await tool(w, "list_agents", {}));

    const id = await propose(w, {
      note: "Conflicting name",
      agent: { ...definition, name: "Planner" },
      attach,
    });

    expect(await w.stub.resolveAgentProposal({ proposalId: id, apply: true })).toMatchObject({
      ok: false,
      error: { code: "AGENT_INVALID" },
    });
    expect((await rows(w)).results).toEqual([]);
    expect(
      (await env.DB.prepare("SELECT * FROM agent_proposal_applications WHERE id=?").bind(id).all()).results,
    ).toEqual([]);
    expect(
      Schema.decodeUnknownSync(AgentLibraryToolResult)(toolValue(await tool(w, "list_agents", {})))
        .attachments,
    ).toEqual([]);
    expect(unwrap(await w.stub.getWorkspace({})).agentProposals?.[0]?.status).toBe("pending");

    const invalid = await propose(w, {
      note: "Unknown",
      agent: definition,
      attach: { ...attach, handle: "unknown-agent" },
    });

    expect(await w.stub.resolveAgentProposal({ proposalId: invalid, apply: true })).toMatchObject({
      ok: false,
      error: { code: "ATTACHMENT_INVALID" },
    });
    expect((await rows(w)).results).toEqual([]);

    const seed = (await env.DB.prepare("SELECT id FROM agents WHERE user_id=? LIMIT 1")
      .bind(w.seeded.userId)
      .first<{ id: string }>())!;

    await env.DB.batch(
      Array.from({ length: 47 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO agents(id,user_id,handle,name,definition_json,version,sha,created_at,updated_at) SELECT ?,user_id,?,?,json_set(definition_json,'$.handle',?,'$.name',?),1,sha,0,0 FROM agents WHERE id=?",
        ).bind(newId(), `limit-${i}`, `Limit ${i}`, `limit-${i}`, `Limit ${i}`, seed.id),
      ),
    );
    const capped = await propose(w, { note: "Over limit", agent: definition, attach });
    expect(await w.stub.resolveAgentProposal({ proposalId: capped, apply: true })).toMatchObject({
      ok: false,
      error: { code: "AGENT_INVALID" },
    });
    expect((await rows(w)).results).toEqual([]);
    expect(
      (await env.DB.prepare("SELECT * FROM agent_proposal_applications WHERE id=?").bind(capped).all())
        .results,
    ).toEqual([]);
  });
  it("checks owner access through resolveAgentProposal and detaches only this project's agent", async () => {
    const w = await setup();
    const id = await propose(w, { note: "Create and attach", agent: definition, attach });
    const other = await seedProject();
    const token = newId();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)",
    )
      .bind(newId(), now + 86400000, token, now, now, other.userId)
      .run();
    expect(
      await runFn(
        "resolveAgentProposal",
        env,
        new Headers({ Authorization: `Bearer ${token}` }),
        { workspaceId: w.workspaceId, proposalId: id, apply: true },
        { allowBearer: true, allowCookie: false },
      ),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await rows(w)).results).toEqual([]);
    unwrap(await w.stub.resolveAgentProposal({ proposalId: id, apply: true }));
    const detach = await propose(w, { note: "Disable the flow", detach: definition.handle });
    unwrap(await w.stub.resolveAgentProposal({ proposalId: detach, apply: true }));
    expect(
      Schema.decodeUnknownSync(AgentLibraryToolResult)(toolValue(await tool(w, "list_agents", {})))
        .attachments,
    ).toEqual([]);
    expect((await rows(w)).results).toHaveLength(1);
  });
});
