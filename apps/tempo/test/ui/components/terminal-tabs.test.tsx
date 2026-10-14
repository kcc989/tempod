import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { TerminalTab } from "../../../src/ui/components/processes/TerminalTab";
import { TerminalRuntimeContext, type OpenTerminal } from "../../../src/ui/components/processes/TerminalView";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";
import { ApiCallContext, callKey } from "../../../src/ui/hooks/useCall";
import { WorkspaceStoresContext } from "../../../src/ui/hooks/useWorkspace";
import { createApiClient } from "../../../src/ui/lib/api-client";
import { WorkspaceStore } from "../../../src/ui/stores/workspace-store";
import { detail } from "../fixtures";

const open: OpenTerminal = async () => ({
  terminal: {
    cols: 80,
    rows: 24,
    options: {},
    focus() {},
    dispose() {},
    reset() {},
    write() {},
    onData() {},
    onBinary() {},
    onResize() {},
  },
  fit: () => true,
});

function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const workspace = new WorkspaceStore("w1");
  workspace.receive(
    JSON.stringify({ type: "hello", v: 1, workspace: detail(), sessions: [], turns: [], itemsRev: 0 }),
  );
  const key = callKey("listTerminals", { workspaceId: "w1" });
  client.setQueryData(key, []);

  const api = createApiClient(async () => {
    throw new Error("Unexpected terminal API call");
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      ApiCallContext.Provider,
      { value: api },
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          WorkspaceStoresContext.Provider,
          { value: () => workspace },
          createElement(
            TerminalRuntimeContext.Provider,
            { value: open },
            createElement(TooltipProvider, null, children),
          ),
        ),
      ),
    );

  const view = render(createElement(TerminalTab, { workspaceId: "w1", visible: true }), { wrapper });

  return { client, key, view };
}

describe("terminal tab lifecycle", () => {
  it("keeps an opened shell when the server's terminal list refreshes", async () => {
    const f = fixture();
    expect(screen.getByRole("tab", { name: "t1" }).getAttribute("aria-selected")).toBe("true");
    act(() => f.client.setQueryData(f.key, [{ terminalId: "t3" }]));
    expect(screen.getByRole("tab", { name: "t1" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "t3" }).getAttribute("aria-selected")).toBe("false"),
    );
    expect(screen.queryByLabelText("Terminal t3")).toBeNull();
  });

  it("keeps visited shells mounted when switching terminal tabs", () => {
    fixture();
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(screen.getByRole("tab", { name: "t2" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Terminal t1")).toBeDefined();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "t1" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("tab", { name: "t1" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Terminal t2")).toBeDefined();
  });
});
