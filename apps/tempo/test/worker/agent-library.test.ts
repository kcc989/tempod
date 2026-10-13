import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import { env, runInDurableObject } from "cloudflare:test";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDefinition, newId, type JsonData, type FnName, type Result } from "@tempo/protocol";
import { stringifyAgentFile } from "@tempo/settings";
import { agentStore } from "../../src/agents/store.ts";
import { runFn } from "../../src/server/run.ts";
import { seedProject, seedCredentials, seedWorkspace, driveToState, internals, waitFor } from "./fakes.ts";
import { sessions } from "../../src/db/workspace-do.ts";

const def = Schema.decodeUnknownSync(AgentDefinition)({
  handle: "auth-checker",
  name: "Auth checker",
  prompt: "Check authentication",
  outputKind: "review",
});

const auth = { allowBearer: true, allowCookie: false };

const owner = async () => {
  const o = await seedProject();
  const token = newId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)",
  )
    .bind(newId(), now + 86400000, token, now, now, o.userId)
    .run();

  return { ...o, token };
};

type Owner = Awaited<ReturnType<typeof owner>>;

const call = <K extends FnName>(name: K, o: Owner, input: JsonData = {}) =>
  runFn(name, env, new Headers({ Authorization: `Bearer ${o.token}` }), input, auth);

const value = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.code);

  return r.value;
};

const code = <T>(r: Result<T>) => (r.ok ? "OK" : r.error.code);

afterEach(() => vi.restoreAllMocks());

describe("agent library", () => {
  it("copies starters once without project attachments", async () => {
    const o = await owner();
    const list = value(await call("listAgents", o));
    expect(list.map((a) => a.handle).sort()).toEqual(["check-fixer", "planner", "reviewer"]);
    expect(value(await call("listAgents", o))).toEqual(list);
    expect(value(await call("listProjectAgents", o, { projectId: o.projectId }))).toEqual([]);
  });
  it("versions saves, upserts attachments and keeps deleted attachment rows", async () => {
    const o = await owner();
    const saved = value(await call("saveAgent", o, { definition: def }));
    expect(saved.version).toBe(1);
    expect(saved.sha).toMatch(/^[a-f0-9]{64}$/);

    const updated = value(
      await call("saveAgent", o, { agentId: saved.id, definition: { ...def, prompt: "Check login" } }),
    );

    expect(updated.version).toBe(2);
    expect(updated.sha).not.toBe(saved.sha);
    expect(value(await call("getAgent", o, { agentId: saved.id }))).toEqual(updated);

    const input = {
      projectId: o.projectId,
      agentId: saved.id,
      enabled: true,
      hooks: [{ event: "branch.pushed", when: null, threshold: 0.5 }],
      autoSend: false,
      maxRuns: 3,
      timeout: "20m",
    };

    const attached = value(await call("putProjectAgent", o, input));
    const changed = value(await call("putProjectAgent", o, { ...input, enabled: false, autoSend: true }));
    expect(changed.id).toBe(attached.id);
    expect(changed.enabled).toBe(false);
    expect(changed.autoSend).toBe(true);
    value(await call("deleteAgent", o, { agentId: saved.id }));
    expect(code(await call("getAgent", o, { agentId: saved.id }))).toBe("NOT_FOUND");
    expect(value(await call("listProjectAgents", o, { projectId: o.projectId }))[0]?.agent).toBeNull();
    value(await call("deleteProjectAgent", o, { projectId: o.projectId, agentId: saved.id }));
    expect(value(await call("listProjectAgents", o, { projectId: o.projectId }))).toEqual([]);
  });
  it("checks ownership for agent and attachment APIs", async () => {
    const a = await owner();
    const b = await owner();
    const saved = value(await call("saveAgent", a, { definition: def }));

    for (const [name, input] of [
      ["getAgent", { agentId: saved.id }],
      ["saveAgent", { agentId: saved.id, definition: def }],
      ["deleteAgent", { agentId: saved.id }],
      ["listProjectAgents", { projectId: a.projectId }],
      ["putProjectAgent", { projectId: a.projectId, agentId: saved.id }],
      ["deleteProjectAgent", { projectId: a.projectId, agentId: saved.id }],
    ] as const)
      expect(code(await call(name, b, input))).toBe("NOT_FOUND");
    expect(code(await call("putProjectAgent", b, { projectId: b.projectId, agentId: saved.id }))).toBe(
      "NOT_FOUND",
    );
    expect(value(await call("listAgents", b)).some((x) => x.id === saved.id)).toBe(false);
  });
  it("rejects extra fields, literal MCP secrets, oversized JSON and invalid hook limits", async () => {
    const o = await owner();

    for (const bad of [
      { ...def, extra: true },
      { ...def, tools: { allow: [], deny: [], extra: true } },
      {
        ...def,
        mcp: {
          playwright: true,
          servers: [{ name: "docs", type: "stdio", command: "docs", args: [], env: { KEY: "secret" } }],
        },
      },
      { ...def, prompt: "😀".repeat(20000) },
    ])
      expect(code(await call("saveAgent", o, { definition: bad }))).toBe("AGENT_INVALID");
    const saved = value(await call("saveAgent", o, { definition: def }));

    for (const patch of [
      { hooks: [{ event: "change.ended" }] },
      { hooks: [{ event: "prompt", threshold: 1 }] },
      { timeout: "3h" },
      { maxRuns: 0 },
      { hooks: Array.from({ length: 9 }, () => ({ event: "prompt" })) },
    ])
      expect(
        code(await call("putProjectAgent", o, { projectId: o.projectId, agentId: saved.id, ...patch })),
      ).toBe("ATTACHMENT_INVALID");
  });
  it("releases unique names and handles on deletion", async () => {
    const o = await owner();
    const saved = value(await call("saveAgent", o, { definition: def }));
    expect(code(await call("saveAgent", o, { definition: { ...def, name: "Other" } }))).toBe(
      "AGENT_NAME_TAKEN",
    );
    expect(code(await call("saveAgent", o, { definition: { ...def, handle: "other" } }))).toBe(
      "AGENT_NAME_TAKEN",
    );
    value(await call("deleteAgent", o, { agentId: saved.id }));
    expect(value(await call("saveAgent", o, { definition: def })).id).not.toBe(saved.id);
  });
  it("admits one of two simultaneous creates at the limit", async () => {
    const o = await owner();
    value(await call("listAgents", o));
    await env.DB.batch(
      Array.from({ length: 46 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO agents (id,user_id,handle,name,definition_json,version,sha,created_at,updated_at) VALUES (?,?,?,?,?,1,?,0,0)",
        ).bind(
          newId(),
          o.userId,
          `agent-${i}`,
          `Agent ${i}`,
          JSON.stringify({ ...def, handle: `agent-${i}`, name: `Agent ${i}` }),
          "a".repeat(64),
        ),
      ),
    );

    const results = await Promise.all([
      call("saveAgent", o, { definition: def }),
      call("saveAgent", o, { definition: { ...def, handle: "another", name: "Another" } }),
    ]);

    expect(results.map(code).sort()).toEqual(["AGENT_LIMIT", "OK"]);
  });
  it("starts a library session and keeps its profile through edit and deletion", async () => {
    const o = await owner();
    await seedCredentials(o.userId, ["claude"]);
    const w = await seedWorkspace(o);
    await driveToState(w.stub, ["ready"]);

    const saved = value(await call("saveAgent", o, { definition: { ...def, model: "opus" } }));

    const session = value(
      await call("createSession", o, { workspaceId: w.workspaceId, agent: "claude", agentId: saved.id }),
    );

    expect(session.config).toEqual({ model: "opus" });
    await waitFor(
      () => w.tempod.requestsOf("session.start").some((r) => r.sessionId === session.id),
      5000,
      "library profile start",
    );

    const start = w.tempod.requestsOf("session.start").find((r) => r.sessionId === session.id)!;
    expect(start.profile.systemPrompt).toBe(def.prompt);
    value(await call("saveAgent", o, { agentId: saved.id, definition: { ...def, prompt: "New prompt" } }));
    value(await call("deleteAgent", o, { agentId: saved.id }));

    const rows = await runInDurableObject(w.stub, (instance: WorkspaceDO) =>
      internals(instance).core.db.select().from(sessions).all(),
    );

    const stored = rows.find((r) => r.id === session.id)!;

    expect(JSON.parse(stored.profileJson!).systemPrompt).toBe(def.prompt);
    expect(stored.customAgentCommit).toBe(saved.sha);
  });

  it("reads old definitions at their commit and imports them once", async () => {
    const o = await owner();
    const id = newId();

    const old = {
      name: "123",
      description: "",
      baseAgent: "claude" as const,
      model: "opus",
      thoughtLevel: "high",
      systemPrompt: "Keep this prompt.",
      tools: { allow: [], deny: [] },
      mcp: { playwright: true, servers: [] },
    };

    const read = vi.fn(async () => stringifyAgentFile(old));
    vi.spyOn(agentStore, "forEnv").mockReturnValue({
      read,
      write: async () => {
        throw new Error("Migration must never write files");
      },
    });
    await env.DB.prepare(
      "INSERT INTO custom_agents (id,user_id,name,description,base_agent,repo,path,commit_sha,created_at,updated_at) VALUES (?,?,?,'','claude','old-repo','old-path','old-commit',0,0)",
    )
      .bind(id, o.userId, "123")
      .run();
    await env.DB.prepare("INSERT INTO user_roles (user_id,name,text,updated_at) VALUES (?,?,?,0)")
      .bind(o.userId, "planner", "---\ndescription: Plans\nrequestable: true\n---\nOld prompt.")
      .run();
    await env.DB.prepare("INSERT INTO user_roles (user_id,name,text,updated_at) VALUES (?,?,?,0)")
      .bind(o.userId, "invalid", "invalid")
      .run();
    const list = value(await call("listAgents", o));
    expect(list.map((a) => a.handle).sort()).toEqual(["agent-123", "check-fixer", "planner", "reviewer"]);
    const migrated = value(await call("getAgent", o, { agentId: id }));
    expect(migrated.prompt).toBe(old.systemPrompt);
    expect(migrated.model).toBe("opus");
    value(await call("listAgents", o));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("old-repo", "old-commit", "old-path");
  });
});
