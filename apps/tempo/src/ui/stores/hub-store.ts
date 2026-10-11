import type { WorkspaceSummary } from "@tempo/protocol";
import { ReconnectingSocket, wsUrl, type SocketLike, type SocketStatus } from "~/ui/lib/socket";
import { connectionMonitor } from "./connection";
import {
  applyHubMessage,
  emptyHubState,
  mergeSummary,
  notifyEvents,
  type HubState,
  type NotifyEvent,
} from "./hub-state";
import { parseHubMessage } from "./parse";

export interface HubSnapshot extends HubState {
  readonly status: SocketStatus;
}

/** The one hub store of the app, fed by /api/ws/hub. It feeds the sidebar and notifications. */
export class HubStore {
  private snapshot: HubSnapshot = { ...emptyHubState, status: "connecting" };
  private listeners = new Set<() => void>();
  private notifyListeners = new Set<(e: NotifyEvent) => void>();
  private socket: ReconnectingSocket;
  private started = false;

  constructor(factory?: (url: string) => SocketLike) {
    this.socket = new ReconnectingSocket({
      url: () => wsUrl("/api/ws/hub"),
      onMessage: (raw) => this.receive(raw),
      onStatus: (status) => {
        connectionMonitor.report("hub", status);
        this.set({ ...this.snapshot, status });
      },
      ...(factory ? { factory } : {}),
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    connectionMonitor.report("hub", "connecting");
    this.socket.start();
  }

  stop(): void {
    this.started = false;
    this.socket.stop();
    connectionMonitor.remove("hub");
  }

  reconnectNow(): void {
    this.socket.reconnectNow();
  }

  getSnapshot = (): HubSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onNotify(listener: (e: NotifyEvent) => void): () => void {
    this.notifyListeners.add(listener);
    return () => {
      this.notifyListeners.delete(listener);
    };
  }

  receive(raw: string): void {
    const msg = parseHubMessage(raw);
    if (!msg) return;
    const next = applyHubMessage(this.snapshot, msg);
    if (next === this.snapshot) return;
    const events = notifyEvents(this.snapshot, next);
    this.set({ ...next, status: this.snapshot.status });
    for (const e of events) for (const l of this.notifyListeners) l(e);
  }

  /** Applies a summary returned by a server function (for example createWorkspace). */
  merge(summary: WorkspaceSummary): void {
    const next = mergeSummary(this.snapshot, summary);
    if (next !== this.snapshot) this.set({ ...next, status: this.snapshot.status });
  }

  private set(next: HubSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

let hub: HubStore | null = null;

export const getHubStore = (): HubStore => {
  hub ??= new HubStore();
  return hub;
};
