import type { CredentialProvider } from "@tempo/protocol";
import { ReconnectingSocket, wsUrl, type SocketLike, type SocketStatus } from "~/ui/lib/socket";
import { connectionMonitor } from "./connection";
import { parseWorkspaceMessage } from "./parse";
import {
  applyWorkspaceMessage,
  clearCredentialInvalid,
  emptyWorkspaceState,
  seedScriptOutput,
  type WorkspaceEvent,
  type WorkspaceState,
} from "./workspace-state";

export interface WorkspaceSnapshot extends WorkspaceState {
  readonly status: SocketStatus;
}

/**
 * One store per open workspace, fed by its WebSocket and read with useSyncExternalStore (04,
 * Data). Message handling lives in workspace-state.ts.
 */
export class WorkspaceStore {
  private snapshot: WorkspaceSnapshot;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: WorkspaceEvent) => void>();
  private socket: ReconnectingSocket;
  private started = false;

  constructor(
    readonly workspaceId: string,
    factory?: (url: string) => SocketLike,
  ) {
    this.snapshot = { ...emptyWorkspaceState, status: "connecting" };
    this.socket = new ReconnectingSocket({
      url: () =>
        wsUrl(`/api/ws/workspace/${encodeURIComponent(workspaceId)}?sinceRev=${this.snapshot.itemsRev}`),
      onMessage: (raw) => this.receive(raw),
      onStatus: (status) => {
        connectionMonitor.report(this.key, status);
        this.setSnapshot({ ...this.snapshot, status });
      },
      ...(factory ? { factory } : {}),
    });
  }

  private get key(): string {
    return `workspace:${this.workspaceId}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    connectionMonitor.report(this.key, "connecting");
    this.socket.start();
  }

  stop(): void {
    this.started = false;
    this.socket.stop();
    connectionMonitor.remove(this.key);
  }

  reconnectNow(): void {
    this.socket.reconnectNow();
  }

  getSnapshot = (): WorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onEvent(listener: (e: WorkspaceEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Exposed for tests and for replaying a frame. */
  receive(raw: string): void {
    const msg = parseWorkspaceMessage(raw);
    if (!msg) return;
    const { state, events } = applyWorkspaceMessage(this.snapshot, msg);
    if (state !== this.snapshot) this.setSnapshot({ ...state, status: this.snapshot.status });
    for (const e of events) for (const l of this.eventListeners) l(e);
  }

  seedScriptOutput(runId: string, logTail: string): void {
    const next = seedScriptOutput(this.snapshot, runId, logTail);
    if (next !== this.snapshot) this.setSnapshot({ ...next, status: this.snapshot.status });
  }

  clearCredentialInvalid(providers: ReadonlyArray<CredentialProvider>): void {
    const next = clearCredentialInvalid(this.snapshot, providers);
    if (next !== this.snapshot) this.setSnapshot({ ...next, status: this.snapshot.status });
  }

  private setSnapshot(next: WorkspaceSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

const stores = new Map<
  string,
  { store: WorkspaceStore; refs: number; timer: ReturnType<typeof setTimeout> | null }
>();

/** Grace period before a store whose view unmounted closes its socket. */
const RELEASE_MS = 5_000;

/** Returns the workspace's store, creating it (not yet connected) if needed. Safe during render. */
export const getWorkspaceStore = (workspaceId: string): WorkspaceStore => {
  let entry = stores.get(workspaceId);
  if (!entry) {
    entry = { store: new WorkspaceStore(workspaceId), refs: 0, timer: null };
    stores.set(workspaceId, entry);
  }
  return entry.store;
};

/** Called from an effect: keeps the store connected while a view uses it. */
export const retainWorkspaceStore = (store: WorkspaceStore): void => {
  let entry = stores.get(store.workspaceId);
  if (!entry || entry.store !== store) {
    entry?.store.stop();
    entry = { store, refs: 0, timer: null };
    stores.set(store.workspaceId, entry);
  }
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  entry.refs++;
  store.start();
};

export const releaseWorkspaceStore = (store: WorkspaceStore): void => {
  const entry = stores.get(store.workspaceId);
  if (!entry || entry.store !== store) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  entry.timer = setTimeout(() => {
    if (entry.refs > 0) return;
    entry.store.stop();
    stores.delete(store.workspaceId);
  }, RELEASE_MS);
};

/** The store of a workspace that is open right now, if any. */
export const peekWorkspaceStore = (workspaceId: string): WorkspaceStore | undefined =>
  stores.get(workspaceId)?.store;

export const openWorkspaceStores = (): WorkspaceStore[] => [...stores.values()].map((e) => e.store);
