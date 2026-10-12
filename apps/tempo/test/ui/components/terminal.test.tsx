import { act, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalView } from "../../../src/ui/components/processes/TerminalView";

const terminal = vi.hoisted(() => ({ focus: vi.fn(), dispose: vi.fn(), reset: vi.fn(), write: vi.fn() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    focus = terminal.focus;
    dispose = terminal.dispose;
    reset = terminal.reset;
    write = terminal.write;
    loadAddon() {}
    open() {}
    onData() {}
    onBinary() {}
    onResize() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("~/ui/hooks/useTheme", () => ({ useTheme: () => ({ resolved: "light" }) }));
const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) {
    sockets.push(this);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  sockets.length = 0;
});

it("focuses the asynchronously loaded terminal and reconnects online to the same session", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const view = render(
    createElement(TerminalView, { workspaceId: "w1", terminalId: "t1", active: true, focusSeq: 1 }),
  );
  await waitFor(() => expect(sockets).toHaveLength(1));
  expect(terminal.focus).toHaveBeenCalledTimes(1);
  act(() => sockets[0]!.onmessage?.({ data: '{"type":"ready"}' }));
  expect(sockets[0]!.send).toHaveBeenCalledWith('{"type":"resize","cols":80,"rows":24}');
  act(() => window.dispatchEvent(new Event("online")));
  expect(sockets).toHaveLength(2);
  expect(sockets[1]!.url).toBe(sockets[0]!.url);
  expect(sockets[0]!.close).toHaveBeenCalled();
  act(() => sockets[1]!.onmessage?.({ data: '{"type":"ready"}' }));
  expect(terminal.reset).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(terminal.dispose).toHaveBeenCalledTimes(1);
});

it("does not resurrect a replaced terminal on an online event", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  render(createElement(TerminalView, { workspaceId: "w1", terminalId: "t1", active: true, focusSeq: 0 }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  act(() => sockets[0]!.onclose?.({ code: 4001 }));
  expect(screen.getByRole("status").textContent).toContain("somewhere else");
  act(() => window.dispatchEvent(new Event("online")));
  expect(sockets).toHaveLength(1);
});
