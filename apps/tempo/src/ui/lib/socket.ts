import { CloseCode, reconnectDelay } from "@tempo/protocol";

/**
 * A WebSocket that follows the channel rules in 02: ping every 30 s, reconnect after 0.5 s
 * doubling to 10 s with 20% jitter, and never reconnect after 4001 (replaced), 4400 (bad protocol
 * version) or 4404 (not found). 4008 (too much buffered) reconnects; the URL is rebuilt on each
 * attempt so the workspace channel can send its highest sinceRev.
 */

export type SocketStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "replaced"
  | "bad_version"
  | "not_found"
  | "stopped";

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const PING_MS = 30_000;
const OPEN = 1;

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export interface ReconnectingSocketOptions {
  readonly url: () => string;
  readonly onMessage: (data: string) => void;
  readonly onStatus?: (status: SocketStatus) => void;
  /** Called on each open, before any message. */
  readonly onOpen?: () => void;
  readonly factory?: (url: string) => SocketLike;
  readonly timers?: Timers;
  readonly random?: () => number;
}

export const wsUrl = (path: string): string => {
  const loc = globalThis.location;
  const proto = loc?.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc?.host ?? "localhost"}${path}`;
};

export class ReconnectingSocket {
  private ws: SocketLike | null = null;
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private stopped = false;
  private gotMessage = false;
  private _status: SocketStatus = "connecting";
  private readonly timers: Timers;
  private readonly factory: (url: string) => SocketLike;

  constructor(private readonly opts: ReconnectingSocketOptions) {
    this.timers = opts.timers ?? defaultTimers;
    this.factory = opts.factory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  get status(): SocketStatus {
    return this._status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(1000, "closed");
      } catch {
        // Already closed.
      }
    }
    this.setStatus("stopped");
  }

  /** Reconnect at once (for example when the browser comes back online). */
  reconnectNow(): void {
    if (this.stopped || this._status === "open" || this.isTerminal()) return;
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  send(data: string): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(data);
    return true;
  }

  private isTerminal(): boolean {
    return this._status === "replaced" || this._status === "bad_version" || this._status === "not_found";
  }

  private setStatus(s: SocketStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.opts.onStatus?.(s);
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 && this._status !== "reconnecting" ? "connecting" : "reconnecting");
    let ws: SocketLike;
    try {
      ws = this.factory(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.gotMessage = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.setStatus("open");
      this.opts.onOpen?.();
      if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
      this.pingTimer = this.timers.setInterval(() => this.send(JSON.stringify({ type: "ping" })), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (!this.gotMessage) {
        this.gotMessage = true;
        this.attempt = 0;
      }
      if (typeof ev.data === "string") this.opts.onMessage(ev.data);
    };
    ws.onerror = () => {
      // onclose follows.
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      if (ev.code === CloseCode.replaced) return this.setStatus("replaced");
      if (ev.code === CloseCode.badProtocolVersion) return this.setStatus("bad_version");
      if (ev.code === CloseCode.workspaceNotFound) return this.setStatus("not_found");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    const delay = reconnectDelay(this.attempt, this.opts.random);
    this.attempt++;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
