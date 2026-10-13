import { openDialog, resetUiState } from "../../../src/ui/state/workspace-ui";
import { createUiEnvironment, requestInput } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { elementOf } from "../elements.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Diagnostics } from "@tempo/protocol";
import { createElement } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsDialog } from "../../../src/ui/components/dialogs/DiagnosticsDialog";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";

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

beforeEach(() => openDialog({ kind: "diagnostics", workspaceId: "w1" }));

afterEach(resetUiState);

describe("Diagnostics egress filters (05, Observability)", () => {
  it("sends the host filter to getDiagnostics after 250 ms and shows the server's rows", async () => {
    vi.mocked(call).mockImplementation(async (name, input) => {
      if (name !== "getDiagnostics") throw new Error(`unexpected ${name}`);
      const host = requestInput("getDiagnostics", input).egressHost;

      return diagnostics(host ? [row("api.github.com")] : [row("a.example"), row("b.example")]);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(DiagnosticsDialog)),
      ),
      { wrapper: environment.Provider },
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith("getDiagnostics", { workspaceId: "w1" }));
    const tab = await screen.findByRole("tab", { name: "Egress" });
    fireEvent.mouseDown(tab, { button: 0 });
    expect(await screen.findByText("2 shown")).toBeTruthy();

    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      fireEvent.change(screen.getByLabelText("Filter by host"), { target: { value: " GitHub " } });
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(vi.mocked(call).mock.calls.filter(([name]) => name === "getDiagnostics")).toHaveLength(1);
      expect(screen.getByText("2 shown")).toBeTruthy();
      await act(async () => vi.advanceTimersByTimeAsync(200));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith("getDiagnostics", { workspaceId: "w1", egressHost: "GitHub" }),
    );
    expect(await screen.findByText("1 shown")).toBeTruthy();
    expect(elementOf(screen.getByLabelText("Filter by host"), HTMLInputElement).value).toBe(" GitHub ");
  });
});
