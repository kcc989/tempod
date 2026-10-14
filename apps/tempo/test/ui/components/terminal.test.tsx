import { act, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { ITerminalOptions } from "@xterm/xterm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  TerminalView,
  TerminalRuntimeContext,
  type OpenTerminal,
  type TerminalSurface,
} from "../../../src/ui/components/processes/TerminalView";

const sockets: FakeSocket[] = [];

let width = 540;

let height = 460;

let resizeObserved: ResizeObserverCallback;

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) {
    sockets.push(this);
  }
  ready() {
    this.onmessage?.({ data: '{"type":"ready"}' });
  }
}

function fixture() {
  const options: ITerminalOptions = {};
  const textarea = document.createElement("textarea");
  let keys = (_value: string) => {};

  let resized = (_value: { cols: number; rows: number }) => {};

  const terminal = {
    cols: 80,
    rows: 24,
    options,
    focus() {
      textarea.focus();
    },
    dispose: vi.fn(),
    reset: vi.fn(),
    write: vi.fn(),
    onData(listener: (value: string) => void) {
      keys = listener;
    },
    onBinary() {},
    onResize(listener: Parameters<TerminalSurface["onResize"]>[0]) {
      resized = listener;
    },
  } satisfies TerminalSurface;

  let dimensions = { cols: 76, rows: 32 };
  let finishLoading = () => {};

  const loaded = new Promise<void>((resolve) => {
    finishLoading = resolve;
  });

  const open: OpenTerminal = async (host) => {
    await loaded;
    host.appendChild(textarea);

    return {
      terminal,
      fit() {
        if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) {
          terminal.cols = dimensions.cols;
          terminal.rows = dimensions.rows;
          resized(dimensions);
        }

        return true;
      },
    };
  };

  const element = (active = true) =>
    createElement(
      TerminalRuntimeContext.Provider,
      { value: open },
      createElement(TerminalView, { workspaceId: "w1", terminalId: "t1", active, focusSeq: 0 }),
    );

  return {
    terminal,
    textarea,
    element,
    load: finishLoading,
    keys: (value: string) => keys(value),
    resize: (cols: number, rows: number) => {
      dimensions = { cols, rows };
    },
  };
}

beforeEach(() => {
  width = 540;
  height = 460;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserved = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sockets.length = 0;
});

it("focuses after asynchronous loading and sends ls plus Enter only after ready", async () => {
  const f = fixture();
  render(f.element());
  f.load();
  await waitFor(() => expect(sockets).toHaveLength(1));
  f.keys("too early");
  expect(sockets[0]!.send).not.toHaveBeenCalled();
  act(() => sockets[0]!.ready());
  await waitFor(() => expect(document.activeElement).toBe(f.textarea));
  f.keys("ls\r");
  expect(sockets[0]!.send).toHaveBeenLastCalledWith(new TextEncoder().encode("ls\r"));
});

it("reconnects online to the same session with the latest dimensions and resets before redraw", async () => {
  const f = fixture();
  const view = render(f.element());
  f.load();
  await waitFor(() => expect(sockets).toHaveLength(1));
  act(() => sockets[0]!.ready());
  f.resize(60, 25);
  act(() => window.dispatchEvent(new Event("online")));
  expect(sockets).toHaveLength(2);
  expect(sockets[1]!.url).toContain("/w1/t1?cols=60&rows=25");
  act(() => sockets[1]!.ready());
  expect(f.terminal.write).toHaveBeenCalledWith(new Uint8Array([27, 99]));
  await waitFor(() => expect(document.activeElement).toBe(f.textarea));
  view.unmount();
  expect(f.terminal.dispose).toHaveBeenCalledOnce();
  expect(sockets[1]!.close).toHaveBeenCalledWith(1000, "closed");
});

it("does not resurrect a replaced terminal on an online event", async () => {
  const f = fixture();
  render(f.element());
  f.load();
  await waitFor(() => expect(sockets).toHaveLength(1));
  act(() => sockets[0]!.onclose?.({ code: 4001 }));
  expect(screen.getByRole("status").textContent).toContain("somewhere else");
  act(() => window.dispatchEvent(new Event("online")));
  expect(sockets).toHaveLength(1);
});

it("waits for a measurable visible terminal and resizes the established connection", async () => {
  width = height = 0;
  const f = fixture();
  const view = render(f.element(false));
  f.load();
  await waitFor(() => expect(screen.getByLabelText("Terminal t1").contains(f.textarea)).toBe(true));
  expect(sockets).toHaveLength(0);
  width = 540;
  height = 460;
  view.rerender(f.element());
  await waitFor(() => expect(sockets).toHaveLength(1));
  act(() => sockets[0]!.ready());
  await waitFor(() => expect(document.activeElement).toBe(f.textarea));
  f.resize(50, 20);
  act(() => resizeObserved([], new ResizeObserver(() => {})));
  await waitFor(() =>
    expect(sockets[0]!.send).toHaveBeenLastCalledWith('{"type":"resize","cols":50,"rows":20}'),
  );
  expect(sockets).toHaveLength(1);
});
