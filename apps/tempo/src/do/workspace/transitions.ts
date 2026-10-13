import type { WorkspaceState } from "@tempo/protocol";

/** 03, Transitions. Any other change of state is a bug and throws. */
const ALLOWED: ReadonlyArray<readonly [WorkspaceState | "*", WorkspaceState]> = [
  ["creating", "starting"],
  ["starting", "ready"],
  ["starting", "setting_up"],
  ["setting_up", "ready"],
  ["ready", "working"],
  ["working", "ready"],
  ["ready", "stopping"],
  ["stopping", "sleeping"],
  ["sleeping", "starting"],
  ["ready", "archiving"],
  ["working", "archiving"],
  ["sleeping", "archiving"],
  ["error", "archiving"],
  ["archiving", "archived"],
  ["archived", "sleeping"],
  ["error", "starting"],
  ["ready", "starting"],
  ["working", "starting"],
  ["setting_up", "starting"],
];

export const canTransition = (from: WorkspaceState, to: WorkspaceState): boolean => {
  if (from === to) return true;

  if (to === "error") return from !== "archived";

  return ALLOWED.some(([f, t]) => f === from && t === to);
};

export class IllegalTransition extends Error {
  constructor(from: WorkspaceState, to: WorkspaceState) {
    super(`illegal workspace transition ${from} → ${to}`);
    this.name = "IllegalTransition";
  }
}

export const assertTransition = (from: WorkspaceState, to: WorkspaceState): void => {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
};

/** States in which a container is expected to run. */
export const CONTAINER_STATES: ReadonlyArray<WorkspaceState> = ["setting_up", "ready", "working"];
