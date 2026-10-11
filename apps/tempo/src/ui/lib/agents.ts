import {
  AGENT_IDS,
  AGENT_LABELS,
  type AgentId,
  type CredentialProvider,
  type CredentialStatus,
  type Session,
} from "@tempo/protocol";

export { AGENT_IDS, AGENT_LABELS };

export const agentLabel = (agent: AgentId): string => AGENT_LABELS[agent];

/** Which credentials let an agent run (01, Agents: default login or API key). */
export const AGENT_PROVIDERS: Record<AgentId, ReadonlyArray<CredentialProvider>> = {
  claude: ["claude", "anthropic"],
  codex: ["codex", "openai"],
  opencode: ["openrouter"],
  pi: ["openrouter"],
};

export const hasLogin = (agent: AgentId, status: CredentialStatus | undefined): boolean =>
  status !== undefined && AGENT_PROVIDERS[agent].some((p) => status[p].set);

export const providerAgents = (provider: CredentialProvider): ReadonlyArray<AgentId> =>
  AGENT_IDS.filter((a) => AGENT_PROVIDERS[a].includes(provider));

export const PROVIDER_LABELS: Record<CredentialProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** Plan mode ids from 01, Agents. Pi has none. */
export const PLAN_MODE: Record<AgentId, string | null> = {
  claude: "plan",
  codex: "read-only",
  opencode: "plan",
  pi: null,
};

/** Default mode ids from 01, Agents, used when leaving plan mode. */
const DEFAULT_MODE: Record<AgentId, string | null> = {
  claude: "bypassPermissions",
  codex: "agent-full-access",
  opencode: "build",
  pi: null,
};

export const planModeId = (session: Pick<Session, "agent" | "modes">): string | null => {
  const id = PLAN_MODE[session.agent];
  if (!id) return null;
  return session.modes.length === 0 || session.modes.some((m) => m.id === id) ? id : null;
};

export const isPlanMode = (session: Pick<Session, "agent" | "modes" | "modeId">): boolean => {
  const id = planModeId(session);
  return id !== null && session.modeId === id;
};

/**
 * The mode to switch to when plan mode is toggled. Leaving plan mode goes back to the mode the
 * session had before (when known), else to the agent's default mode, else the first other mode.
 */
export const togglePlanTarget = (
  session: Pick<Session, "agent" | "modes" | "modeId">,
  previous: string | null,
): string | null => {
  const plan = planModeId(session);
  if (!plan) return null;
  if (session.modeId !== plan) return plan;
  const ids = session.modes.map((m) => m.id);
  if (previous && previous !== plan && (ids.length === 0 || ids.includes(previous))) return previous;
  const def = DEFAULT_MODE[session.agent];
  if (def && (ids.length === 0 || ids.includes(def))) return def;
  return ids.find((id) => id !== plan) ?? null;
};
