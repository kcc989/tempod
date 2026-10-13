import type { HubServerMessage, WorkspaceSummary } from "@tempo/protocol";

/** Pure state for the hub channel (02, Hub channel). */
export interface HubState {
  /** True once the first hello arrived. */
  readonly ready: boolean;
  readonly workspaces: Readonly<Record<string, WorkspaceSummary>>;
}

export const emptyHubState: HubState = { ready: false, workspaces: {} };

export const applyHubMessage = (state: HubState, msg: HubServerMessage): HubState => {
  switch (msg.type) {
    case "hello": {
      const workspaces: Record<string, WorkspaceSummary> = {};

      for (const w of msg.workspaces) workspaces[w.id] = w;

      return { ready: true, workspaces };
    }

    case "workspace": {
      const prev = state.workspaces[msg.summary.id];

      if (prev && prev.rev >= msg.summary.rev) return state;

      return { ...state, workspaces: { ...state.workspaces, [msg.summary.id]: msg.summary } };
    }

    case "workspace.removed": {
      if (!(msg.workspaceId in state.workspaces)) return state;
      const { [msg.workspaceId]: _removed, ...rest } = state.workspaces;

      return { ...state, workspaces: rest };
    }

    case "pong":
      return state;
  }
};

/** Merges a summary from elsewhere (a server function result) under the same rev rule. */
export const mergeSummary = (state: HubState, summary: WorkspaceSummary): HubState =>
  applyHubMessage(state, { type: "workspace", summary });

export const isListed = (s: WorkspaceSummary): boolean => s.archivedAt === null && s.state !== "archived";

export type NotifyKind = "finished" | "needs_input" | "error";

export interface NotifyEvent {
  readonly kind: NotifyKind;
  readonly workspace: WorkspaceSummary;
}

/**
 * Browser notification events (04): a turn ends; a workspace enters needs_input; a workspace
 * enters error. A turn end shows as working → not working, or attention becoming unread.
 */
export const notifyEvents = (prev: HubState, next: HubState): NotifyEvent[] => {
  if (!prev.ready || prev === next) return [];
  const out: NotifyEvent[] = [];

  for (const [id, w] of Object.entries(next.workspaces)) {
    const p = prev.workspaces[id];

    if (!p || p === w) continue;

    if (w.attention === "needs_input" && p.attention !== "needs_input") {
      out.push({ kind: "needs_input", workspace: w });
    } else if (w.attention === "error" && p.attention !== "error") {
      out.push({ kind: "error", workspace: w });
    } else if (
      (p.state === "working" && w.state !== "working" && w.state !== "error") ||
      (w.attention === "unread" && p.attention !== "unread")
    ) {
      out.push({ kind: "finished", workspace: w });
    }
  }

  return out;
};

export type SortMode = "activity" | "created";

export interface SidebarSection {
  readonly key: string;
  readonly projectId: string | null;
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
}

/** 04, Sidebar: Pinned (only if any), then one section per project in sort_order. */
export const sidebarSections = (
  workspaces: Readonly<Record<string, WorkspaceSummary>>,
  projects: ReadonlyArray<{ readonly id: string; readonly sortOrder: number }>,
  sort: SortMode,
): SidebarSection[] => {
  const listed = Object.values(workspaces).filter(isListed);

  const cmp = (a: WorkspaceSummary, b: WorkspaceSummary) =>
    sort === "created"
      ? b.createdAt - a.createdAt
      : b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt;

  const sections: SidebarSection[] = [];
  const pinned = listed.filter((w) => w.pinned).sort(cmp);

  if (pinned.length > 0) sections.push({ key: "pinned", projectId: null, workspaces: pinned });
  const ordered = [...projects].sort((a, b) => a.sortOrder - b.sortOrder);

  for (const p of ordered) {
    sections.push({
      key: p.id,
      projectId: p.id,
      workspaces: listed.filter((w) => !w.pinned && w.projectId === p.id).sort(cmp),
    });
  }

  return sections;
};
