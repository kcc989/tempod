import { IssueToolName } from "@tempo/protocol";
import type { ToolReq } from "@tempo/protocol";
import { mkdirSync } from "node:fs";
import {
  type EnvironmentSummary,
  SettingsLayer,
  TempoError,
  type DoHello,
  type TempodEvent,
  type TempodOp,
  type TempodParams,
  type TempodResult,
} from "@tempo/protocol";
import { Exit, Schema } from "effect";
import { SessionManager } from "./acp/manager.ts";
import { capList, CHANGED_FILES_MAX, MESSAGE_BUDGET } from "./bounds.ts";
import type { Config } from "./config.ts";
import { CodexCredentials } from "./credentials.ts";
import { TempodDb } from "./db.ts";
import { findBinary, run } from "./exec.ts";
import { listFiles, readWorkspaceFile, searchFiles } from "./fs.ts";
import { Git, summarize } from "./git.ts";
import { errorText, Logger } from "./log.ts";
import { startMcpSocket } from "./tempo-mcp.ts";
import { Artifacts } from "./artifacts.ts";
import { Outbox } from "./outbox.ts";
import { PortScanner } from "./ports.ts";
import { pruneLogs, ScriptManager } from "./scripts.ts";
import { SettingsState } from "./settings.ts";
import { Watcher } from "./watcher.ts";

export type Handlers = { readonly [O in TempodOp]: (params: TempodParams<O>) => Promise<TempodResult<O>> };

export interface TempodOptions {
  readonly log?: Logger;
  /** CA env vars from startup (01, startup step 2). */
  readonly caEnv?: Record<string, string>;
  /** Called when tempod should exit (SIGTERM mode). */
  readonly exit?: (code: number) => void;
  /** Tests: use the polling watcher even when inotifywait exists. */
  readonly forcePollingWatcher?: boolean;
  /** Tests: port files to scan instead of /proc/net/tcp{,6}. */
  readonly portFiles?: ReadonlyArray<string>;
  /** The port tempod listens on, excluded from previews (TEMPOD_PORT may be 0 in tests). */
  readonly listenPort?: number;
}

const decodeOverrides = Schema.decodeUnknownExit(SettingsLayer);

/** tempod's own env without its TEMPOD_* settings: children must never see TEMPOD_TOKEN (01, Container config). */
export const processEnv = () => {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (Schema.is(Schema.String)(v) && !k.startsWith("TEMPOD_")) out[k] = v;
  }

  return out;
};

/** The daemon: state and request handlers (02, tempod protocol). The server and sockets live in server.ts. */
export class Tempod {
  toolCall: ((input: Omit<ToolReq, "id" | "type">) => Promise<Schema.Json>) | null = null;
  readonly config: Config;
  readonly log: Logger;
  readonly db: TempodDb;
  readonly outbox: Outbox;
  readonly git: Git;
  readonly scripts: ScriptManager;
  readonly agents: SessionManager;
  readonly ports: PortScanner;
  readonly watcher: Watcher;
  readonly codex: CodexCredentials;
  readonly settings: SettingsState;
  readonly artifacts: Artifacts;
  readonly handlers: Handlers;
  private readonly caEnv: Record<string, string>;
  private scriptEnv: Record<string, string> = {};
  environmentSummary: EnvironmentSummary | null = null;
  private mcpSocket: { stop: () => void } | null = null;
  workspaceInfo: DoHello["workspace"] | null = null;
  private background = false;
  sigterm = false;
  private sigtermTimer: ReturnType<typeof setTimeout> | null = null;
  private lastGitChanged: string | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private readonly exitFn: (code: number) => void;
  listenPort: number;
  constructor(config: Config, opts: TempodOptions = {}) {
    this.config = config;
    this.log = opts.log ?? new Logger();
    this.caEnv = opts.caEnv ?? {};
    this.exitFn = opts.exit ?? ((code) => process.exit(code));
    this.listenPort = opts.listenPort ?? config.port;
    mkdirSync(config.stateDir, { recursive: true });
    mkdirSync(config.logsDir, { recursive: true });
    mkdirSync(config.attachments, { recursive: true });
    const pruned = pruneLogs(config.logsDir);

    if (pruned > 0) this.log.info("old script logs deleted", { count: pruned });
    this.db = new TempodDb(config.dbPath);
    this.outbox = new Outbox(
      this.db,
      { maxEvents: config.limits.outboxMaxEvents, maxBytes: config.limits.outboxMaxBytes },
      this.log,
    );
    this.log.onEvent = (level, msg, data) =>
      this.emit(data ? { kind: "log", level, msg, data } : { kind: "log", level, msg });
    const emit = (e: TempodEvent) => this.emit(e);
    this.git = new Git({
      workspace: config.workspace,
      stateDir: config.stateDir,
      ckptIndex: config.ckptIndex,
      ckptBundle: config.ckptBundle,
      db: this.db,
      env: () => this.baseEnv(),
    });
    this.scripts = new ScriptManager({
      workspace: config.workspace,
      logsDir: config.logsDir,
      mergeMs: config.limits.scriptMergeMs,
      killGraceMs: config.limits.killGraceMs,
      logMaxBytes: config.limits.scriptLogMaxBytes,
      db: this.db,
      log: this.log,
      env: () => ({ ...this.baseEnv(), ...this.scriptEnv }),
      emit,
    });
    this.agents = new SessionManager({
      config,
      db: this.db,
      log: this.log,
      emit,
      baseEnv: () => this.baseEnv(),
      scriptEnv: () => this.scriptEnv,
      caEnv: this.caEnv,
    });

    const portOptions: ConstructorParameters<typeof PortScanner>[0] = {
      intervalMs: config.limits.portScanMs,
      exclude: () => [7070, config.port, this.listenPort],
      onChange: (ports) => this.emit({ kind: "ports.changed", ports }),
    };

    if (opts.portFiles) portOptions.files = opts.portFiles;
    this.ports = new PortScanner(portOptions);

    const watcherOptions: ConstructorParameters<typeof Watcher>[0] = {
      workspace: config.workspace,
      log: this.log,
      debounceMs: config.limits.watchDebounceMs,
      pollMs: config.limits.watchPollMs,
      env: () => this.baseEnv(),
      onChange: () => void this.refresh(),
    };

    this.watcher = new Watcher(
      opts.forcePollingWatcher ? { ...watcherOptions, forcePolling: true } : watcherOptions,
    );
    this.artifacts = new Artifacts({
      db: this.db,
      workspace: config.workspace,
      artifactsDir: config.artifactsDir,
      stageDir: config.artifactsStage,
      emit,
      runningTurnId: (sessionId) => this.agents.runningTurnId(sessionId),
    });
    this.codex = new CodexCredentials({
      codexHome: config.codexHome,
      log: this.log,
      onChanged: (content, lastRefresh) =>
        this.emit({ kind: "credential.changed", provider: "codex", content, lastRefresh }),
    });
    const saved = this.db.getMeta("settings.overrides");
    let savedLayer: SettingsLayer | null = null;

    if (saved !== null) {
      try {
        const exit = decodeOverrides(JSON.parse(saved));

        if (Exit.isSuccess(exit)) savedLayer = exit.value;
      } catch {
        // ignore a corrupt value
      }
    }

    this.settings = new SettingsState(config.workspace, savedLayer, (o) =>
      this.db.setMeta("settings.overrides", JSON.stringify(o)),
    );
    this.handlers = this.makeHandlers();
  }
  /** Queues an event. A failing outbox (a full disk) is logged to stderr and never breaks the caller. */
  emit(event: TempodEvent): void {
    try {
      this.outbox.append(event);
    } catch (e) {
      this.log.local("error", "event not queued", { kind: event.kind, error: errorText(e) });
    }
  }
  /** Env for every child: tempod's own env plus the CA vars. */
  baseEnv() {
    return { ...processEnv(), ...this.caEnv } satisfies Record<string, string>;
  }
  private get baseBranch(): string {
    if (!this.workspaceInfo) throw new TempoError("INTERNAL", "hello first");

    return this.workspaceInfo.baseBranch;
  }
  /** Applies hello: env, workspace, and on the first one starts the scanner and the watchers. */
  hello(h: DoHello): void {
    this.workspaceInfo = h.workspace;
    this.scriptEnv = { ...h.env };
    this.startBackground();
  }
  private startBackground(): void {
    if (this.background) return;
    this.background = true;
    this.ports.start();
    this.settings.prime();
    this.watcher.start();
    this.codex.start();

    try {
      this.mcpSocket = startMcpSocket(this.config.mcpSocket, {
        summary: () => this.environmentSummary,
        propose: (proposal) => this.emit({ kind: "environment.proposed", proposal }),
        publish: (req) => this.artifacts.publish(req),
        agentTool: async (input) => {
          const runId = this.agents.toolRunId(input.sessionId);

          if (
            Schema.is(IssueToolName)(input.op)
              ? runId !== input.runId
              : (input.op === "report_result" && (!runId || runId !== input.runId)) ||
                (input.op !== "report_result" && runId)
          )
            throw new TempoError("RUN_NOT_RUNNING");

          if (!this.toolCall) throw new TempoError("TEMPOD_UNREACHABLE");

          return this.toolCall(input);
        },
      });
    } catch (e) {
      this.log.warn("tempo MCP socket failed", { error: errorText(e) });
    }
  }
  private stopBackground(): void {
    this.background = false;
    this.mcpSocket?.stop();
    this.mcpSocket = null;
    this.ports.stop();
    this.watcher.stop();
    this.codex.stop();
  }
  /** Watcher callback: settings re-read and `git.changed` (scope branch), both only when they changed. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;

      return this.refreshing;
    }

    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;

        try {
          const settings = this.settings.reReadIfChanged();

          if (settings) this.emit({ kind: "settings.changed", ...settings });
        } catch (e) {
          this.log.warn("settings re-read failed", { error: errorText(e) });
        }

        if (this.workspaceInfo) {
          try {
            const changes = await this.git.changes("branch", this.workspaceInfo.baseBranch);
            const summary = { files: capList(changes.files, CHANGED_FILES_MAX), ...summarize(changes.files) };
            const key = JSON.stringify(summary);

            if (key !== this.lastGitChanged) {
              this.lastGitChanged = key;
              this.emit({ kind: "git.changed", ...summary });
            }
          } catch (e) {
            this.log.debug("git changes unavailable", { error: errorText(e) });
          }
        }
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }
  private makeHandlers(): Handlers {
    const ws = this.config.workspace;

    return {
      "repo.clone": async (p) => {
        const r = await this.git.clone(p);
        void this.refresh();

        return r;
      },
      "ci.checkout": (p) => this.git.checkoutCommit(p),
      "repo.applyCheckpoint": async (p) => {
        const r = await this.git.applyCheckpoint(p);
        void this.refresh();

        return r;
      },
      "settings.read": async (p) => this.settings.read(p.overrides),
      "env.set": async (p) => {
        this.scriptEnv = { ...p.env };

        return {};
      },
      "environment.set": async (p) => {
        this.environmentSummary = p.summary;

        return {};
      },
      "script.start": async (p) => this.scripts.start(p),
      "script.stop": async (p) => {
        await this.scripts.stop(p.runId);

        return {};
      },
      "session.start": (p) => this.agents.start(p),
      "session.prompt": async (p) => {
        if (this.sigterm) throw new TempoError("CONTAINER_NOT_READY", "tempod is stopping.");

        return this.agents.prompt(p);
      },
      "session.cancel": async (p) => {
        await this.agents.cancel(p);

        return {};
      },
      "session.steer": (p) => this.agents.steer(p),
      "session.setMode": async (p) => {
        await this.agents.setMode(p);

        return {};
      },
      "session.setConfig": (p) => this.agents.setConfig(p),
      "session.close": async (p) => {
        await this.agents.close(p);
        this.codex.check();

        return {};
      },
      "permission.respond": async (p) => {
        this.agents.respondPermission(p);

        return {};
      },
      "credential.put": async (p) => {
        this.codex.put(p.content);

        return {};
      },
      "git.changes": async (p) => {
        const c = await this.git.changes(p.scope, this.baseBranch);
        const files = capList(c.files, MESSAGE_BUDGET);

        return { files, baseSha: c.baseSha, headSha: c.headSha, ahead: c.ahead, dirty: c.dirty };
      },
      "git.fileDiff": (p) => this.git.fileDiff(p.scope, p.path, this.baseBranch),
      "git.checkpoint": (p) => this.git.checkpoint(p, this.baseBranch),
      "git.revert": async (p) => {
        const r = await this.git.revert(p);
        void this.refresh();

        return r;
      },
      "git.commitAndPush": (p) => this.git.commitAndPush(p, this.baseBranch),
      "git.merge": (p) => this.git.merge(p),
      "git.deleteBranch": (p) => this.git.deleteBranch(p),
      "git.renameBranch": async (p) => {
        const r = await this.git.renameBranch(p);

        if (this.workspaceInfo && this.workspaceInfo.branch === p.from) {
          this.workspaceInfo = { ...this.workspaceInfo, branch: p.to };
        }

        return r;
      },
      "git.readFile": (p) => this.git.readFileAt(p.sha, p.path, p.maxBytes),
      "artifact.release": async (p) => {
        this.artifacts.release(p.artifactId, p.version);

        return {};
      },
      "fs.list": async () => ({ paths: await listFiles(ws, this.baseEnv()) }),
      "fs.read": (p) => readWorkspaceFile(ws, p.path, p.maxBytes),
      "fs.search": async (p) => ({
        matches: await searchFiles(ws, this.baseEnv(), p.query, p.regex, p.maxResults),
      }),
      "terminal.list": async () => ({ terminalIds: await this.terminals() }),
      shutdown: async () => {
        await this.shutdown();

        return {};
      },
    };
  }
  private async terminals(): Promise<string[]> {
    const tmux = findBinary("tmux");

    if (!tmux) return [];
    const r = await run([tmux, "list-sessions", "-F", "#S"], { env: this.baseEnv(), timeoutMs: 5_000 });

    if (r.code !== 0) return [];

    return r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /^t[1-9]$/.test(s));
  }
  /** `shutdown`: stop scripts, agents and background work, then flush the outbox. */
  async shutdown(): Promise<void> {
    this.log.info("shutdown");
    this.stopBackground();
    await Promise.all([this.scripts.stopAll(), this.agents.stopAll()]);
    await this.outbox.flush(10_000);
  }
  /** SIGTERM mode (01, tempod). */
  onSigterm(): void {
    if (this.sigterm) return;
    this.sigterm = true;
    this.log.info("SIGTERM received");
    this.agents.refusePrompts = true;
    this.agents.interruptAll();
    this.emit({ kind: "tempod.stopping", reason: "sigterm" });
    this.sigtermTimer = setTimeout(() => this.exitFn(0), this.config.limits.sigtermExitMs);
  }
  /** Called after a `shutdown` response went out: in SIGTERM mode, exit once the socket drained. */
  async afterShutdownAnswered(): Promise<void> {
    if (!this.sigterm) return;

    if (this.sigtermTimer) clearTimeout(this.sigtermTimer);
    await this.outbox.flush(2_000);
    this.exitFn(0);
  }
  /** Stops everything; for tests and process exit. */
  async close(): Promise<void> {
    this.stopBackground();

    if (this.sigtermTimer) clearTimeout(this.sigtermTimer);
    await Promise.all([this.scripts.stopAll(), this.agents.stopAll()]);
    this.db.close();
  }
}
