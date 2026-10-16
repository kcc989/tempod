import { Schema } from "effect";
import { ne } from "drizzle-orm";
import { parseProfile } from "@tempo/settings";
import {
  CapabilityManifest,
  SECRET_PLACEHOLDER_PREFIX,
  TempoError,
  type AgentId,
  type CapabilityCall,
  type CapabilityRead,
  type ManifestException,
} from "@tempo/protocol";
import { sessions, type SessionRow } from "../../db/workspace-do.ts";
import { SECRET_KEYS } from "../credential.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { mcpToEgress } from "../../lib/mcp.ts";
import { errorText, log } from "../../log.ts";
import type { WorkspaceCore } from "./core.ts";
import { dropQueuedTurnsOf, finishTurn } from "./queue.ts";
import { releaseAgentToken } from "./cloudflare-gate.ts";

export const MANIFEST_SUMMARY_LINES = 30;

const READ_ONLY_METHODS = ["GET", "HEAD"];

/** Built-in model providers (01, rules 4–6), by the key that grants each. */
const BUILTINS = [
  { id: "anthropic", host: "api.anthropic.com", key: SECRET_KEYS.anthropic },
  { id: "openai", host: "api.openai.com", key: SECRET_KEYS.openai },
  { id: "openrouter", host: "openrouter.ai", key: SECRET_KEYS.openrouter },
] as const;

const AGENT_BUILTIN = new Map<AgentId, string>([
  ["claude", "anthropic"],
  ["codex", "openai"],
  ["opencode", "openrouter"],
  ["pi", "openrouter"],
]);

export interface Grantee {
  readonly kind: "chat" | "run";
  readonly access: "write" | "read-only";
  /** Null compiles the workspace-wide manifest that TempoOutbound enforces. */
  readonly agent: AgentId | null;
}

type Body = Omit<CapabilityManifest, "revision" | "sha256">;

/** JSON with sorted object keys, so equal manifests hash equally. */
export const canonicalJson = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  if (Schema.is(Schema.JsonObject)(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`)
      .join(",")}}`;

  return JSON.stringify(value);
};

const toJson = (body: Body): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(body)));

const granteeOf = (core: WorkspaceCore, session: SessionRow): Grantee => {
  if (!session.runId) return { kind: "chat", access: "write", agent: session.agent };
  const access = core.lifecycle.runs.snapshot(core.lifecycle.runs.row(session.runId)).access;

  return { kind: "run", access: access === "read-only" ? "read-only" : "write", agent: session.agent };
};

const builtinsFor = async (core: WorkspaceCore, agent: AgentId | null): Promise<CapabilityCall[]> => {
  const creds = core.credentials();
  const wanted = agent === null ? null : AGENT_BUILTIN.get(agent);
  const out: CapabilityCall[] = [];

  for (const b of BUILTINS) {
    if (wanted !== null && wanted !== b.id) continue;

    if (await creds.getSecret(b.key))
      out.push({ id: b.id, hosts: [b.host], credential: null, methods: [], builtin: true });
  }

  return out;
};

const exceptionsFor = async (
  core: WorkspaceCore,
  agent: AgentId | null,
  hostless: boolean,
): Promise<ManifestException[]> => {
  const creds = core.credentials();
  const out: ManifestException[] = [];

  if ((agent === null || agent === "claude") && (await creds.getSecret(SECRET_KEYS.claude)))
    out.push("claude_login");

  if ((agent === null || agent === "codex") && (await creds.getCodexAuth())) out.push("codex_login");

  if (hostless) out.push("secrets_without_hosts");

  return out;
};

/** Compiles the manifest body (14, C-ADR-1) from the profile, the environment and the deploy configuration. */
const compileBody = async (core: WorkspaceCore, grantee: Grantee): Promise<Body> => {
  const projectId = core.ws().projectId;
  const deployStub = core.env.APP_DEPLOY.getByName(projectId);

  const [profileRes, deployRes, environment, mcp] = await Promise.all([
    deployStub.getProfile(),
    deployStub.getConfig(),
    core.environment(),
    core.mcpServers(),
  ]);

  const profile = profileRes.ok ? parseProfile(profileRes.value.source) : null;
  const deploy = deployRes.ok && deployRes.value.enabled ? deployRes.value : null;
  const settings = core.settings().environment;
  const policy = environment?.egressPolicy ?? settings.egress_policy;
  const allowlist = environment?.egressAllowlist ?? settings.egress_allowlist;
  const secrets = environment?.secrets ?? [];
  const claimed = new Set<string>();
  const call: CapabilityCall[] = [];

  for (const s of profile?.services ?? []) {
    if (s.credential) claimed.add(s.credential);
    call.push({
      id: s.name,
      hosts: [...s.hosts],
      credential: s.credential
        ? { ref: s.credential, placeholder: `${SECRET_PLACEHOLDER_PREFIX}${s.credential}` }
        : null,
      methods: [...s.methods],
      builtin: false,
    });
  }

  for (const s of secrets) {
    if (s.hosts.length === 0 || claimed.has(s.name)) continue;
    call.push({
      id: `secret:${s.name}`,
      hosts: [...s.hosts],
      credential: { ref: s.name, placeholder: `${SECRET_PLACEHOLDER_PREFIX}${s.name}` },
      methods: [],
      builtin: false,
    });
  }

  for (const i of environment?.injectors ?? [])
    call.push({
      id: `injector:${i.name}`,
      hosts: [...i.hosts],
      credential: null,
      methods: [],
      builtin: false,
    });

  for (const row of mcp) {
    const egress = mcpToEgress(row);

    if (egress)
      call.push({
        id: `mcp:${row.name}`,
        hosts: [egress.host],
        credential: null,
        methods: [],
        builtin: false,
      });
  }

  if (policy === "allowlist" && allowlist.length > 0)
    call.push({ id: "allowlist", hosts: [...allowlist], credential: null, methods: [], builtin: false });
  call.push(...(await builtinsFor(core, grantee.agent)));
  const projectEnv = await core.credentials().listProjectEnvNames(projectId);
  const hostless = secrets.some((s) => s.hosts.length === 0) || projectEnv.length > 0;
  const readOnly = grantee.access === "read-only";
  const read: CapabilityRead[] = ["repo", "issues", "pull_requests", "ci_runs"];

  if (deploy) read.push("deployments", "prod_errors");
  const resources = [...new Set(deploy?.targets.flatMap((t) => t.workers) ?? [])].sort();

  return {
    schemaVersion: 1,
    projectId,
    session: { kind: grantee.kind, access: grantee.access },
    stack: {
      runtime: profile?.stack.runtime ?? null,
      packageManager: profile?.stack.packageManager ?? null,
      frameworks: [...(profile?.stack.frameworks ?? [])],
      libraries: [...(profile?.stack.libraries ?? [])],
    },
    read,
    call: readOnly
      ? call.map((c) => ({
          ...c,
          methods: c.methods.length
            ? c.methods.filter((m) => READ_ONLY_METHODS.includes(m))
            : READ_ONLY_METHODS,
        }))
      : call,
    cloudflare: deploy && resources.length > 0 ? { resources, permissions: [...deploy.permissions] } : null,
    exceptions: await exceptionsFor(core, grantee.agent, hostless),
    deploy:
      deploy && !readOnly
        ? deploy.targets
            .filter((t) => t.agent)
            .map((t) => ({
              target: t.key,
              workers: [...t.workers],
              cloudflare: [...deploy.permissions],
              agent: true,
            }))
        : [],
  };
};

/** The full manifest with its project revision and hash (14, C-ADR-1). */
export const compileManifest = async (core: WorkspaceCore, grantee: Grantee): Promise<CapabilityManifest> => {
  const body = await compileBody(core, grantee);
  const sha256 = await sha256Hex(canonicalJson(toJson(body)));

  const projectLevel = await sha256Hex(
    canonicalJson(toJson({ ...body, session: { kind: "chat", access: "write" }, exceptions: [] })),
  );

  const res = await core.env.APP_DEPLOY.getByName(body.projectId).manifestRevision(projectLevel);

  if (!res.ok) throw new TempoError(res.error.code, res.error.message, res.error.detail);

  return { ...body, revision: res.value, sha256 };
};

export const storedManifest = (session: SessionRow): CapabilityManifest | null =>
  session.manifestJson
    ? Schema.decodeUnknownSync(CapabilityManifest)(JSON.parse(session.manifestJson))
    : null;

/** Compiles and stores the session's manifest once, when it starts. */
export const sessionManifest = async (
  core: WorkspaceCore,
  session: SessionRow,
): Promise<CapabilityManifest> => {
  const stored = storedManifest(session);

  if (stored) return stored;
  const manifest = await compileManifest(core, granteeOf(core, session));
  core.updateSession(session.id, { manifestJson: JSON.stringify(manifest) });

  return manifest;
};

const methodsText = (methods: ReadonlyArray<string>) => (methods.length ? `; ${methods.join(", ")}` : "");

/** 14, Delivery 1: the first content block of a session's first turn. */
export const manifestSummary = (m: CapabilityManifest): string => {
  const stack = [m.stack.runtime, m.stack.packageManager, ...m.stack.frameworks, ...m.stack.libraries].filter(
    (s) => s !== null,
  );

  const lines = [
    `Capabilities (manifest revision ${m.revision}). Requests outside them are refused. Call the tempo tool get_capabilities for the full list.`,
    ...(stack.length ? [`Stack: ${stack.join(", ")}`] : []),
    `Read: ${m.read.join(", ")}`,
    ...m.call.map((c) => `Call: ${c.id} (${c.hosts.join(", ")}${methodsText(c.methods)})`),
    ...(m.cloudflare
      ? [`Cloudflare API: ${m.cloudflare.permissions.join(", ")} on ${m.cloudflare.resources.join(", ")}`]
      : []),
    ...m.deploy.map((d) => `Deploy: ${d.target} (${d.workers.join(", ")})`),
    ...(m.exceptions.length ? [`Exceptions: ${m.exceptions.join(", ")}`] : []),
  ];

  return lines.length > MANIFEST_SUMMARY_LINES
    ? [
        ...lines.slice(0, MANIFEST_SUMMARY_LINES - 1),
        `… ${lines.length - MANIFEST_SUMMARY_LINES + 1} more in get_capabilities`,
      ].join("\n")
    : lines.join("\n");
};

/** 14, Delivery 2: the manifest without its hash. */
export const capabilitiesForAgent = (m: CapabilityManifest): Omit<CapabilityManifest, "sha256"> => {
  const { sha256: _hash, ...rest } = m;

  return rest;
};

const covers = (now: ReadonlyArray<string>, before: ReadonlyArray<string>) =>
  before.every((x) => now.includes(x));

const methodsCover = (now: ReadonlyArray<string>, before: ReadonlyArray<string>) =>
  now.length === 0 || (before.length > 0 && covers(now, before));

/** The capabilities `before` has and `now` lacks, as ids (14, C-ADR-1: removed access). */
export const removedCapabilities = (now: CapabilityManifest, before: CapabilityManifest): string[] => {
  const removed: string[] = before.read.filter((r) => !now.read.includes(r)).map((r) => `read:${r}`);

  for (const c of before.call) {
    const n = now.call.find((x) => x.id === c.id);

    if (
      !n ||
      !covers(n.hosts, c.hosts) ||
      !methodsCover(n.methods, c.methods) ||
      n.credential?.ref !== c.credential?.ref
    )
      removed.push(c.id);
  }

  if (
    before.cloudflare &&
    (!now.cloudflare ||
      !covers(now.cloudflare.resources, before.cloudflare.resources) ||
      !covers(now.cloudflare.permissions, before.cloudflare.permissions))
  )
    removed.push("cloudflare");

  for (const d of before.deploy) {
    const n = now.deploy.find((x) => x.target === d.target);

    if (!n || !covers(n.workers, d.workers) || !covers(n.cloudflare, d.cloudflare))
      removed.push(`deploy:${d.target}`);
  }

  return removed;
};

/**
 * Recompiles each open session's manifest and ends every session that lost a capability
 * (14, C-ADR-1). Returns the ids of the sessions it ended.
 */
export const enforceRemovedAccess = async (
  core: WorkspaceCore,
  endSession: (sessionId: string, removed: ReadonlyArray<string>) => Promise<void>,
): Promise<string[]> => {
  const ended: string[] = [];

  for (const session of core.db.select().from(sessions).where(ne(sessions.status, "closed")).all()) {
    const before = storedManifest(session);

    if (!before) continue;

    try {
      const removed = removedCapabilities(await compileManifest(core, granteeOf(core, session)), before);

      if (removed.length === 0) continue;
      await endSession(session.id, removed);
      ended.push(session.id);
    } catch (e) {
      log("warn", "manifest check failed", { workspaceId: core.workspaceId, error: errorText(e) });
    }
  }

  return ended;
};

export const ACCESS_REMOVED_NOTICE = (removed: ReadonlyArray<string>) =>
  `The owner removed access this chat used (${removed.join(", ")}). Tempo closed the chat; start a new one.`;

/** Ends a session at once: cancels its turn, drops its queue and closes it (14, C-ADR-1). */
export const endSessionForAccess = async (
  core: WorkspaceCore,
  sessionId: string,
  removed: ReadonlyArray<string>,
): Promise<void> => {
  const running = core.runningTurn();

  if (running?.sessionId === sessionId) {
    await core.tempod?.request("session.cancel", { sessionId, turnId: running.id }).catch(() => undefined);
    finishTurn(core, running.id, "cancelled", { stopReason: "cancelled" });
  }

  dropQueuedTurnsOf(core, sessionId);

  if (core.liveSessions.has(sessionId)) {
    core.liveSessions.delete(sessionId);
    await core.tempod?.request("session.close", { sessionId }).catch(() => undefined);
  }

  core.updateSession(sessionId, { status: "closed", closedAt: Date.now() });
  core.notice("warning", ACCESS_REMOVED_NOTICE(removed), sessionId);
  core.kickQueue();
};

/** The workspace-wide manifest TempoOutbound enforces, after ending sessions that lost access. */
export const workspaceManifest = async (core: WorkspaceCore): Promise<CapabilityManifest> => {
  await enforceRemovedAccess(core, (id, removed) => endSessionForAccess(core, id, removed));
  const manifest = await compileManifest(core, { kind: "chat", access: "write", agent: null });

  if (manifest.cloudflare === null) await releaseAgentToken(core);

  return manifest;
};
