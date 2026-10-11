import type { AgentId, CredentialStatus, Session, Turn } from "@tempo/protocol";
import { AGENT_IDS, agentLabel, hasLogin } from "~/ui/lib/agents";

/** Pure helpers for the center tab strip (04, Tabs). */

export interface AgentMenuEntry {
  readonly agent: AgentId;
  readonly label: string;
  /** False when the agent has no login; the menu shows `Add login in Settings`. */
  readonly enabled: boolean;
}

/** The four agents for New chat. While the credential status loads, every agent is offered. */
export const agentMenu = (status: CredentialStatus | undefined): AgentMenuEntry[] =>
  AGENT_IDS.map((agent) => ({
    agent,
    label: agentLabel(agent),
    enabled: status === undefined || hasLogin(agent, status),
  }));

const bySortOrder = (a: Session, b: Session) => a.sortOrder - b.sortOrder;

export const openSessionIds = (sessions: Readonly<Record<string, Session>>): string[] =>
  Object.values(sessions)
    .filter((s) => s.status !== "closed")
    .sort(bySortOrder)
    .map((s) => s.id);

/** Closed sessions for the `Closed chats` menu, newest first. */
export const closedSessions = (sessions: Readonly<Record<string, Session>>): Session[] =>
  Object.values(sessions)
    .filter((s) => s.status === "closed")
    .sort((a, b) => b.sortOrder - a.sortOrder);

/** Open sessions plus the closed chats the user opened to read. */
export const chatTabIds = (
  openIds: ReadonlyArray<string>,
  viewingClosed: ReadonlyArray<string>,
  sessions: Readonly<Record<string, Session>>,
): string[] => [
  ...openIds,
  ...viewingClosed.filter((id) => !openIds.includes(id) && sessions[id]?.status === "closed"),
];

export const sessionTitle = (session: Pick<Session, "title" | "agent"> | undefined): string =>
  session ? session.title.trim() || agentLabel(session.agent) : "Chat";

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
