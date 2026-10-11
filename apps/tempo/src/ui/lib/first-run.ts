import { AGENT_IDS, type CredentialStatus } from "@tempo/protocol";
import { hasLogin } from "./agents";

/** 04, First-run setup: the five steps, shown until every one is done. */
export type FirstRunStepId = "createApp" | "installApp" | "addLogin" | "linkRepo" | "createWorkspace";

export interface FirstRunStep {
  readonly id: FirstRunStepId;
  readonly label: string;
  readonly done: boolean;
}

export interface FirstRunInput {
  /** GET /api/setup/status → configured. */
  readonly configured: boolean;
  readonly installationCount: number;
  readonly credentials: CredentialStatus | undefined;
  readonly projectCount: number;
  /** Workspaces including archived ones. */
  readonly workspaceCount: number;
}

export const firstRunSteps = (i: FirstRunInput): FirstRunStep[] => [
  { id: "createApp", label: "Create the GitHub App", done: i.configured },
  { id: "installApp", label: "Install it on an account or org", done: i.installationCount > 0 },
  {
    id: "addLogin",
    label: "Add a Claude login, a Codex login, or an OpenRouter key",
    done: AGENT_IDS.some((a) => hasLogin(a, i.credentials)),
  },
  { id: "linkRepo", label: "Link a repo", done: i.projectCount > 0 },
  { id: "createWorkspace", label: "Create the first workspace", done: i.workspaceCount > 0 },
];

export const isFirstRunDone = (steps: ReadonlyArray<FirstRunStep>): boolean => steps.every((s) => s.done);
