import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Diagnostics } from "@tempo/protocol";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsDialog } from "../../../src/ui/components/dialogs/DiagnosticsDialog";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";
import { call } from "../../../src/ui/lib/api";

vi.mock("~/ui/lib/api", () => ({ call: vi.fn() }));
vi.mock("~/ui/hooks/useWorkspaceUi", () => ({
  useDialog: () => ({ open: true, args: { kind: "diagnostics", workspaceId: "w1" }, onOpenChange: () => {} }),
}));

const diagnostics = (egress: Diagnostics["egress"]): Diagnostics => ({
  ops: [],
  container: {
    state: "ready",
    running: true,
    instance: "standard-3",
    imageRef: null,
    snapshots: [],
    tempodVersion: null,
    incarnation: null,
  },
  logs: [],
  egress,
  sessions: [],
});

const row = (host: string): Diagnostics["egress"][number] => ({
  ts: 1,
  method: "GET",
  host,
  path: "/",
  status: 200,
  ms: 1,
  rule: 3,
});

describe("Diagnostics egress filters (05, Observability)", () => {
  it("sends the host filter to getDiagnostics after 250 ms and shows the server's rows", async () => {
    vi.mocked(call).mockImplementation(async (name, input) => {
      if (name !== "getDiagnostics") throw new Error(`unexpected ${name}`);
      const host = (input as { egressHost?: string }).egressHost;
      return diagnostics(host ? [row("api.github.com")] : [row("a.example"), row("b.example")]) as never;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(DiagnosticsDialog)),
      ),
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith("getDiagnostics", { workspaceId: "w1" }));
    const tab = await screen.findByRole("tab", { name: "Egress" });
    fireEvent.mouseDown(tab, { button: 0 });
    expect(await screen.findByText("2 shown")).toBeTruthy();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.change(screen.getByLabelText("Filter by host"), { target: { value: " GitHub " } });
      await act(async () => vi.advanceTimersByTime(100));
      expect(vi.mocked(call).mock.calls.filter(([name]) => name === "getDiagnostics")).toHaveLength(1);
      expect(screen.getByText("2 shown")).toBeTruthy();
      await act(async () => vi.advanceTimersByTime(200));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith("getDiagnostics", { workspaceId: "w1", egressHost: "GitHub" }),
    );
    expect(await screen.findByText("1 shown")).toBeTruthy();
    expect((screen.getByLabelText("Filter by host") as HTMLInputElement).value).toBe(" GitHub ");
  });
});
