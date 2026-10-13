import { join } from "node:path";
import type { AgentId } from "@tempo/protocol";
import pkg from "../package.json" with { type: "json" };

/** The deploy's build id, inlined at build time, so the WorkspaceDO can tell builds apart (05, Upgrades). */
export const VERSION: string = process.env["TEMPO_BUILD_ID"] || pkg.version;

export interface Config {
  readonly token: string;
  readonly port: number;
  readonly workspace: string;
  readonly home: string;
  readonly caCert: string;
  readonly caWaitMs: number;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly ckptIndex: string;
  readonly ckptBundle: string;
  readonly logsDir: string;
  readonly attachments: string;
  readonly codexHome: string;
  readonly claudeConfigDir: string;
  readonly piSessionDir: string;
  readonly piAgentDir: string;
  readonly nssDb: string;
  /** Unix socket of the `tempo` MCP server (01, Environments). */
  readonly mcpSocket: string;
  /** `TEMPO_ARTIFACTS_DIR` and the staged copies of published versions (01, Artifacts). */
  readonly artifactsDir: string;
  readonly artifactsStage: string;
  /** How children run tempod itself, for `tempod mcp-bridge` (01, User MCP servers). */
  readonly selfCommand: ReadonlyArray<string>;
  /** Commands per agent; tests replace them with a fake adapter. */
  readonly agentCommands: Readonly<Record<AgentId, ReadonlyArray<string>>>;
  readonly limits: Limits;
}

export interface Limits {
  readonly outboxMaxEvents: number;
  readonly outboxMaxBytes: number;
  readonly cancelGraceMs: number;
  readonly killGraceMs: number;
  readonly maxLiveAgents: number;
  readonly sigtermExitMs: number;
  readonly portScanMs: number;
  readonly watchPollMs: number;
  readonly watchDebounceMs: number;
  readonly scriptMergeMs: number;
  readonly deltaMergeMs: number;
  readonly deltaMaxBytes: number;
  readonly scriptLogMaxBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  outboxMaxEvents: 50_000,
  outboxMaxBytes: 200 * 1024 * 1024,
  cancelGraceMs: 10_000,
  killGraceMs: 5_000,
  maxLiveAgents: 3,
  sigtermExitMs: 120_000,
  portScanMs: 2_000,
  watchPollMs: 2_000,
  watchDebounceMs: 500,
  scriptMergeMs: 100,
  deltaMergeMs: 100,
  deltaMaxBytes: 8 * 1024,
  scriptLogMaxBytes: 50 * 1024 * 1024,
};

export const agentCommandsFor = (workspace: string): Record<AgentId, ReadonlyArray<string>> => ({
  claude: ["claude-agent-acp"],
  codex: ["codex-acp"],
  opencode: ["opencode", "acp", "--cwd", workspace],
  pi: ["pi-acp"],
});

export class ConfigError extends Error {}

export interface ConfigOverrides {
  readonly agentCommands?: Partial<Record<AgentId, ReadonlyArray<string>>>;
  readonly limits?: Partial<Limits>;
  readonly selfCommand?: ReadonlyArray<string>;
}

export const loadConfig = (
  env: Record<string, string | undefined>,
  overrides: ConfigOverrides = {},
): Config => {
  const token = env["TEMPOD_TOKEN"];
  if (!token) throw new ConfigError("TEMPOD_TOKEN is missing");
  const port = Number(env["TEMPOD_PORT"] ?? "7070");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("TEMPOD_PORT is not a port");
  const workspace = env["TEMPOD_WORKSPACE"] || "/workspace";
  const home = env["TEMPOD_HOME"] || "/home/tempo";
  const caWaitMs = Number(env["TEMPOD_CA_WAIT_MS"] ?? "10000");
  const stateDir = join(home, ".tempod");
  return {
    token,
    port,
    workspace,
    home,
    caCert: env["TEMPOD_CA_CERT"] || "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    caWaitMs: Number.isFinite(caWaitMs) && caWaitMs >= 0 ? caWaitMs : 10_000,
    stateDir,
    dbPath: join(stateDir, "tempod.db"),
    ckptIndex: join(stateDir, "ckpt.index"),
    ckptBundle: join(stateDir, "ckpt.bundle"),
    logsDir: join(stateDir, "logs"),
    attachments: join(home, "attachments"),
    codexHome: join(home, ".codex"),
    claudeConfigDir: join(home, ".claude"),
    piSessionDir: join(home, ".pi", "agent", "sessions"),
    piAgentDir: join(home, ".pi", "agent"),
    nssDb: join(home, ".pki", "nssdb"),
    mcpSocket: join(stateDir, "mcp.sock"),
    artifactsDir: join(home, "artifacts"),
    artifactsStage: join(stateDir, "artifacts"),
    selfCommand: overrides.selfCommand ?? ["/usr/local/bin/tempod"],
    agentCommands: { ...agentCommandsFor(workspace), ...overrides.agentCommands },
    limits: { ...DEFAULT_LIMITS, ...overrides.limits },
  };
};
