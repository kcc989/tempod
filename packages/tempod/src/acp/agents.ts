import type { AgentId } from "@tempo/protocol";
import type { Config } from "../config.ts";

/** Extra env per agent (01, Agents). */
export const agentExtraEnv = (agent: AgentId, config: Config) => {
  switch (agent) {
    case "claude":
      return { CLAUDE_CONFIG_DIR: config.claudeConfigDir } satisfies Record<string, string>;
    case "codex":
      return { CODEX_HOME: config.codexHome, INITIAL_AGENT_MODE: "agent-full-access" } satisfies Record<
        string,
        string
      >;
    case "opencode":
      return {} satisfies Record<string, string>;
    case "pi":
      return { PI_CODING_AGENT_SESSION_DIR: config.piSessionDir } satisfies Record<string, string>;
  }
};

/**
 * Adapter env: process env (with CA vars), then the script env from hello/env.set, then session.start env,
 * then the agent's extra env. With the Claude OAuth token, an inherited API key must not win (01, Agents).
 */
export const agentEnv = (
  agent: AgentId,
  config: Config,
  base: Record<string, string>,
  scriptEnv: Record<string, string>,
  sessionEnv: Record<string, string>,
) => {
  const inherited = { ...base, ...scriptEnv };

  if (agent === "claude" && sessionEnv["CLAUDE_CODE_OAUTH_TOKEN"]) {
    delete inherited["ANTHROPIC_API_KEY"];
    delete inherited["ANTHROPIC_AUTH_TOKEN"];
  }

  const merged = { ...inherited, ...sessionEnv } satisfies Record<string, string>;
  Object.assign(merged, agentExtraEnv(agent, config));

  return merged;
};
