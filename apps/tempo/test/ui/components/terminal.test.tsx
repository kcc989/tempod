import { act, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView } from "../../../src/ui/components/processes/TerminalView";

const harness = vi.hoisted(() => ({
  terminals: [] as Array<any>,
  sockets: [] as Array<any>,
  dimensions: { cols: 76, rows: 32 },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: any;
    textarea = document.createElement("textarea");
    data: ((value: string) => void) | undefined;
    binary: ((value: string) => void) | undefined;
    resized: ((size: { cols: number; rows: number }) => void) | undefined;
    write = vi.fn();
    dispose = vi.fn();
    constructor(options: any) {
      this.options = options;
      harness.terminals.push(this);
    }
    open(host: HTMLElement) {
      host.appendChild(this.textarea);
    }
    loadAddon() {}
    focus() {
      this.textarea.focus();
    }
    onData(callback: (value: string) => void) {
      this.data = callback;
    }
    onBinary(callback: (value: string) => void) {
      this.binary = callback;
    }
    onResize(callback: (size: { cols: number; rows: number }) => void) {
      this.resized = callback;
    }
    resize(cols: number, rows: number) {
      if (this.cols === cols && this.rows === rows) return;
      this.cols = cols;
      this.rows = rows;
      this.resized?.({ cols, rows });
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return harness.dimensions;
    }
  },
}));
vi.mock("~/ui/components/processes/terminal-theme", () => ({
  terminalFont: () => "monospace",
  terminalTheme: () => ({}),
}));

class Socket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) {
    harness.sockets.push(this);
  }
  ready() {
    this.onmessage?.({ data: '{"type":"ready"}' });
  }
  disconnect(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

let width = 540;
let height = 460;
let frames: FrameRequestCallback[];
let resized: ResizeObserverCallback;
const fit = () =>
  act(() => {
    const pending = frames.splice(0);
    pending.forEach((fn) => fn(0));
  });
const props = { workspaceId: "w1", terminalId: "t1" as const, active: true, focusSeq: 0 };
const loaded = async () => {
  await waitFor(() => expect(harness.terminals).toHaveLength(1));
  fit();
};

beforeEach(() => {
  harness.terminals.length = 0;
  harness.sockets.length = 0;
  harness.dimensions = { cols: 76, rows: 32 };
  width = 540;
  height = 460;
  frames = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sidebar terminal", () => {
  it("focuses after asynchronous loading and sends ls and Enter as binary input after ready", async () => {
    render(createElement(TerminalView, props));
    await loaded();
    const terminal = harness.terminals[0];
    const socket = harness.sockets[0];
    expect(socket.url).toContain("cols=76&rows=32");
    expect(terminal.options.disableStdin).toBe(true);
    terminal.data("too early");
    expect(socket.send).not.toHaveBeenCalled();
    act(() => socket.ready());
    expect(terminal.options.disableStdin).toBe(false);
    expect(document.activeElement).toBe(terminal.textarea);
    terminal.data("ls\r");
    expect(socket.send).toHaveBeenLastCalledWith(new TextEncoder().encode("ls\r"));
    terminal.binary("\x1b[Mÿ");
    expect(socket.send).toHaveBeenLastCalledWith(new Uint8Array([27, 91, 77, 255]));
  });

  it("waits for a visible measurable host, then refits and focuses when shown", async () => {
    width = height = 0;
    const view = render(createElement(TerminalView, { ...props, active: false }));
    await loaded();
    expect(harness.sockets).toHaveLength(0);
    width = 540;
    height = 460;
    view.rerender(createElement(TerminalView, { ...props, focusSeq: 1 }));
    fit();
    act(() => harness.sockets[0].ready());
    expect(document.activeElement).toBe(harness.terminals[0].textarea);
    view.rerender(createElement(TerminalView, { ...props, active: false }));
    harness.dimensions = { cols: 50, rows: 20 };
    view.rerender(createElement(TerminalView, props));
    fit();
    expect(harness.terminals[0].cols).toBe(50);
    expect(harness.terminals[0].rows).toBe(20);
    expect(harness.sockets).toHaveLength(1);
  });

  it("uses the same clamped grid locally and remotely when resized", async () => {
    render(createElement(TerminalView, props));
    await loaded();
    act(() => harness.sockets[0].ready());
    vi.useFakeTimers();
    harness.dimensions = { cols: 800, rows: 300 };
    resized([], {} as ResizeObserver);
    fit();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect([harness.terminals[0].cols, harness.terminals[0].rows]).toEqual([500, 200]);
    expect(JSON.parse(harness.sockets[0].send.mock.lastCall[0])).toEqual({
      type: "resize",
      cols: 500,
      rows: 200,
    });
  });

  it("disables input on disconnect and restores focus and the latest size on reconnect", async () => {
    render(createElement(TerminalView, props));
    await loaded();
    const terminal = harness.terminals[0];
    const socket = harness.sockets[0];
    act(() => socket.ready());
    vi.useFakeTimers();
    act(() => socket.disconnect(1006));
    expect(terminal.options.disableStdin).toBe(true);
    harness.dimensions = { cols: 60, rows: 25 };
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sockets[1].url).toContain("cols=60&rows=25");
    act(() => harness.sockets[1].ready());
    expect(terminal.write).toHaveBeenCalledWith("\x1bc");
    expect(terminal.options.disableStdin).toBe(false);
    expect(document.activeElement).toBe(terminal.textarea);
    const count = harness.sockets[1].send.mock.calls.length;
    act(() => harness.sockets[1].ready());
    expect(harness.sockets[1].send).toHaveBeenCalledTimes(count);
  });

  it("disposes the socket and xterm when the panel closes", async () => {
    const view = render(createElement(TerminalView, props));
    await loaded();
    act(() => harness.sockets[0].ready());
    view.unmount();
    expect(harness.sockets[0].close).toHaveBeenCalledWith(1000, "closed");
    expect(harness.sockets[0].onmessage).toBeNull();
    expect(harness.terminals[0].dispose).toHaveBeenCalledOnce();
  });
});
