import type { AgentId, CredentialStatus, CustomAgentSummary, Session, Settings, Turn } from "@tempo/protocol";
import { AGENT_IDS, agentLabel, hasLogin, needsModel } from "~/ui/lib/agents";

/** Pure helpers for the center tab strip (04, Tabs). */

export const NO_MODEL_HINT = "Set a model in Settings → Project";

export interface AgentMenuEntry {
  readonly agent: AgentId;
  readonly label: string;
  readonly enabled: boolean;
  /** Why the agent is disabled. */
  readonly hint: typeof NO_MODEL_HINT | null;
}

/** New chat offers only agents with a confirmed login. */
export const agentMenu = (
  status: CredentialStatus | undefined,
  settings: Settings | null | undefined,
): AgentMenuEntry[] =>
  AGENT_IDS.filter((agent) => status !== undefined && hasLogin(agent, status)).map((agent) => {
    const hint = settings && needsModel(agent, settings) ? NO_MODEL_HINT : null;

    return { agent, label: agentLabel(agent), enabled: hint === null, hint };
  });

export interface CustomAgentMenuEntry extends AgentMenuEntry {
  readonly customAgentId: string;
  /** The base agent's name, shown beside the custom agent's name. */
  readonly baseLabel: string;
}

/** Custom agents need a confirmed login for their base agent. */
export const customAgentMenu = (
  agents: ReadonlyArray<CustomAgentSummary> | undefined,
  status: CredentialStatus | undefined,
): CustomAgentMenuEntry[] =>
  (agents ?? [])
    .filter((a) => status !== undefined && hasLogin(a.baseAgent, status))
    .map((a) => ({
      agent: a.baseAgent,
      customAgentId: a.id,
      label: a.name,
      baseLabel: agentLabel(a.baseAgent),
      enabled: true,
      hint: null,
    }));

const bySortOrder = (a: Session, b: Session) => a.sortOrder - b.sortOrder;

export const openSessionIds = (sessions: Readonly<Record<string, Session>>): string[] =>
  Object.values(sessions)
    .filter((s) => s.status !== "closed" && !s.runId)
    .sort(bySortOrder)
    .map((s) => s.id);

/** Closed sessions for the `Closed chats` menu, newest first. */
export const closedSessions = (sessions: Readonly<Record<string, Session>>): Session[] =>
  Object.values(sessions)
    .filter((s) => s.status === "closed" && !s.runId)
    .sort((a, b) => b.sortOrder - a.sortOrder);

/** Open sessions plus the closed chats the user opened to read. */
export const chatTabIds = (
  openIds: ReadonlyArray<string>,
  viewingClosed: ReadonlyArray<string>,
  sessions: Readonly<Record<string, Session>>,
): string[] => [
  ...openIds,
  ...viewingClosed.filter(
    (id) => !openIds.includes(id) && sessions[id]?.status === "closed" && !sessions[id]?.runId,
  ),
];

export const sessionTitle = (
  session: Pick<Session, "title" | "agent" | "customAgent"> | undefined,
): string =>
  session ? session.title.trim() || session.customAgent?.name || agentLabel(session.agent) : "Chat";

/** A chat from a custom agent names its base agent in the tab tooltip (04, Tabs). */
export const sessionTooltip = (session: Pick<Session, "agent" | "customAgent"> | undefined): string | null =>
  session?.customAgent ? `${session.customAgent.name} · ${agentLabel(session.agent)}` : null;

export const runningTurnOf = (turns: Readonly<Record<string, Turn>>, sessionId: string): Turn | undefined =>
  Object.values(turns).find((t) => t.sessionId === sessionId && t.status === "running");

/**
 * Resolves true once `done()` holds (checked now and on every store change), false after
 * `timeoutMs`. Used to wait for a cancelled turn to end before closing its chat.
 */
export const waitUntil = (
  subscribe: (listener: () => void) => () => void,
  done: () => boolean,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    if (done()) {
      resolve(true);

      return;
    }

    let finished = false;

    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    const unsubscribe = subscribe(() => {
      if (done()) finish(true);
    });
  });

/** Roving focus in the tab strip: the next index for an arrow, Home or End key. */
export const nextTabIndex = (key: string, index: number, count: number): number | null => {
  if (count === 0) return null;

  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
};
