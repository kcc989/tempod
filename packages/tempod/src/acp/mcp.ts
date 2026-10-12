import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  BROWSER_RUN_CDP_ENDPOINT,
  PLAYWRIGHT_MCP_SERVER,
  type BrowserMode,
  type McpServerSpec,
} from "@tempo/protocol";
import { isObj } from "./convert.ts";

/** How tempod runs its own MCP bridge: the command line and the CA env from startup step 2. */
export interface Bridge {
  readonly command: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}

type Remote = Extract<McpServerSpec, { transport: "http" | "sse" }>;
type Stdio = Extract<McpServer, { command: string }>;

/** 01 Browser Run: with `"run"`, Playwright MCP drives the Browser Run session instead of local Chromium. */
export const playwrightServer = (browser: BrowserMode = "local"): Stdio => ({
  name: PLAYWRIGHT_MCP_SERVER.name,
  command: PLAYWRIGHT_MCP_SERVER.command,
  args: browser === "run" ? ["--cdp-endpoint", BROWSER_RUN_CDP_ENDPOINT] : [...PLAYWRIGHT_MCP_SERVER.args],
  env: PLAYWRIGHT_MCP_SERVER.env.map((e) => ({ ...e })),
});

export const bridgeServer = (spec: Remote, bridge: Bridge): Stdio => {
  const [command, ...prefix] = bridge.command;
  return {
    name: spec.name,
    command: command ?? "tempod",
    args: [
      ...prefix,
      "mcp-bridge",
      "--transport",
      spec.transport,
      "--url",
      spec.url,
      ...spec.headers.flatMap((h) => ["--header", `${h.name}: ${h.value}`]),
    ],
    env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })),
  };
};

/** Transports the agent reported in `agentCapabilities.mcpCapabilities`. */
export const mcpTransports = (capabilities: Record<string, unknown>): { http: boolean; sse: boolean } => {
  const mcp = capabilities["mcpCapabilities"];
  return { http: isObj(mcp) && mcp["http"] === true, sse: isObj(mcp) && mcp["sse"] === true };
};

/** The `mcpServers` of `session/new` and `session/load`: Playwright, then the user's servers (01). */
export const acpMcpServers = (
  specs: ReadonlyArray<McpServerSpec>,
  capabilities: Record<string, unknown>,
  bridge: Bridge,
  browser: BrowserMode = "local",
): McpServer[] => {
  const supports = mcpTransports(capabilities);
  return [
    playwrightServer(browser),
    ...specs.map((spec): McpServer => {
      if (spec.transport === "stdio")
        return {
          name: spec.name,
          command: spec.command,
          args: [...spec.args],
          env: spec.env.map((e) => ({ ...e })),
        };
      if (!supports[spec.transport]) return bridgeServer(spec, bridge);
      return {
        type: spec.transport,
        name: spec.name,
        url: spec.url,
        headers: spec.headers.map((h) => ({ ...h })),
      };
    }),
  ];
};

type PiEntry =
  | { command: string; args: string[]; env: Record<string, string> }
  | { url: string; headers: Record<string, string> };

const stdioEntry = (s: {
  command: string;
  args: ReadonlyArray<string>;
  env: ReadonlyArray<{ name: string; value: string }>;
}): PiEntry => ({
  command: s.command,
  args: [...s.args],
  env: Object.fromEntries(s.env.map((e) => [e.name, e.value])),
});

/** `~/.pi/agent/mcp.json` (01, Pi): pi-acp does not pass `mcpServers` to pi. Pi has no SSE client. */
export const piMcpConfig = (
  specs: ReadonlyArray<McpServerSpec>,
  bridge: Bridge,
  browser: BrowserMode = "local",
): { mcpServers: Record<string, PiEntry> } => {
  const servers: Record<string, PiEntry> = {};
  const playwright = playwrightServer(browser);
  servers[playwright.name] = stdioEntry(playwright);
  for (const spec of specs) {
    if (spec.transport === "stdio") servers[spec.name] = stdioEntry(spec);
    else if (spec.transport === "http")
      servers[spec.name] = {
        url: spec.url,
        headers: Object.fromEntries(spec.headers.map((h) => [h.name, h.value])),
      };
    else servers[spec.name] = stdioEntry(bridgeServer(spec, bridge));
  }
  return { mcpServers: servers };
};

export const writePiMcpConfig = (
  piAgentDir: string,
  specs: ReadonlyArray<McpServerSpec>,
  bridge: Bridge,
  browser: BrowserMode = "local",
): void => {
  mkdirSync(piAgentDir, { recursive: true });
  const path = join(piAgentDir, "mcp.json");
  writeFileSync(path, `${JSON.stringify(piMcpConfig(specs, bridge, browser), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};
