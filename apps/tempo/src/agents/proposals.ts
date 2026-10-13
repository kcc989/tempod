import { Schema } from "effect";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  AGENT_LIMIT,
  AgentProposal,
  AgentProposalRecord,
  AgentLibraryToolResult,
  TempoError,
  newId,
  type ToolReq,
} from "@tempo/protocol";
import { agents, agentProposalApplications } from "../db/d1.ts";
import { agentProposals } from "../db/workspace-do.ts";
import { d1 } from "../server/handlers/common.ts";
import { agentsChanged, definitionSha, definitionText, migrateAgents, summary } from "./library.ts";
import { lifecycleRedactor } from "../agents/secrets.ts";
import type { WorkspaceCore } from "../do/workspace/core.ts";

const strict = Schema.decodeUnknownSync(AgentProposal, { onExcessProperty: "error" });

const decodeProposal = (input: Schema.Json): AgentProposal => {
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).length > 65536) throw new Error("size");

    return strict(input);
  } catch {
    throw new TempoError("AGENT_INVALID");
  }
};

const maskValue = (value: Schema.Json, mask: (text: string) => string): Schema.Json => {
  if (Schema.is(Schema.String)(value)) return mask(value);

  if (Array.isArray(value)) return value.map((v) => maskValue(v, mask));

  if (Schema.is(Schema.JsonObject)(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, mask)]));

  return value;
};

export const proposalRecords = (core: WorkspaceCore): AgentProposalRecord[] =>
  core.db
    .select()
    .from(agentProposals)
    .orderBy(asc(agentProposals.createdAt), asc(agentProposals.id))
    .all()
    .map(({ proposalJson, ...row }) => ({ ...row, proposal: strict(JSON.parse(proposalJson)) }));

export const agentTool = async (core: WorkspaceCore, request: ToolReq): Promise<Schema.Json> => {
  const session = core.sessionRow(request.sessionId);

  if (session.runId || request.runId || session.status === "closed") throw new TempoError("RUN_NOT_RUNNING");

  if (request.op === "list_agents") {
    Schema.decodeUnknownSync(Schema.Struct({}), { onExcessProperty: "error" })(request.params);
    await migrateAgents(core.env, core.ws().userId);
    await core.lifecycle.load();

    return Schema.decodeUnknownSync(Schema.Json)(
      Schema.decodeUnknownSync(AgentLibraryToolResult)({
        agents: core.lifecycle.agents.map(summary),
        attachments: core.lifecycle.attachments,
      }),
    );
  }

  if (request.op !== "propose_agent_change") throw new TempoError("UNKNOWN_OP");
  const proposal = decodeProposal(request.params);
  const mask = await lifecycleRedactor(core);
  const redacted = decodeProposal(maskValue(Schema.decodeUnknownSync(Schema.Json)(proposal), mask));
  const id = newId();
  core.ctx.storage.transactionSync(() => {
    core.db
      .insert(agentProposals)
      .values({
        id,
        sessionId: session.id,
        createdAt: Date.now(),
        status: "pending",
        proposalJson: JSON.stringify(redacted),
      })
      .run();
    core.insertItem({
      sessionId: session.id,
      turnId: core.runningTurn()?.id ?? null,
      kind: "agent_proposal",
      status: "completed",
      content: { proposalId: id },
    });
  });
  core.broadcastDetailSoon();

  return { proposalId: id };
};

const apply = async (core: WorkspaceCore, id: string, proposal: AgentProposal): Promise<void> => {
  const ws = core.ws();
  const db = d1(core.env);

  const applied = await db
    .select()
    .from(agentProposalApplications)
    .where(eq(agentProposalApplications.id, id))
    .get();

  if (applied) {
    if (applied.userId !== ws.userId || applied.workspaceId !== core.workspaceId)
      throw new TempoError("NOT_FOUND");

    return;
  }

  await migrateAgents(core.env, ws.userId);

  const active = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, ws.userId), isNull(agents.deletedAt)))
    .all();

  const existing = proposal.agent ? active.find((a) => a.handle === proposal.agent!.handle) : undefined;
  const agentId = existing?.id ?? id;
  const attachAgent = proposal.attach ? active.find((a) => a.handle === proposal.attach!.handle) : undefined;
  const attachingNew = proposal.attach && proposal.agent?.handle === proposal.attach.handle;

  if (proposal.attach && !attachAgent && !attachingNew) throw new TempoError("ATTACHMENT_INVALID");
  const detachAgent = proposal.detach ? active.find((a) => a.handle === proposal.detach) : undefined;

  if (proposal.detach && !detachAgent) throw new TempoError("ATTACHMENT_INVALID");
  const now = Date.now();
  const guards: string[] = ["EXISTS (SELECT 1 FROM workspaces WHERE id=? AND user_id=? AND project_id=?)"];
  const params: Array<string | number> = [core.workspaceId, ws.userId, ws.projectId];

  for (const row of [existing, attachAgent, detachAgent]) {
    if (!row) continue;
    guards.push(
      "EXISTS (SELECT 1 FROM agents WHERE id=? AND user_id=? AND deleted_at IS NULL AND version=?)",
    );
    params.push(row.id, ws.userId, row.version);
  }

  if (proposal.agent && !existing) {
    guards.push("(SELECT count(*) FROM agents WHERE user_id=? AND deleted_at IS NULL) < ?");
    params.push(ws.userId, AGENT_LIMIT);
  }

  const writes = [
    core.env.DB.prepare(
      `INSERT INTO agent_proposal_applications(id,user_id,workspace_id,created_at,guard) VALUES (?,?,?,?,CASE WHEN ${guards.join(" AND ")} THEN 1 ELSE 0 END)`,
    ).bind(id, ws.userId, core.workspaceId, now, ...params),
  ];

  if (proposal.agent) {
    const text = definitionText(proposal.agent);
    const sha = await definitionSha(text);
    writes.push(
      existing
        ? core.env.DB.prepare(
            "UPDATE agents SET name=?,definition_json=?,sha=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL",
          ).bind(proposal.agent.name, text, sha, now, existing.id, ws.userId)
        : core.env.DB.prepare(
            "INSERT INTO agents(id,user_id,handle,name,definition_json,version,sha,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)",
          ).bind(agentId, ws.userId, proposal.agent.handle, proposal.agent.name, text, sha, now, now),
    );
  }

  if (proposal.attach) {
    const a = proposal.attach;
    writes.push(
      core.env.DB.prepare(
        "INSERT INTO project_agents(id,project_id,agent_id,enabled,hooks_json,auto_send,max_runs,timeout,created_at,updated_at) VALUES (?,?,?,1,?,?,?,?,?,?) ON CONFLICT(project_id,agent_id) DO UPDATE SET enabled=1,hooks_json=excluded.hooks_json,auto_send=excluded.auto_send,max_runs=excluded.max_runs,timeout=excluded.timeout,updated_at=excluded.updated_at",
      ).bind(
        newId(),
        ws.projectId,
        attachingNew ? agentId : attachAgent!.id,
        JSON.stringify(a.hooks),
        Number(a.autoSend),
        a.maxRuns,
        a.timeout,
        now,
        now,
      ),
    );
  }

  if (detachAgent)
    writes.push(
      core.env.DB.prepare("DELETE FROM project_agents WHERE project_id=? AND agent_id=?").bind(
        ws.projectId,
        detachAgent.id,
      ),
    );

  try {
    await core.env.DB.batch(writes);
  } catch {
    const replay = await db
      .select()
      .from(agentProposalApplications)
      .where(eq(agentProposalApplications.id, id))
      .get();

    if (replay?.userId === ws.userId && replay.workspaceId === core.workspaceId) return;
    throw new TempoError(proposal.agent ? "AGENT_INVALID" : "ATTACHMENT_INVALID");
  }
};

export const proposalNotifications = { changed: agentsChanged };

const resolutions = new WeakMap<WorkspaceCore, Map<string, Promise<void>>>();

export const resolveAgentProposal = async (
  core: WorkspaceCore,
  id: string,
  accept: boolean,
): Promise<void> => {
  const locks = resolutions.get(core) ?? new Map<string, Promise<void>>();
  resolutions.set(core, locks);
  const pending = locks.get(id);

  if (pending) await pending;

  const work = (async () => {
    const row = core.db.select().from(agentProposals).where(eq(agentProposals.id, id)).get();

    if (!row) throw new TempoError("NOT_FOUND");
    const status = accept ? "applied" : "rejected";

    if (row.status === status) {
      if (accept) await proposalNotifications.changed(core.env, core.ws().userId);

      return;
    }

    if (row.status !== "pending") throw new TempoError("NOT_FOUND");

    if (accept) await apply(core, id, strict(JSON.parse(row.proposalJson)));
    core.db.update(agentProposals).set({ status }).where(eq(agentProposals.id, id)).run();
    core.broadcastDetailSoon();

    if (accept) await proposalNotifications.changed(core.env, core.ws().userId);
  })();

  locks.set(id, work);

  try {
    await work;
  } finally {
    if (locks.get(id) === work) locks.delete(id);
  }
};
