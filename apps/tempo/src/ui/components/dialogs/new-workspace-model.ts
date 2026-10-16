import {
  AGENT_IDS,
  DEFAULT_SETTINGS,
  type AgentId,
  type AgentModelOptions,
  type CredentialStatus,
  type AgentSummary,
  type FnInput,
  type ModelPick,
  type NewSource,
  type Project,
} from "@tempo/protocol";
import { hasLogin } from "~/ui/lib/agents";

/** New workspace (04, Dialogs): source tabs, agent and prompt. Pure, so it is unit-tested. */
export type SavedAgentChoice = Pick<AgentSummary, "id" | "name" | "description" | "updatedAt"> & {
  readonly baseAgent: AgentId;
};

export type SourceTab = "new" | "branch" | "pr";

export const SOURCE_TABS: ReadonlyArray<{ readonly id: SourceTab; readonly label: string }> = [
  { id: "new", label: "New branch" },
  { id: "branch", label: "Existing branch" },
  { id: "pr", label: "Pull request" },
];

export const isSourceTab = (s: string): s is SourceTab => s === "new" || s === "branch" || s === "pr";

export interface SourceDraft {
  readonly tab: SourceTab;
  /** New branch: the base. Empty means the project's default branch. */
  readonly baseBranch: string;
  readonly branch: string | null;
  readonly prNumber: number | null;
}

export const emptySource = (): SourceDraft => ({ tab: "new", baseBranch: "", branch: null, prNumber: null });

export const buildSource = (
  draft: SourceDraft,
  project: Pick<Project, "defaultBranch">,
): NewSource | null => {
  switch (draft.tab) {
    case "new":
      return { kind: "new", baseBranch: draft.baseBranch.trim() || project.defaultBranch };
    case "branch":
      return draft.branch ? { kind: "branch", branch: draft.branch } : null;
    case "pr":
      return draft.prNumber !== null ? { kind: "pr", number: draft.prNumber } : null;
  }
};

/** Only agents with a login can be picked (04). */
export const agentsWithLogin = (status: CredentialStatus | undefined): AgentId[] =>
  AGENT_IDS.filter((a) => hasLogin(a, status));

/** The first pick: the project's own default agent, else Claude, else the first agent with a login. */
export const initialAgent = (
  available: ReadonlyArray<AgentId>,
  project: Pick<Project, "settings"> | undefined,
): AgentId | null => {
  const preferred = [project?.settings.agent?.default, DEFAULT_SETTINGS.agent.default];

  return (
    preferred.find((a): a is AgentId => a !== undefined && available.includes(a)) ?? available[0] ?? null
  );
};

/** Saved agents whose base agent has a login, after the plain agents (04, New workspace). */
export const libraryAgentsWithLogin = (
  agents: ReadonlyArray<SavedAgentChoice> | undefined,
  available: ReadonlyArray<AgentId>,
): SavedAgentChoice[] => (agents ?? []).filter((a) => available.includes(a.baseAgent));

const LIBRARY_PREFIX = "agent:";

/** The agent select's value: an agent id, or `agent:<agentId>`. */
export const libraryAgentValue = (agentId: string): string => `${LIBRARY_PREFIX}${agentId}`;

/** The saved agent a select value stands for; null for a model choice or one no longer offered. */
export const libraryAgentOf = (
  value: string | null,
  custom: ReadonlyArray<SavedAgentChoice>,
): SavedAgentChoice | null =>
  value?.startsWith(LIBRARY_PREFIX)
    ? (custom.find((a) => a.id === value.slice(LIBRARY_PREFIX.length)) ?? null)
    : null;

export const createInput = (
  project: Pick<Project, "id" | "defaultBranch">,
  draft: SourceDraft,
  agent: AgentId | null,
  prompt: string,
  model?: string,
  agentId?: string,
): FnInput<"createWorkspace"> | null => {
  const source = buildSource(draft, project);

  if (!source) return null;
  const text = prompt.trim();
  let input: FnInput<"createWorkspace"> = { projectId: project.id, source };

  if (agent) input = { ...input, agent };

  if (model) input = { ...input, model };

  if (agentId) input = { ...input, agentId: agentId };

  if (text) input = { ...input, prompt: { text } };

  return input;
};

/** Pull requests matching the search by number, title or head branch. */
export const filterPullRequests = <P extends { number: number; title: string; headBranch: string }>(
  prs: ReadonlyArray<P>,
  search: string,
): P[] => {
  const q = search.trim().toLowerCase().replace(/^#/, "");

  if (!q) return [...prs];

  return prs.filter(
    (p) =>
      String(p.number).startsWith(q) ||
      p.title.toLowerCase().includes(q) ||
      p.headBranch.toLowerCase().includes(q),
  );
};

export interface ModelChoice {
  readonly key: string;
  readonly agent: AgentId;
  readonly model: string;
  readonly name: string;
}

export const modelChoices = (
  available: ReadonlyArray<AgentId>,
  reported: ReadonlyArray<AgentModelOptions>,
): ModelChoice[] =>
  available.flatMap((agent) =>
    (reported.find((entry) => entry.agent === agent)?.options ?? []).map((option) => ({
      key: JSON.stringify([agent, option.value]),
      agent,
      model: option.value,
      name: option.name,
    })),
  );

/** The owner's picks in list order (01, Model list); every choice when the list is empty or none is offered. */
export const pickedChoices = (
  choices: ReadonlyArray<ModelChoice>,
  picks: ReadonlyArray<ModelPick> | undefined,
): ModelChoice[] => {
  const offered = (picks ?? []).flatMap((pick) =>
    choices.filter((choice) => choice.agent === pick.agent && choice.model === pick.model),
  );

  return offered.length > 0 ? offered : [...choices];
};

export const initialModel = (
  choices: ReadonlyArray<ModelChoice>,
  reported: ReadonlyArray<AgentModelOptions>,
  project: Pick<Project, "settings">,
): ModelChoice | null => {
  const agent = initialAgent(
    choices.map((choice) => choice.agent),
    project,
  );

  const preferred = agent ? project.settings.agent?.models?.[agent] : undefined;
  const current = reported.find((entry) => entry.agent === agent)?.currentValue;

  return (
    choices.find((choice) => choice.agent === agent && choice.model === preferred) ??
    choices.find((choice) => choice.agent === agent && choice.model === current) ??
    choices.find((choice) => choice.agent === agent) ??
    null
  );
};
