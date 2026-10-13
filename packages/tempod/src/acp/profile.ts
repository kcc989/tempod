import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENV_REF_PATTERN,
  PLAYWRIGHT_MCP_SERVER,
  type AgentId,
  type AgentProfile,
  type ConfigOption,
  type McpServerDef,
  type McpServerSpec,
  type ProfileIssue,
} from "@tempo/protocol";

/**
 * How tempod applies a custom agent profile per base agent (01, Custom agents). Prompt and tool
 * limits use each adapter's own extension; whatever an agent cannot take is reported as an issue.
 */

export const PI_EXTENSION_PATH = "/opt/tempo/pi/tempo-profile.ts";

export const profileDir = (stateDir: string, sessionId: string): string =>
  join(stateDir, "profiles", sessionId);

/** Single-quotes one shell word. */
const sh = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

const hasMcp = (p: AgentProfile): boolean => p.playwright || p.mcpServers.length > 0;

/** With `playwright = false`, pi still gets Playwright from `~/.pi/agent/mcp.json`; deny its tools. */
const piDeny = (p: AgentProfile): string[] =>
  p.playwright ? [...p.toolsDeny] : [...p.toolsDeny, `mcp__${PLAYWRIGHT_MCP_SERVER.name}__*`];

/** Env and files the adapter needs before it is spawned. Rewritten on every start. */
interface OpencodeProfileConfig {
  instructions?: string[];
  permission?: Record<string, "allow" | "deny">;
}

interface ProfileEnvironment {
  OPENCODE_CONFIG_CONTENT?: string;
  PI_ACP_PI_COMMAND?: string;
  TEMPO_PROFILE_DIR?: string;
}

export const prepareProfile = (
  agent: AgentId,
  profile: AgentProfile,
  dir: string,
  piExtension: string = PI_EXTENSION_PATH,
): ProfileEnvironment => {
  rmSync(dir, { recursive: true, force: true });

  if (agent === "claude" || agent === "codex") return {};
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const promptFile = join(dir, "prompt.md");

  if (profile.systemPrompt) writeFileSync(promptFile, profile.systemPrompt, { mode: 0o600 });

  if (agent === "opencode") {
    const permission: Record<string, "allow" | "deny"> = {};

    if (profile.toolsAllow.length > 0) {
      permission["*"] = "deny";

      for (const t of profile.toolsAllow) permission[t] = "allow";
    }

    for (const t of profile.toolsDeny) permission[t] = "deny";

    let config: OpencodeProfileConfig = {};

    if (profile.systemPrompt) config = { ...config, instructions: [promptFile] };

    if (Object.keys(permission).length > 0) config = { ...config, permission };

    return Object.keys(config).length > 0 ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } : {};
  }

  // pi: a wrapper adds pi's own flags; the Tempo extension adds MCP servers and the tool guard.
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify({
      servers: profile.mcpServers,
      tools: { allow: profile.toolsAllow, deny: piDeny(profile) },
    }),
    { mode: 0o600 },
  );

  const allow =
    profile.toolsAllow.length > 0 && hasMcp(profile) && !profile.toolsAllow.includes("codemode")
      ? [...profile.toolsAllow, "codemode"]
      : profile.toolsAllow;

  const flags = [
    ...(profile.systemPrompt ? ["--append-system-prompt", promptFile] : []),
    ...(allow.length > 0 ? ["--tools", allow.join(",")] : []),
    ...(piDeny(profile).length > 0 ? ["--exclude-tools", piDeny(profile).join(",")] : []),
    "-e",
    piExtension,
  ];

  const wrapper = join(dir, "pi");
  writeFileSync(wrapper, `#!/bin/sh\nexec pi "$@" ${flags.map(sh).join(" ")}\n`, { mode: 0o700 });
  chmodSync(wrapper, 0o700);

  return { PI_ACP_PI_COMMAND: wrapper, TEMPO_PROFILE_DIR: dir };
};

export const removeProfile = (dir: string): void => rmSync(dir, { recursive: true, force: true });

/** `${NAME}` from env; null when the name is not set. Expanded in memory only. */
const expand = (value: string, env: Record<string, string>): string | null => {
  const name = ENV_REF_PATTERN.exec(value)?.[1];

  return name !== undefined && env[name] !== undefined ? env[name] : null;
};

/** A custom agent server as an `McpServerSpec`, refs expanded; null when a name is missing. */
const toSpec = (s: McpServerDef, env: Record<string, string>): McpServerSpec | null => {
  const vars: Array<{ name: string; value: string }> = [];

  for (const [name, ref] of Object.entries(s.type === "stdio" ? s.env : s.headers)) {
    const value = expand(ref, env);

    if (value === null) return null;
    vars.push({ name, value });
  }

  return s.type === "stdio"
    ? { name: s.name, transport: "stdio", command: s.command, args: [...s.args], env: vars }
    : { name: s.name, transport: s.type, url: s.url, headers: vars };
};

interface SessionProfileMeta {
  systemPrompt?: { append: string };
  claudeCode?: { options: { tools?: string[]; disallowedTools?: string[] } };
  jetbrains?: { air: { customInstructions: string } };
}

export interface SessionProfile {
  readonly meta: SessionProfileMeta | undefined;
  /** The custom agent's servers, added to the user's servers in `session/new` (01, User MCP servers). */
  readonly specs: McpServerSpec[];
  /** Leave Playwright out of the ACP `mcpServers`. */
  readonly dropPlaywright: boolean;
  readonly issues: ProfileIssue[];
}

/** `_meta`, extra MCP servers and issues for session/new and session/load, after initialize. */
export const sessionProfile = (
  agent: AgentId,
  profile: AgentProfile | undefined,
  env: Record<string, string>,
): SessionProfile => {
  if (!profile) return { meta: undefined, specs: [], dropPlaywright: false, issues: [] };
  const issues = new Set<ProfileIssue>();
  let meta: SessionProfileMeta | undefined;

  if (agent === "claude") {
    const options: NonNullable<SessionProfileMeta["claudeCode"]>["options"] = {};

    if (profile.toolsAllow.length > 0) options.tools = [...profile.toolsAllow];

    if (profile.toolsDeny.length > 0) options.disallowedTools = [...profile.toolsDeny];
    meta = {};

    if (profile.systemPrompt) meta.systemPrompt = { append: profile.systemPrompt };

    if (Object.keys(options).length > 0) meta.claudeCode = { options };
  } else if (agent === "codex") {
    if (profile.systemPrompt) meta = { jetbrains: { air: { customInstructions: profile.systemPrompt } } };

    if (profile.toolsAllow.length > 0 || profile.toolsDeny.length > 0) issues.add("tools");
  }

  const specs: McpServerSpec[] = [];

  for (const s of profile.mcpServers) {
    const spec = toSpec(s, env);

    if (!spec || (agent === "pi" && s.type === "sse")) issues.add("mcpServers");
    // pi-acp does not pass ACP mcpServers to pi; the Tempo pi extension registers the custom servers.
    else if (agent !== "pi") specs.push(spec);
  }

  return {
    meta: meta && Object.keys(meta).length > 0 ? meta : undefined,
    specs,
    dropPlaywright: !profile.playwright,
    issues: [...issues],
  };
};

const optionValues = (o: ConfigOption): string[] =>
  (o.options ?? []).flatMap((x) => ("group" in x ? x.options.map((y) => y.value) : [x.value]));

/** The option a value can be set on, or undefined when the agent does not offer that value. */
export const offeredOption = (
  options: ReadonlyArray<ConfigOption>,
  category: "model" | "thought_level",
  value: string,
): ConfigOption | undefined => {
  const option = options.find((o) => o.category === category);

  if (!option) return undefined;
  const values = optionValues(option);

  return values.length === 0 || values.includes(value) ? option : undefined;
};
