import {
  TempoError,
  type AgentId,
  type BrowserMode,
  type AgentProfile,
  type ConfigOption,
  type McpServerSpec,
  type SessionStartResult,
  type TempodEvent,
} from "@tempo/protocol";
import type { Config } from "../config.ts";
import type { TempodDb } from "../db.ts";
import { errorText, type Logger } from "../log.ts";
import { agentEnv } from "./agents.ts";
import { writePiMcpConfig, type Bridge } from "./mcp.ts";
import { prepareProfile, profileDir, removeProfile } from "./profile.ts";
import { AgentSession } from "./session.ts";

export interface ManagerDeps {
  readonly config: Config;
  readonly db: TempodDb;
  readonly log: Logger;
  readonly emit: (event: TempodEvent) => void;
  readonly baseEnv: () => Record<string, string>;
  readonly scriptEnv: () => Record<string, string>;
  readonly caEnv?: Record<string, string>;
}

export interface StartParams {
  readonly sessionId: string;
  readonly agent: AgentId;
  readonly env: Record<string, string>;
  readonly modeId?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly profile?: AgentProfile | undefined;
  readonly access?: "read-only" | "write" | undefined;
  readonly acpSessionId?: string | null | undefined;
  readonly browser?: BrowserMode | undefined;
  readonly mcpServers?: ReadonlyArray<McpServerSpec> | undefined;
}

const acpError = (cause: unknown): TempoError =>
  cause instanceof TempoError ? cause : new TempoError("INTERNAL", errorText(cause).slice(0, 2_000));

/** Live adapter processes, at most `maxLiveAgents` (01, Sessions). */
export class SessionManager {
  private readonly toolRuns = new Map<string, string>();
  toolRunId(sessionId: string): string | undefined {
    this.live(sessionId);

    return this.toolRuns.get(sessionId);
  }
  private readonly sessions = new Map<string, AgentSession>();
  private readonly starting = new Map<string, Promise<SessionStartResult>>();
  private readonly ready = new Set<AgentSession>();
  private startTail: Promise<void> = Promise.resolve();
  refusePrompts = false;
  constructor(private readonly deps: ManagerDeps) {}
  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }
  /** The running turn of a session, or null (01, Artifacts, Publish 6). */
  runningTurnId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.runningTurnId ?? null;
  }
  get liveCount(): number {
    return this.sessions.size;
  }
  private live(sessionId: string): AgentSession {
    const s = this.sessions.get(sessionId);

    if (!s || !s.alive || !this.ready.has(s)) {
      throw new TempoError("NOT_FOUND", "The session has no live agent; start it first.");
    }

    return s;
  }
  start(p: StartParams): Promise<SessionStartResult> {
    const inFlight = this.starting.get(p.sessionId);

    if (inFlight) return inFlight;

    const promise = this.startTail
      .then(() => this.doStart(p))
      .finally(() => this.starting.delete(p.sessionId));

    this.startTail = promise.then(
      () => undefined,
      () => undefined,
    );
    this.starting.set(p.sessionId, promise);

    return promise;
  }
  private async doStart(p: StartParams): Promise<SessionStartResult> {
    const existing = this.sessions.get(p.sessionId);

    if (existing) {
      const same =
        existing.agent === p.agent && (!p.acpSessionId || p.acpSessionId === existing.acpSessionId);

      if (same && existing.alive && this.ready.has(existing)) return existing.result(false, false);

      if (existing.busy) throw new TempoError("SESSION_BUSY");
      await existing.close("requested", true);
    }

    await this.makeRoom(p.sessionId);
    const { config, log } = this.deps;
    const command = config.agentCommands[p.agent];

    if (p.access === "read-only" && p.agent === "pi" && p.profile)
      p = {
        ...p,
        profile: { ...p.profile, toolsDeny: [...new Set([...p.profile.toolsDeny, "write", "edit"])] },
      };
    const env = agentEnv(p.agent, config, this.deps.baseEnv(), this.deps.scriptEnv(), p.env);

    if (p.env["TEMPO_RUN_ID"]) this.toolRuns.set(p.sessionId, p.env["TEMPO_RUN_ID"]);
    else this.toolRuns.delete(p.sessionId);
    const bridge: Bridge = { command: config.selfCommand, env: { ...this.deps.caEnv } };

    if (p.agent === "pi") {
      try {
        writePiMcpConfig(
          config.piAgentDir,
          p.mcpServers ?? [],
          bridge,
          p.browser ?? "local",
          p.sessionId,
          p.env,
        );
      } catch (e) {
        log.warn("writing pi mcp.json failed", { sessionId: p.sessionId, error: errorText(e) });
      }
    }

    let session: AgentSession;

    try {
      if (p.profile)
        Object.assign(env, prepareProfile(p.agent, p.profile, profileDir(config.stateDir, p.sessionId)));
      session = new AgentSession(p.sessionId, p.agent, command, env, {
        workspace: config.workspace,
        attachments: config.attachments,
        log,
        emit: this.deps.emit,
        cancelGraceMs: config.limits.cancelGraceMs,
        killGraceMs: config.limits.killGraceMs,
        mergeMs: config.limits.deltaMergeMs,
        maxBytes: config.limits.deltaMaxBytes,
        bridge,
        onGone: (s) => {
          if (this.sessions.get(s.sessionId) === s) this.sessions.delete(s.sessionId);
          this.ready.delete(s);
        },
        onProcess: (s, pid) => {
          if (pid === null) this.deps.db.removeProcess(`agent:${s.sessionId}`);
          else this.deps.db.addProcess(`agent:${s.sessionId}`, "agent", pid);
        },
      });
    } catch (e) {
      throw new TempoError("AGENT_START_FAILED", `Could not run ${command[0] ?? p.agent}: ${errorText(e)}`);
    }

    this.sessions.set(p.sessionId, session);
    log.info("agent started", { sessionId: p.sessionId, agent: p.agent, pid: session.pid });

    try {
      const result = await session.start(p);

      if (!session.alive) throw new Error("the agent exited");
      this.ready.add(session);

      return result;
    } catch (e) {
      await session.close("requested", false);
      const tail = session.stderrTail().split("\n").slice(-20).join("\n");
      throw new TempoError("AGENT_START_FAILED", `${errorText(e)}${tail ? `\n${tail}` : ""}`.slice(0, 4_000));
    }
  }
  /** Closes the least recently used idle session while starting this one would exceed the limit. */
  private async makeRoom(sessionId: string): Promise<void> {
    const max = this.deps.config.limits.maxLiveAgents;

    for (;;) {
      const others = [...this.sessions.values()].filter((s) => s.sessionId !== sessionId);

      if (others.length < max) return;

      const idle = others
        .filter((s) => !s.busy && this.ready.has(s) && !this.starting.has(s.sessionId))
        .sort((a, b) => a.lastUsed - b.lastUsed);

      const victim = idle[0];

      if (!victim) {
        throw new TempoError("AGENT_START_FAILED", "No idle agent is available to close.");
      }

      this.deps.log.info("closing least recently used agent", { sessionId: victim.sessionId });
      await victim.close("evicted", true);
    }
  }
  prompt(p: {
    sessionId: string;
    turnId: string;
    content: ReadonlyArray<import("@tempo/protocol").ContentBlock>;
  }) {
    if (this.refusePrompts) throw new TempoError("CONTAINER_NOT_READY", "tempod is stopping.");
    this.live(p.sessionId).prompt(p.turnId, p.content);

    return { accepted: true } satisfies {
      accepted: true;
    };
  }
  async cancel(p: { sessionId: string; turnId: string }): Promise<void> {
    const s = this.sessions.get(p.sessionId);

    if (s) await s.cancel(p.turnId);
  }
  steer(p: {
    sessionId: string;
    turnId: string;
    messageId: string;
    content: ReadonlyArray<import("@tempo/protocol").ContentBlock>;
  }) {
    if (this.refusePrompts) throw new TempoError("CONTAINER_NOT_READY", "tempod is stopping.");
    const session = this.sessions.get(p.sessionId);

    return session
      ? session.steer(p.turnId, p.messageId, p.content)
      : Promise.resolve({ outcome: "promptRequired" as const });
  }
  async setMode(p: { sessionId: string; modeId: string }): Promise<void> {
    const s = this.live(p.sessionId);

    if (s.busy) throw new TempoError("SESSION_BUSY");

    try {
      await s.setMode(p.modeId);
    } catch (e) {
      throw acpError(e);
    }

    this.deps.emit({
      kind: "session.updated",
      sessionId: p.sessionId,
      patch: { modeId: s.mapper.state.modeId },
    });
  }
  async setConfig(p: {
    sessionId: string;
    configId: string;
    value: string | boolean;
  }): Promise<{ configOptions: ConfigOption[] }> {
    const s = this.live(p.sessionId);

    if (s.busy) throw new TempoError("SESSION_BUSY");

    try {
      return { configOptions: await s.setConfig(p.configId, p.value) };
    } catch (e) {
      throw acpError(e);
    }
  }
  async close(p: { sessionId: string }): Promise<void> {
    const s = this.sessions.get(p.sessionId);

    if (s?.busy) throw new TempoError("SESSION_BUSY");
    await s?.close("requested", true);
    removeProfile(profileDir(this.deps.config.stateDir, p.sessionId));
  }
  respondPermission(p: { requestId: string; optionId: string | null }): void {
    for (const s of this.sessions.values()) {
      if (s.hasPermission(p.requestId)) {
        s.respondPermission(p.requestId, p.optionId);

        return;
      }
    }

    throw new TempoError("NOT_FOUND");
  }
  interruptAll(): void {
    for (const s of this.sessions.values()) s.interrupt();
  }
  async stopAll(): Promise<void> {
    this.interruptAll();
    await Promise.all([...this.sessions.values()].map((s) => s.close("requested", false)));
  }
}
