import type {
  HubServerMessage,
  Item,
  ItemOf,
  PermissionRequest,
  ScriptRun,
  Session,
  Turn,
  WorkspaceDetail,
  WorkspaceServerMessage,
  WorkspaceState,
  WorkspaceSummary,
} from "@tempo/protocol";
import { Socket } from "./api.ts";

/** Item kinds that count as agent output for "first agent output" (03, Timing targets). */
export const AGENT_OUTPUT_KINDS: ReadonlyArray<Item["kind"]> = [
  "agent_message",
  "agent_thought",
  "tool_call",
  "plan",
];

const ENDED: ReadonlyArray<Turn["status"]> = ["completed", "cancelled", "failed", "interrupted"];

export const isEnded = (turn: Turn | undefined): boolean => turn !== undefined && ENDED.includes(turn.status);

/**
 * Client state for one workspace channel (02, Workspace channel), built with the same apply rules
 * as the web and Mac stores, plus timestamps the tests measure.
 */
export class WorkspaceWatch {
  detail: WorkspaceDetail | null = null;
  readonly sessions = new Map<string, Session>();
  readonly turns = new Map<string, Turn>();
  readonly items = new Map<string, Item>();
  /** item.delta frames received per item id. */
  readonly deltas = new Map<string, number>();
  /** When this connection first saw each item. */
  readonly firstSeenAt = new Map<string, number>();
  /** Every status a tool_call item had on this connection, in order. */
  readonly toolStatuses = new Map<string, string[]>();
  /** Workspace state changes on this connection. */
  readonly states: Array<{ readonly state: WorkspaceState; readonly at: number }> = [];
  /** Attention changes on this connection. */
  readonly attentions: Array<{ readonly attention: WorkspaceDetail["attention"]; readonly at: number }> = [];
  /** First time each turn was seen with each status. */
  readonly turnStatusAt = new Map<string, Map<Turn["status"], number>>();
  readonly permissions = new Map<string, PermissionRequest>();
  readonly scriptRuns = new Map<string, ScriptRun>();
  /** When this connection first saw each script run. */
  readonly scriptRunSeenAt = new Map<string, number>();
  readonly scriptOutput = new Map<string, string>();
  readonly errors: Array<{ readonly code: string; readonly message: string }> = [];
  /** Frames whose `type` this client does not know. */
  readonly unknown: unknown[] = [];
  itemsRev = 0;
  backlogDone = false;

  private constructor(
    readonly workspaceId: string,
    readonly socket: Socket,
  ) {}

  /** Opens the channel and waits for `hello` and the whole backlog. */
  static async open(workspaceId: string, sinceRev = 0): Promise<WorkspaceWatch> {
    const socket = await Socket.open(`/api/ws/workspace/${workspaceId}?sinceRev=${sinceRev}`, { ping: true });
    const watch = new WorkspaceWatch(workspaceId, socket);
    socket.onJson((m) => watch.apply(m as WorkspaceServerMessage));
    await watch.until("hello and the item backlog", () => watch.backlogDone, 60_000);
    return watch;
  }

  close(): void {
    this.socket.close();
  }

  get state(): WorkspaceState | undefined {
    return this.detail?.state;
  }

  until<T>(label: string, check: () => T | undefined | null | false, timeoutMs: number): Promise<T> {
    return this.socket.until(label, check, timeoutMs);
  }

  /** Waits for one of `states`; fails at once when the workspace goes to `error` instead. */
  waitState(states: ReadonlyArray<WorkspaceState>, timeoutMs: number): Promise<WorkspaceDetail> {
    return this.until(
      `workspace ${this.workspaceId} state ${states.join(" or ")}`,
      () => {
        const d = this.detail;
        if (d?.state === "error" && !states.includes("error")) {
          throw new Error(
            `workspace ${this.workspaceId} went to error: ${d.errorCode ?? ""} ${d.errorDetail ?? ""}`,
          );
        }
        return d && states.includes(d.state) ? d : undefined;
      },
      timeoutMs,
    );
  }

  /** First state change to one of `states` at or after `since`. */
  stateSince(
    states: ReadonlyArray<WorkspaceState>,
    since: number,
  ): { state: WorkspaceState; at: number } | undefined {
    return this.states.find((s) => s.at >= since && states.includes(s.state));
  }

  waitTurnEnded(turnId: string, timeoutMs: number): Promise<Turn> {
    return this.until(
      `turn ${turnId} to end`,
      () => {
        const t = this.turns.get(turnId);
        return t && isEnded(t) ? t : undefined;
      },
      timeoutMs,
    );
  }

  itemsOf<K extends Item["kind"]>(
    kind: K,
    where: { sessionId?: string; turnId?: string } = {},
  ): Array<ItemOf<K>> {
    return [...this.items.values()]
      .filter(
        (i): i is ItemOf<K> =>
          i.kind === kind &&
          (where.sessionId === undefined || i.sessionId === where.sessionId) &&
          (where.turnId === undefined || i.turnId === where.turnId),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** All agent text of a turn (or of a session), oldest first. */
  agentText(where: { sessionId?: string; turnId?: string }): string {
    return this.itemsOf("agent_message", where)
      .map((i) => i.content.text)
      .join("\n");
  }

  /** When this connection first saw agent output after `since`. */
  firstAgentOutputAt(since = 0): number | undefined {
    let first: number | undefined;
    for (const item of this.items.values()) {
      if (!AGENT_OUTPUT_KINDS.includes(item.kind)) continue;
      const at = this.firstSeenAt.get(item.id) ?? Number.POSITIVE_INFINITY;
      if (at >= since && (first === undefined || at < first)) first = at;
    }
    return first;
  }

  /** Permission requests whose item has no chosen option yet. */
  pendingPermissions(): PermissionRequest[] {
    return [...this.permissions.values()].filter((p) => {
      const item = this.items.get(p.itemId);
      return !(item?.kind === "permission" && item.content.chosenOptionId) && item?.status !== "cancelled";
    });
  }

  private noteState(): void {
    const d = this.detail;
    if (!d) return;
    if (this.states.at(-1)?.state !== d.state) this.states.push({ state: d.state, at: Date.now() });
    if (this.attentions.at(-1)?.attention !== d.attention)
      this.attentions.push({ attention: d.attention, at: Date.now() });
  }

  private putTurn(turn: Turn): void {
    this.turns.set(turn.id, turn);
    let seen = this.turnStatusAt.get(turn.id);
    if (!seen) this.turnStatusAt.set(turn.id, (seen = new Map()));
    if (!seen.has(turn.status)) seen.set(turn.status, Date.now());
  }

  private putItem(item: Item): void {
    this.items.set(item.id, item);
    if (!this.firstSeenAt.has(item.id)) this.firstSeenAt.set(item.id, Date.now());
    if (item.kind === "tool_call") {
      const seen = this.toolStatuses.get(item.id) ?? [];
      if (seen.at(-1) !== item.status) seen.push(item.status);
      this.toolStatuses.set(item.id, seen);
    }
  }

  private stale(itemsRev: number): boolean {
    return this.backlogDone && itemsRev < this.itemsRev;
  }

  private apply(m: WorkspaceServerMessage): void {
    switch (m.type) {
      case "hello":
        this.detail = m.workspace;
        this.noteState();
        for (const s of m.sessions) this.sessions.set(s.id, s);
        for (const t of m.turns) this.putTurn(t);
        this.itemsRev = Math.max(this.itemsRev, m.itemsRev);
        return;
      case "items":
        for (const item of m.items) this.putItem(item);
        this.itemsRev = Math.max(this.itemsRev, m.itemsRev);
        if (m.done) this.backlogDone = true;
        return;
      case "item.upsert":
        if (this.stale(m.itemsRev)) return;
        this.putItem(m.item);
        this.itemsRev = Math.max(this.itemsRev, m.itemsRev);
        return;
      case "item.delta": {
        if (this.stale(m.itemsRev)) return;
        const item = this.items.get(m.itemId);
        if (item && "text" in item.content) {
          this.items.set(m.itemId, {
            ...item,
            content: { ...item.content, text: item.content.text + m.append.text },
          } as Item);
        }
        this.deltas.set(m.itemId, (this.deltas.get(m.itemId) ?? 0) + 1);
        this.itemsRev = Math.max(this.itemsRev, m.itemsRev);
        return;
      }
      case "workspace":
        this.detail = m.workspace;
        this.noteState();
        return;
      case "session":
        this.sessions.set(m.session.id, m.session);
        return;
      case "turn":
        this.putTurn(m.turn);
        return;
      case "turn.deleted":
        this.turns.delete(m.turnId);
        return;
      case "permission":
        this.permissions.set(m.request.requestId, m.request);
        return;
      case "script.output":
        this.scriptOutput.set(m.runId, (this.scriptOutput.get(m.runId) ?? "") + m.data);
        return;
      case "script.run":
        this.scriptRuns.set(m.run.id, m.run);
        if (!this.scriptRunSeenAt.has(m.run.id)) this.scriptRunSeenAt.set(m.run.id, Date.now());
        return;
      case "error":
        this.errors.push({ code: m.code, message: m.message });
        return;
      case "changes":
      case "credential.invalid":
      case "pong":
        return;
      default:
        this.unknown.push(m);
    }
  }
}

/** The hub channel (02): one summary per workspace, newest `rev` wins, with a timeline per workspace. */
export class HubWatch {
  readonly summaries = new Map<string, WorkspaceSummary>();
  readonly timeline: Array<{ readonly summary: WorkspaceSummary; readonly at: number }> = [];
  readonly removed = new Set<string>();
  hello = false;

  private constructor(readonly socket: Socket) {}

  static async open(): Promise<HubWatch> {
    const socket = await Socket.open("/api/ws/hub", { ping: true });
    const hub = new HubWatch(socket);
    socket.onJson((m) => hub.apply(m as HubServerMessage));
    await hub.until("hub hello", () => hub.hello, 30_000);
    return hub;
  }

  close(): void {
    this.socket.close();
  }

  until<T>(label: string, check: () => T | undefined | null | false, timeoutMs: number): Promise<T> {
    return this.socket.until(label, check, timeoutMs);
  }

  history(workspaceId: string): Array<{ summary: WorkspaceSummary; at: number }> {
    return this.timeline.filter((e) => e.summary.id === workspaceId);
  }

  /** Highest number of `ids` that the hub showed in `state` at the same moment. */
  maxConcurrent(ids: ReadonlyArray<string>, state: WorkspaceState): number {
    const current = new Map<string, WorkspaceState>();
    let max = 0;
    for (const e of this.timeline) {
      if (!ids.includes(e.summary.id)) continue;
      current.set(e.summary.id, e.summary.state);
      max = Math.max(max, [...current.values()].filter((s) => s === state).length);
    }
    return max;
  }

  private put(summary: WorkspaceSummary): void {
    const known = this.summaries.get(summary.id);
    if (known && known.rev >= summary.rev) return;
    this.summaries.set(summary.id, summary);
    this.timeline.push({ summary, at: Date.now() });
  }

  private apply(m: HubServerMessage): void {
    switch (m.type) {
      case "hello":
        for (const s of m.workspaces) this.put(s);
        this.hello = true;
        return;
      case "workspace":
        this.put(m.summary);
        return;
      case "workspace.removed":
        this.summaries.delete(m.workspaceId);
        this.removed.add(m.workspaceId);
        return;
      case "pong":
        return;
    }
  }
}
