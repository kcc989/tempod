import type { SocketStatus } from "~/ui/lib/socket";
import { Store } from "~/ui/lib/store";

/** 04: a thin `Reconnecting…` bar shows while any live socket has been down for over 2 s. */
export const DOWN_MS = 2_000;

interface ConnState {
  readonly reconnecting: boolean;
}

class ConnectionMonitor extends Store<ConnState> {
  private down = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super({ reconnecting: false });
  }

  report(key: string, status: SocketStatus): void {
    const isDown = status === "connecting" || status === "reconnecting";
    if (isDown && !this.down.has(key)) this.down.set(key, Date.now());
    if (!isDown) this.down.delete(key);
    this.recompute();
  }

  remove(key: string): void {
    this.down.delete(key);
    this.recompute();
  }

  private recompute(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    let earliest = Infinity;
    for (const since of this.down.values()) earliest = Math.min(earliest, since);
    const reconnecting = earliest !== Infinity && now - earliest >= DOWN_MS;
    if (reconnecting !== this.getSnapshot().reconnecting) this.set({ reconnecting });
    if (!reconnecting && earliest !== Infinity) {
      this.timer = setTimeout(() => this.recompute(), DOWN_MS - (now - earliest) + 10);
    }
  }
}

export const connectionMonitor = new ConnectionMonitor();
