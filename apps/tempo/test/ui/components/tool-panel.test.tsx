import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { TerminalRuntimeContext, type OpenTerminal } from "../../../src/ui/components/processes/TerminalView";
import { ToolPanel } from "../../../src/ui/components/shell/ToolPanel";
import { newTerminal, resetUiState, selectTool } from "../../../src/ui/state/workspace-ui";
import { elementOf } from "../elements.ts";
import { detail } from "../fixtures";

const WS = detail().id;

const show = () => render(<ToolPanel workspaceId={WS} />, { wrapper: environment.Provider });

const toolTabs = () =>
  within(screen.getByRole("tablist", { name: "Tool tabs" }))
    .queryAllByRole("tab")
    .map((t) => t.textContent);

const openFromGrid = () => {
  fireEvent.click(screen.getByRole("button", { name: "New tool tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
};

beforeEach(() => {
  resetUiState();
  environment.setState({ workspace: detail({ state: "sleeping" }) });
});

it("opens each terminal from the Tools grid as its own tab, without Changes in the grid", () => {
  show();
  const grid = elementOf(screen.getByRole("heading", { name: "Tools" }).nextElementSibling, HTMLElement);
  expect(
    within(grid)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Terminal", "Run", "Browser", "Guides", "Artifacts", "Activity"]);

  openFromGrid();
  openFromGrid();
  expect(toolTabs()).toEqual(["Terminal 1", "Terminal 2"]);
  expect(screen.getByRole("tab", { name: "Terminal 2" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tablist", { name: "Terminals" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Wake" })).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
  expect(toolTabs()).toEqual(["Terminal 2"]);
  openFromGrid();
  expect(toolTabs()).toEqual(["Terminal 2", "Terminal 1"]);
  expect(screen.getByRole("tab", { name: "Terminal 1" }).getAttribute("aria-selected")).toBe("true");
});

it("disables the grid's Terminal row while nine terminal tabs are open", async () => {
  for (let i = 0; i < 8; i++) newTerminal(WS);
  selectTool(WS, null);
  show();
  expect(screen.getByRole("button", { name: "Terminal" })).toHaveProperty("disabled", false);

  act(() => newTerminal(WS));
  act(() => selectTool(WS, null));
  const row = screen.getByRole("button", { name: "Terminal" });
  expect(row).toHaveProperty("disabled", true);
  act(() => row.parentElement!.focus());
  expect((await screen.findAllByText("Nine terminals are open")).length).toBeGreaterThan(0);
});

const openStub: OpenTerminal = async () => ({
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

it("keeps each opened shell mounted while another terminal tab is selected", () => {
  environment.setState({ workspace: detail({ state: "ready" }) });
  render(
    <TerminalRuntimeContext.Provider value={openStub}>
      <ToolPanel workspaceId={WS} />
    </TerminalRuntimeContext.Provider>,
    { wrapper: environment.Provider },
  );
  openFromGrid();
  openFromGrid();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Terminal 1" }), { button: 0, ctrlKey: false });
  expect(screen.getByRole("tab", { name: "Terminal 1" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Terminal t1")).toBeDefined();
  expect(screen.getByLabelText("Terminal t2")).toBeDefined();
});
