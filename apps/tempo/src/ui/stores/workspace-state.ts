import type {
  RoleRun,
  ChangesSummary,
  CredentialProvider,
  Item,
  ItemOf,
  PermissionRequest,
  ScriptRun,
  Session,
  Turn,
  WorkspaceDetail,
  WorkspaceServerMessage,
} from "@tempo/protocol";

/**
 * Pure state for one workspace channel (02, Workspace channel). `applyWorkspaceMessage` is the
 * only writer; the WorkspaceStore feeds it from the socket.
 */
export interface WorkspaceState {
  /** True once hello arrived. */
  readonly ready: boolean;
  /** True once the backlog of the current connection ended (an `items` with done: true). */
  readonly backlogDone: boolean;
  readonly workspace: WorkspaceDetail | null;
  readonly sessions: Readonly<Record<string, Session>>;
  readonly roleRuns: Readonly<Record<string, RoleRun>>;
  readonly turns: Readonly<Record<string, Turn>>;
  readonly items: Readonly<Record<string, Item>>;
  /** Item ids per session, oldest first. */
  readonly order: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Highest itemsRev seen; sent as sinceRev on reconnect. */
  readonly itemsRev: number;
  /** Pending permission requests by requestId. */
  readonly permissions: Readonly<Record<string, PermissionRequest>>;
  readonly scriptRuns: Readonly<Record<string, ScriptRun>>;
  readonly scriptOutput: Readonly<Record<string, string>>;
  /** Last `changes` message (branch scope). */
  readonly changes: ChangesSummary | null;
  /** Increments on every `changes` message so views refetch. */
  readonly changesSeq: number;
  readonly credentialInvalid: ReadonlyArray<CredentialProvider>;
}

export type WorkspaceEvent =
  | { readonly kind: "turnEnded"; readonly turn: Turn }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | { readonly kind: "credentialInvalid"; readonly provider: CredentialProvider };

export const emptyWorkspaceState: WorkspaceState = {
  ready: false,
  backlogDone: false,
  workspace: null,
  sessions: {},
  roleRuns: {},
  turns: {},
  items: {},
  order: {},
  itemsRev: 0,
  permissions: {},
  scriptRuns: {},
  scriptOutput: {},
  changes: null,
  changesSeq: 0,
  credentialInvalid: [],
};

/** Script output kept per run, in characters. */
export const MAX_SCRIPT_OUTPUT = 512 * 1024;

const ENDED = new Set<Turn["status"]>(["completed", "cancelled", "failed", "interrupted"]);

export const isTurnEnded = (t: Pick<Turn, "status">): boolean => ENDED.has(t.status);

const byKey = <T extends { readonly id: string }>(list: ReadonlyArray<T>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const x of list) out[x.id] = x;
  return out;
};

const compareItems = (a: Item, b: Item): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Inserts an id into an ordered list (binary search on createdAt, then id). */
const insertOrdered = (
  ids: ReadonlyArray<string>,
  item: Item,
  items: Readonly<Record<string, Item>>,
): ReadonlyArray<string> => {
  let lo = 0;
  let hi = ids.length;
  // Fast path: newest item goes at the end.
  const last = ids.length > 0 ? items[ids[ids.length - 1]!] : undefined;
  if (!last || compareItems(last, item) < 0) return [...ids, item.id];
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = items[ids[mid]!];
    if (other && compareItems(other, item) < 0) lo = mid + 1;
    else hi = mid;
  }
  const next = ids.slice();
  next.splice(lo, 0, item.id);
  return next;
};

const isPermissionDone = (item: ItemOf<"permission">): boolean =>
  (item.content.chosenOptionId ?? null) !== null ||
  item.status === "completed" ||
  item.status === "cancelled" ||
  item.status === "failed";

/** Applies a batch of items under the per-item rev rule. Mutates the given draft maps. */
const upsertItems = (
  state: WorkspaceState,
  incoming: ReadonlyArray<Item>,
): Pick<WorkspaceState, "items" | "order" | "permissions" | "itemsRev"> => {
  let items = state.items;
  let order = state.order;
  let permissions = state.permissions;
  let itemsRev = state.itemsRev;
  let copiedItems = false;
  let copiedOrder = false;
  for (const item of incoming) {
    itemsRev = Math.max(itemsRev, item.rev);
    const prev = items[item.id];
    if (prev && prev.rev > item.rev) continue;
    if (!copiedItems) {
      items = { ...items };
      copiedItems = true;
    }
    (items as Record<string, Item>)[item.id] = item;
    if (!prev || prev.sessionId !== item.sessionId) {
      if (!copiedOrder) {
        order = { ...order };
        copiedOrder = true;
      }
      if (prev && prev.sessionId !== item.sessionId) {
        (order as Record<string, ReadonlyArray<string>>)[prev.sessionId] = (
          order[prev.sessionId] ?? []
        ).filter((id) => id !== item.id);
      }
      (order as Record<string, ReadonlyArray<string>>)[item.sessionId] = insertOrdered(
        order[item.sessionId] ?? [],
        item,
        items,
      );
    }
    if (item.kind === "permission" && isPermissionDone(item) && item.content.requestId in permissions) {
      const { [item.content.requestId]: _done, ...rest } = permissions;
      permissions = rest;
    }
  }
  return { items, order, permissions, itemsRev };
};

export interface ApplyResult {
  readonly state: WorkspaceState;
  readonly events: ReadonlyArray<WorkspaceEvent>;
}

const same = (state: WorkspaceState): ApplyResult => ({ state, events: [] });

export const applyWorkspaceMessage = (state: WorkspaceState, msg: WorkspaceServerMessage): ApplyResult => {
  // After the backlog, any message whose itemsRev is lower than ours is stale (02, Rules).
  if (
    state.backlogDone &&
    (msg.type === "item.upsert" || msg.type === "item.delta" || msg.type === "items") &&
    msg.itemsRev < state.itemsRev
  ) {
    return same(state);
  }
  switch (msg.type) {
    case "hello":
      return same({
        ...state,
        ready: true,
        backlogDone: false,
        workspace: msg.workspace,
        sessions: byKey(msg.sessions),
        turns: byKey(msg.turns),
      });
    case "items": {
      const next = upsertItems(state, msg.items);
      return same({
        ...state,
        ...next,
        itemsRev: Math.max(next.itemsRev, msg.itemsRev),
        backlogDone: state.backlogDone || msg.done,
      });
    }
    case "item.upsert": {
      const next = upsertItems(state, [msg.item]);
      return same({ ...state, ...next, itemsRev: Math.max(next.itemsRev, msg.itemsRev) });
    }
    case "item.delta": {
      const item = state.items[msg.itemId];
      const itemsRev = Math.max(state.itemsRev, msg.itemsRev);
      if (!item || !("text" in item.content)) return same({ ...state, itemsRev });
      const content = { ...item.content, text: item.content.text + msg.append.text };
      const updated = { ...item, content } as Item;
      return same({ ...state, itemsRev, items: { ...state.items, [item.id]: updated } });
    }
    case "workspace":
      return same({ ...state, workspace: msg.workspace });
    case "session":
      return same({ ...state, sessions: { ...state.sessions, [msg.session.id]: msg.session } });
    case "roleRun":
      return same({ ...state, roleRuns: { ...state.roleRuns, [msg.run.id]: msg.run } });
    case "turn": {
      const prev = state.turns[msg.turn.id];
      const events: WorkspaceEvent[] =
        isTurnEnded(msg.turn) && (!prev || !isTurnEnded(prev)) ? [{ kind: "turnEnded", turn: msg.turn }] : [];
      return { state: { ...state, turns: { ...state.turns, [msg.turn.id]: msg.turn } }, events };
    }
    case "turn.deleted": {
      if (!(msg.turnId in state.turns)) return same(state);
      const { [msg.turnId]: _gone, ...turns } = state.turns;
      return same({ ...state, turns });
    }
    case "permission": {
      const item = state.items[msg.request.itemId];
      if (item && item.kind === "permission" && isPermissionDone(item)) return same(state);
      return same({ ...state, permissions: { ...state.permissions, [msg.request.requestId]: msg.request } });
    }
    case "script.output": {
      const prev = state.scriptOutput[msg.runId] ?? "";
      let text = prev + msg.data;
      if (text.length > MAX_SCRIPT_OUTPUT) text = text.slice(text.length - MAX_SCRIPT_OUTPUT);
      return same({ ...state, scriptOutput: { ...state.scriptOutput, [msg.runId]: text } });
    }
    case "script.run":
      return same({ ...state, scriptRuns: { ...state.scriptRuns, [msg.run.id]: msg.run } });
    case "changes":
      return same({
        ...state,
        changes: { files: msg.files, additions: msg.additions, deletions: msg.deletions },
        changesSeq: state.changesSeq + 1,
      });
    case "credential.invalid": {
      const events: WorkspaceEvent[] = [{ kind: "credentialInvalid", provider: msg.provider }];
      if (state.credentialInvalid.includes(msg.provider)) return { state, events };
      return { state: { ...state, credentialInvalid: [...state.credentialInvalid, msg.provider] }, events };
    }
    case "error":
      return { state, events: [{ kind: "error", code: msg.code, message: msg.message }] };
    case "pong":
      return same(state);
  }
};

/** Seeds a run's output with the log tail from listScriptRuns without losing live output. */
export const seedScriptOutput = (state: WorkspaceState, runId: string, logTail: string): WorkspaceState => {
  const live = state.scriptOutput[runId];
  let text: string;
  if (live === undefined || live === "") text = logTail;
  else if (logTail.endsWith(live)) text = logTail;
  else if (live.startsWith(logTail)) text = live;
  else text = logTail + live;
  if (text === live) return state;
  return { ...state, scriptOutput: { ...state.scriptOutput, [runId]: text } };
};

export const clearCredentialInvalid = (
  state: WorkspaceState,
  providers: ReadonlyArray<CredentialProvider>,
): WorkspaceState => {
  const next = state.credentialInvalid.filter((p) => !providers.includes(p));
  return next.length === state.credentialInvalid.length ? state : { ...state, credentialInvalid: next };
};

// Selectors.

export const sessionTurns = (state: WorkspaceState, sessionId: string): Turn[] =>
  Object.values(state.turns)
    .filter((t) => t.sessionId === sessionId)
    .sort((a, b) => a.seq - b.seq);

export const runningTurn = (state: WorkspaceState, sessionId: string): Turn | undefined =>
  Object.values(state.turns).find((t) => t.sessionId === sessionId && t.status === "running");

/** Queued turns of the whole workspace in queue order (the queue is workspace-wide). */
export const queuedTurns = (state: WorkspaceState): Turn[] =>
  Object.values(state.turns)
    .filter((t) => t.status === "queued")
    .sort((a, b) => (a.queuePos ?? Infinity) - (b.queuePos ?? Infinity) || a.queuedAt - b.queuedAt);

/** The workspace queue with `turnId` moved to `toIndex` among the session's own queued turns. */
export const reorderedQueue = (
  state: WorkspaceState,
  sessionId: string,
  turnId: string,
  toIndex: number,
): string[] => {
  const all = queuedTurns(state).map((t) => t.id);
  const mine = queuedTurns(state)
    .filter((t) => t.sessionId === sessionId)
    .map((t) => t.id);
  const from = mine.indexOf(turnId);
  if (from < 0) return all;
  const moved = mine.slice();
  moved.splice(from, 1);
  moved.splice(Math.max(0, Math.min(toIndex, moved.length)), 0, turnId);
  // Put the session's turns back into the slots they held, in the new order.
  let k = 0;
  return all.map((id) => (mine.includes(id) ? moved[k++]! : id));
};

export type TranscriptRow =
  | { readonly kind: "item"; readonly key: string; readonly itemId: string; readonly reverted: boolean }
  | { readonly kind: "turnFooter"; readonly key: string; readonly turnId: string };

/**
 * The transcript of one session as rows: every item, plus a footer after the last item of each
 * ended turn (duration and tokens). Items of reverted turns are flagged for 50% opacity.
 */
export const transcriptRows = (
  order: ReadonlyArray<string>,
  items: Readonly<Record<string, Item>>,
  turns: Readonly<Record<string, Turn>>,
): TranscriptRow[] => {
  const rows: TranscriptRow[] = [];
  const lastIndexOfTurn = new Map<string, number>();
  order.forEach((id, i) => {
    const t = items[id]?.turnId;
    if (t) lastIndexOfTurn.set(t, i);
  });
  order.forEach((id, i) => {
    const item = items[id];
    if (!item) return;
    const turn = item.turnId ? turns[item.turnId] : undefined;
    rows.push({ kind: "item", key: id, itemId: id, reverted: turn?.reverted === true });
    if (turn && lastIndexOfTurn.get(turn.id) === i && isTurnEnded(turn)) {
      rows.push({ kind: "turnFooter", key: `footer:${turn.id}`, turnId: turn.id });
    }
  });
  return rows;
};

/** The newest plan of the session's running turn, for the `Plan 3/4` pill. */
export const runningPlan = (
  state: WorkspaceState,
  sessionId: string,
): { readonly done: number; readonly total: number } | null => {
  const turn = runningTurn(state, sessionId);
  if (!turn) return null;
  const ids = state.order[sessionId] ?? [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const item = state.items[ids[i]!];
    if (!item || item.turnId !== turn.id) continue;
    if (item.kind === "plan") {
      const total = item.content.entries.length;
      const done = item.content.entries.filter((e) => e.status === "completed").length;
      return total > 0 ? { done, total } : null;
    }
  }
  return null;
};

/** The first prompt line of each turn, oldest first, for the default PR body (03). */
export const promptFirstLines = (state: WorkspaceState, max = 20): string[] =>
  Object.values(state.turns)
    .filter((t) => !t.reverted && t.status !== "queued")
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .map((t) => t.prompt.text.split("\n")[0]!.trim())
    .filter((l) => l.length > 0)
    .slice(0, max);
