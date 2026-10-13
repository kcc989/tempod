import type { WorkspaceDO } from "../../src/do/workspace/index.ts";
import type { WorkspaceStub } from "../../src/do/workspace/stub.ts";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  CustomAgent,
  CustomAgentSummary,
  Session,
  TempoError,
  newId,
  type CustomAgentDefinition,
  type FnName,
} from "@tempo/protocol";
import { agentStore, type AgentRepoStore } from "../../src/agents/store.ts";
import { memoryFs } from "../../src/agents/memfs.ts";
import { sessions as sessionsTable, turns as turnsTable } from "../../src/db/workspace-do.ts";
import { runFn } from "../../src/server/run.ts";
import {
  internals,
  driveToState,
  seedCredentials,
  seedProject,
  seedWorkspace,
  waitFor,
  type Seeded,
} from "./fakes.ts";

/** Custom agents (01, Custom agents; 02, custom_agents and Server functions). */

const BEARER = { allowCookie: false, allowBearer: true } as const;

type Res<T = import("@tempo/protocol").JsonData> = import("@tempo/protocol").Result<T>;

const def: CustomAgentDefinition = {
  name: "Reviewer",
  description: "Reviews code",
  baseAgent: "claude",
  model: "opus",
  thoughtLevel: "high",
  systemPrompt: "You review code.",
  tools: { allow: [], deny: ["Edit", "Write"] },
  mcp: {
    playwright: false,
    servers: [{ name: "docs", type: "stdio", command: "docs-mcp", args: [], env: { T: "${DOCS_TOKEN}" } }],
  },
};

/** An in-memory Artifacts: one commit per write, files readable at any commit. */
class FakeStore implements AgentRepoStore {
  readonly commits = new Map<string, Map<string, string>>();
  readonly heads = new Map<string, string>();
  readonly writes: Array<{ repo: string; path: string; content: string | null; message: string }> = [];
  failNext: string | null = null;

  async read(repo: string, ref: string, path: string): Promise<string | null> {
    const files = this.commits.get(`${repo}@${ref}`);

    if (!files) throw new TempoError("ARTIFACTS_ERROR", undefined, "read: NOT_FOUND");

    return files.get(path) ?? null;
  }

  async write(repo: string, path: string, content: string | null, message: string): Promise<string> {
    if (this.failNext) {
      const step = this.failNext;
      this.failNext = null;
      throw new TempoError("ARTIFACTS_ERROR", undefined, step);
    }

    this.writes.push({ repo, path, content, message });
    const head = this.heads.get(repo);
    const files = new Map(head ? this.commits.get(`${repo}@${head}`) : []);

    if (content === null) files.delete(path);
    else files.set(path, content);
    const sha = newId().padEnd(40, "0").slice(0, 40);
    this.commits.set(`${repo}@${sha}`, files);
    this.heads.set(repo, sha);

    return sha;
  }
}

const inDo = runInDurableObject;

let store: FakeStore;

beforeEach(() => {
  store = new FakeStore();
  vi.spyOn(agentStore, "forEnv").mockReturnValue(store);
});

afterEach(() => vi.restoreAllMocks());

const signIn = async (userId: string): Promise<string> => {
  const token = `tok${newId()}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), now + 86_400_000, token, now, now, userId)
    .run();

  return token;
};

type Owner = Seeded & { token: string };

const owner = async (): Promise<Owner> => {
  const s = await seedProject();

  return { ...s, token: await signIn(s.userId) };
};

const call = <K extends FnName>(
  name: K,
  o: Owner,
  input: import("@tempo/protocol").JsonData | import("@tempo/protocol").FnInput<FnName> = {},
) => runFn(name, env, new Headers({ Authorization: `Bearer ${o.token}` }), input, BEARER);

const ok = <T>(result: Res<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code} ${result.error.detail ?? ""}`);

  return result.value;
};

const codeOf = <T>(result: Res<T>): string => (result.ok ? "OK" : result.error.code);

const conforms = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.is(schema);

describe("saveCustomAgent, getCustomAgent, listCustomAgents, deleteCustomAgent", () => {
  it("saves a file in the user's repo, points D1 at the commit, and reads it back", async () => {
    const o = await owner();
    const saved = ok(await call("saveCustomAgent", o, { definition: def }));
    expect(conforms(CustomAgent)(saved)).toBe(true);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({ repo: `user-${o.userId}`, path: `agents/${saved.id}.yaml` });
    expect(store.writes[0]!.content).toContain("base_agent: claude\n");
    const row = await env.DB.prepare("SELECT * FROM custom_agents WHERE id = ?").bind(saved.id).first<any>();
    expect(row).toMatchObject({
      name: "Reviewer",
      base_agent: "claude",
      commit_sha: saved.commitSha,
      deleted_at: null,
    });

    expect(ok(await call("getCustomAgent", o, { customAgentId: saved.id }))).toEqual(saved);
    const list = ok(await call("listCustomAgents", o));
    expect(list).toEqual([
      {
        id: saved.id,
        name: "Reviewer",
        description: "Reviews code",
        baseAgent: "claude",
        updatedAt: saved.updatedAt,
      },
    ]);
    expect(list.every((s) => conforms(CustomAgentSummary)(s))).toBe(true);
  });

  it("updates in place with a new commit; reads use the pinned commit, not main", async () => {
    const o = await owner();
    const first = ok(await call("saveCustomAgent", o, { definition: def }));

    const second = ok(
      await call("saveCustomAgent", o, { customAgentId: first.id, definition: { ...def, model: "sonnet" } }),
    );

    expect(second.id).toBe(first.id);
    expect(second.commitSha).not.toBe(first.commitSha);
    expect(ok(await call("getCustomAgent", o, { customAgentId: first.id })).model).toBe("sonnet");
    const old = await store.read(`user-${o.userId}`, first.commitSha, `agents/${first.id}.yaml`);
    expect(old).toContain("model: opus\n");
  });

  it("refuses a duplicate name, an unknown id and a literal secret", async () => {
    const o = await owner();
    ok(await call("saveCustomAgent", o, { definition: def }));
    expect(codeOf(await call("saveCustomAgent", o, { definition: def }))).toBe("CUSTOM_AGENT_EXISTS");
    expect(codeOf(await call("saveCustomAgent", o, { customAgentId: newId(), definition: def }))).toBe(
      "NOT_FOUND",
    );

    const literal = {
      ...def,
      name: "Leaky",
      mcp: { playwright: true, servers: [{ ...def.mcp.servers[0], env: { T: "sk-live-123" } }] },
    };

    expect(codeOf(await call("saveCustomAgent", o, { definition: literal }))).toBe("VALIDATION_FAILED");
    expect(store.writes).toHaveLength(1);
  });

  it("stops at 50 agents per user with CUSTOM_AGENT_LIMIT", async () => {
    const o = await owner();
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 50 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO custom_agents (id, user_id, name, base_agent, repo, path, commit_sha, created_at, updated_at) VALUES (?, ?, ?, 'pi', 'r', 'p', 'c', ?, ?)",
        ).bind(newId(), o.userId, `a${i}`, now, now),
      ),
    );
    expect(codeOf(await call("saveCustomAgent", o, { definition: def }))).toBe("CUSTOM_AGENT_LIMIT");
  });

  it("leaves D1 unchanged when the Artifacts push fails", async () => {
    const o = await owner();
    store.failNext = "push: PushRejectedError";
    expect(codeOf(await call("saveCustomAgent", o, { definition: def }))).toBe("ARTIFACTS_ERROR");
    expect(ok(await call("listCustomAgents", o))).toEqual([]);
  });

  it("delete commits the removal, hides the agent and frees the name", async () => {
    const o = await owner();
    const saved = ok(await call("saveCustomAgent", o, { definition: def }));
    ok(await call("deleteCustomAgent", o, { customAgentId: saved.id }));
    expect(store.writes.at(-1)).toMatchObject({ content: null, path: `agents/${saved.id}.yaml` });
    expect(ok(await call("listCustomAgents", o))).toEqual([]);
    expect(codeOf(await call("getCustomAgent", o, { customAgentId: saved.id }))).toBe("NOT_FOUND");
    expect(codeOf(await call("deleteCustomAgent", o, { customAgentId: saved.id }))).toBe("NOT_FOUND");
    ok(await call("saveCustomAgent", o, { definition: def }));
  });

  it("does not show one user's agents to another", async () => {
    const a = await owner();
    const b = await owner();
    const saved = ok(await call("saveCustomAgent", a, { definition: def }));
    expect(codeOf(await call("getCustomAgent", b, { customAgentId: saved.id }))).toBe("NOT_FOUND");
    expect(ok(await call("listCustomAgents", b))).toEqual([]);
  });
});

describe("sessions from a custom agent", () => {
  const ready = async () => {
    const o = await owner();
    await seedCredentials(o.userId);
    const w = await seedWorkspace(o);
    await env.DB.prepare("UPDATE workspaces SET user_id = ? WHERE id = ?")
      .bind(o.userId, w.workspaceId)
      .run();
    await driveToState(w.stub, ["ready"]);

    return { o, w };
  };

  it("createSession stores the profile and sends it with session.start; model defaults to the agent's", async () => {
    const { o, w } = await ready();
    w.tempod.on("session.start", () => ({
      acpSessionId: "acp-1",
      modes: [],
      modeId: null,
      configOptions: [],
      availableCommands: [],
      capabilities: {},
      profileIssues: ["thoughtLevel"],
      reloaded: false,
      handoff: false,
    }));
    const saved = ok(await call("saveCustomAgent", o, { definition: def }));

    const session = ok(
      await call("createSession", o, {
        workspaceId: w.workspaceId,
        agent: "claude",
        customAgentId: saved.id,
      }),
    );

    expect(conforms(Session)(session)).toBe(true);
    expect(session.customAgent).toEqual({ id: saved.id, name: "Reviewer", commitSha: saved.commitSha });
    expect(session.config).toEqual({ model: "opus" });
    await waitFor(() => w.tempod.requestsOf("session.start").length === 1, 5000, "session.start");
    const start = w.tempod.requestsOf("session.start")[0];
    expect(start).toMatchObject({
      sessionId: session.id,
      agent: "claude",
      model: "opus",
      profile: {
        systemPrompt: "You review code.",
        toolsAllow: [],
        toolsDeny: ["Edit", "Write"],
        playwright: false,
        thoughtLevel: "high",
      },
    });
    expect(start.profile.mcpServers[0].env).toEqual({ T: "${DOCS_TOKEN}" });
    await waitFor(
      async () => (await getSession(w, session.id))?.profileIssues?.[0] === "thoughtLevel",
      5000,
      "profile issues stored",
    );
  });

  it("an explicit model wins, and a plain session carries no custom agent", async () => {
    const { o, w } = await ready();
    const saved = ok(await call("saveCustomAgent", o, { definition: def }));

    const s = ok(
      await call("createSession", o, {
        workspaceId: w.workspaceId,
        agent: "claude",
        customAgentId: saved.id,
        model: "haiku",
      }),
    );

    expect(s.config).toEqual({ model: "haiku" });
    const plain = ok(await call("createSession", o, { workspaceId: w.workspaceId, agent: "codex" }));
    expect(plain.customAgent).toBeUndefined();
    expect(plain.profileIssues).toBeUndefined();
  });

  it("refuses a base agent mismatch and a deleted agent", async () => {
    const { o, w } = await ready();
    const saved = ok(await call("saveCustomAgent", o, { definition: def }));
    expect(
      codeOf(
        await call("createSession", o, {
          workspaceId: w.workspaceId,
          agent: "codex",
          customAgentId: saved.id,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    ok(await call("deleteCustomAgent", o, { customAgentId: saved.id }));
    expect(
      codeOf(
        await call("createSession", o, {
          workspaceId: w.workspaceId,
          agent: "claude",
          customAgentId: saved.id,
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("an open session keeps its profile after the agent changes", async () => {
    const { o, w } = await ready();
    const saved = ok(await call("saveCustomAgent", o, { definition: def }));

    const s = ok(
      await call("createSession", o, {
        workspaceId: w.workspaceId,
        agent: "claude",
        customAgentId: saved.id,
      }),
    );

    ok(
      await call("saveCustomAgent", o, {
        customAgentId: saved.id,
        definition: { ...def, systemPrompt: "New." },
      }),
    );
    expect((await getSession(w, s.id))?.customAgent?.commitSha).toBe(saved.commitSha);
  });
});

describe("createWorkspace with a custom agent", () => {
  it("refuses an agent that is not the custom agent's base agent before any GitHub call", async () => {
    const o = await owner();
    const saved = ok(await call("saveCustomAgent", o, { definition: { ...def, baseAgent: "pi" } }));
    const fetch = vi.spyOn(globalThis, "fetch");

    const res = await call("createWorkspace", o, {
      projectId: o.projectId,
      source: { kind: "new", baseBranch: "main" },
      agent: "claude",
      customAgentId: saved.id,
    });

    expect(codeOf(res)).toBe("VALIDATION_FAILED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("init makes the first session from the custom agent, even without a prompt", async () => {
    const o = await owner();

    const custom = {
      customAgent: { id: newId(), name: "Reviewer", commitSha: "c".repeat(40) },
      profile: {
        systemPrompt: "Review.",
        toolsAllow: [],
        toolsDeny: [],
        playwright: true,
        mcpServers: [],
        thoughtLevel: "",
      },
      model: "opus",
    };

    const w = await seedWorkspace(o, { custom });

    const sessions = await inDo(w.stub, (instance: WorkspaceDO) =>
      internals(instance).core.db.select().from(sessionsTable).all(),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      customAgentId: custom.customAgent.id,
      customAgentName: "Reviewer",
      configJson: JSON.stringify({ model: "opus" }),
    });
    expect(JSON.parse(sessions[0]!.profileJson!)).toEqual(custom.profile);

    const turns = await inDo(w.stub, (instance: WorkspaceDO) =>
      internals(instance).core.db.select().from(turnsTable).all(),
    );

    expect(turns).toHaveLength(0);
  });
});

const getSession = (w: { stub: WorkspaceStub }, id: string): Promise<any> =>
  inDo(w.stub, (instance: WorkspaceDO) =>
    internals(instance).core.sessionToWire(internals(instance).core.sessionRow(id)),
  );

describe("memoryFs (isomorphic-git's file system)", () => {
  it("supports the calls a commit needs and fails like node fs", async () => {
    const { promises: fs } = memoryFs();
    await fs.mkdir("/r");
    await fs.mkdir("/r/agents");
    await fs.writeFile("/r/agents/a.yaml", "x: 1");
    expect(await fs.readFile("/r/agents/a.yaml", "utf8")).toBe("x: 1");
    expect(await fs.readdir("/r")).toEqual(["agents"]);
    expect((await fs.stat("/r/agents")).isDirectory()).toBe(true);
    await expect(fs.mkdir("/r")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.readFile("/nope")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.writeFile("/x/y", "z")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.rmdir("/r/agents")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    await fs.unlink("/r/agents/a.yaml");
    await fs.rmdir("/r/agents");
    expect(await fs.readdir("/r")).toEqual([]);
  });
});
