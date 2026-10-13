import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingSocket, type SocketLike, type SocketStatus } from "~/ui/lib/socket";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed: number | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  message(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  serverClose(code: number) {
    this.readyState = 3;
    // SAFETY: this callback reads only code; the test supplies that CloseEvent field.
    this.onclose?.({ code } as CloseEvent);
  }
}

describe("ReconnectingSocket", () => {
  let sockets: FakeSocket[];
  let statuses: SocketStatus[];
  let messages: string[];
  let rev: number;

  const make = () =>
    new ReconnectingSocket({
      url: () => `ws://x/api/ws/workspace/w?sinceRev=${rev}`,
      onMessage: (m) => messages.push(m),
      onStatus: (s) => statuses.push(s),
      factory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);

        return s;
      },
      random: () => 0.5,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    statuses = [];
    messages = [];
    rev = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("pings every 30 s while open", () => {
    const s = make();
    s.start();
    sockets[0]!.open();
    vi.advanceTimersByTime(30_000);
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: "ping" })]);
    vi.advanceTimersByTime(30_000);
    expect(sockets[0]!.sent).toHaveLength(2);
  });

  it("reconnects with backoff from 0.5 s doubling to 10 s, with the current sinceRev", () => {
    const s = make();
    s.start();
    const delays: number[] = [];

    for (let i = 0; i < 7; i++) {
      const before = sockets.length;
      sockets[sockets.length - 1]!.serverClose(1006);
      let waited = 0;

      while (sockets.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }

      delays.push(waited);
    }

    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect(statuses).toContain("reconnecting");
    rev = 42;
    sockets[sockets.length - 1]!.serverClose(4008);
    vi.advanceTimersByTime(10_000);
    expect(sockets[sockets.length - 1]!.url).toBe("ws://x/api/ws/workspace/w?sinceRev=42");
  });

  it("resets the backoff once a message arrives", () => {
    const s = make();
    s.start();
    sockets[0]!.serverClose(1006);
    vi.advanceTimersByTime(500);
    sockets[1]!.serverClose(1006);
    vi.advanceTimersByTime(1000);
    sockets[2]!.open();
    sockets[2]!.message('{"type":"hello"}');
    sockets[2]!.serverClose(1006);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
    expect(messages).toEqual(['{"type":"hello"}']);
  });

  it.each([
    [4001, "replaced"],
    [4400, "bad_version"],
    [4404, "not_found"],
  ] as const)("does not reconnect after close code %i", (code, status) => {
    const s = make();
    s.start();
    sockets[0]!.open();
    sockets[0]!.serverClose(code);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(s.status).toBe(status);
  });

  it("rejectVersion closes with 4400 and never reconnects", () => {
    const sock = make();
    sock.start();
    sockets[0]!.open();
    sock.rejectVersion();
    expect(sockets[0]!.closed).toBe(4400);
    expect(sock.status).toBe("bad_version");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("stop closes the socket and cancels retries", () => {
    const s = make();
    s.start();
    sockets[0]!.serverClose(1006);
    s.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(s.status).toBe("stopped");
  });
});

describe("isUnknownVersionHello", () => {
  it("flags only a hello whose v is not 1", async () => {
    const { isUnknownVersionHello } = await import("~/ui/stores/parse");
    expect(isUnknownVersionHello(JSON.stringify({ type: "hello", v: 2, workspaces: [] }))).toBe(true);
    expect(isUnknownVersionHello(JSON.stringify({ type: "hello", v: 1, workspaces: [] }))).toBe(false);
    expect(isUnknownVersionHello(JSON.stringify({ type: "pong" }))).toBe(false);
    expect(isUnknownVersionHello("not json")).toBe(false);
  });
});
