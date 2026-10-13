import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tempo pi extension (01, Custom agents). pi-acp does not pass ACP mcpServers to pi. Playwright,
 * tempo and the user's servers come from ~/.pi/agent/mcp.json; this registers the custom agent's own. Its tool_call guard enforces the tool limits: pi codemode
 * scripts can call MCP tools whatever the active tool set, and nested calls pass through tool_call.
 * Self-contained: pi loads it with jiti, and it imports nothing from the pi package.
 */

interface McpDef {
  name: string;
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ProfileFile {
  servers: McpDef[];
  tools: { allow: string[]; deny: string[] };
}

export type PiMcpServerConfig =
  | { command: string | undefined; args: readonly string[]; env: Record<string, string> }
  | { url: string | undefined; headers: Record<string, string> };

export type PiToolDecision = { block: true; reason: string } | undefined;

interface PiApi {
  registerMcpServer(name: string, config: PiMcpServerConfig): void;
  on(event: "tool_call", handler: (event: { toolName: string }) => PiToolDecision): void;
}

const REF = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/** Expands each `${NAME}` value from env; null when a name is missing. */
export const expandRefs = (
  values: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> | null => {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(values ?? {})) {
    const name = REF.exec(v)?.[1];
    const value = name === undefined ? undefined : env[name];

    if (value === undefined) return null;
    out[k] = value;
  }

  return out;
};

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

/** True when the tool may run: not denied, and in a non-empty allowlist. */
export const toolAllowed = (tools: ProfileFile["tools"], name: string): boolean => {
  const matches = (list: string[]) => list.some((p) => globToRegExp(p).test(name));

  if (matches(tools.deny)) return false;

  if (tools.allow.length === 0) return true;

  // codemode and tool_search only reach tools that pass this same guard.
  return matches(tools.allow) || name === "codemode" || name === "tool_search";
};

export const applyProfile = (
  pi: PiApi,
  profile: ProfileFile,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): void => {
  for (const s of profile.servers) {
    if (s.type === "sse") {
      warn(`tempo-profile: skipped ${s.name}`);
      continue;
    }

    if (s.type === "stdio") {
      const vars = expandRefs(s.env, env);

      if (!vars) warn(`tempo-profile: skipped ${s.name}`);
      else pi.registerMcpServer(s.name, { command: s.command, args: s.args ?? [], env: vars });
    } else {
      const headers = expandRefs(s.headers, env);

      if (!headers) warn(`tempo-profile: skipped ${s.name}`);
      else pi.registerMcpServer(s.name, { url: s.url, headers });
    }
  }

  pi.on("tool_call", (event) =>
    toolAllowed(profile.tools, event.toolName)
      ? undefined
      : { block: true, reason: `${event.toolName} is not allowed for this agent` },
  );
};

export default function tempoProfile(pi: PiApi): void {
  const dir = process.env["TEMPO_PROFILE_DIR"];

  if (!dir) return;
  // SAFETY: prepareProfile writes this app-owned file from a validated AgentProfile, with servers and tool limits.
  const profile = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) as ProfileFile;
  applyProfile(pi, profile, process.env, (line) => process.stderr.write(`${line}\n`));
}
