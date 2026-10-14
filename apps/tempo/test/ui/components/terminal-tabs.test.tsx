import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BottomPanel } from "../../../src/ui/components/processes/BottomPanel";
import { TerminalTab } from "../../../src/ui/components/processes/TerminalTab";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";

const listed = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("~/ui/hooks/useCall", () => ({
  useCallQuery: () => ({ data: listed.ids.map((terminalId) => ({ terminalId })), isSuccess: true }),
  useCallMutation: () => ({ isPending: false }),
}));
vi.mock("~/ui/hooks/useWorkspace", () => ({ useWorkspaceSelector: () => "ready" }));
vi.mock("~/ui/hooks/useWorkspaceUi", () => ({ useWorkspaceUiSelector: () => "terminal" }));
vi.mock("~/ui/hooks/useMediaQuery", () => ({ useIsPhone: () => false }));
vi.mock("~/ui/components/processes/useScripts", () => ({ useToggleRunAction: () => {} }));
vi.mock("~/ui/components/processes/RunTab", () => ({ RunTab: () => null }));
vi.mock("~/ui/components/processes/SetupTab", () => ({ SetupTab: () => null }));
vi.mock("~/ui/components/processes/TerminalView", () => ({
  TerminalView: ({ terminalId, active }: { terminalId: string; active: boolean }) =>
    createElement("div", { "data-testid": terminalId, "data-active": active }),
}));
beforeEach(() => {
  listed.ids = [];
});

describe("terminal tab lifecycle", () => {
  it("keeps an opened shell when the server's terminal list refreshes", () => {
    const view = render(createElement(TerminalTab, { workspaceId: "w1", visible: true }), {
      wrapper: TooltipProvider,
    });
    expect(screen.getByTestId("t1").getAttribute("data-active")).toBe("true");
    listed.ids = ["t3"];
    view.rerender(createElement(TerminalTab, { workspaceId: "w1", visible: true }));
    expect(screen.getByRole("tab", { name: "t1" })).toBeDefined();
    expect(screen.getByTestId("t1").getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("tab", { name: "t3" })).toBeDefined();
    expect(screen.queryByTestId("t3")).toBeNull();
  });

  it("opens the next free terminal and keeps visited shells mounted when switching tabs", () => {
    render(createElement(TerminalTab, { workspaceId: "w1", visible: true }), { wrapper: TooltipProvider });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(screen.getByTestId("t2").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("t1").getAttribute("data-active")).toBe("false");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "t1" }), { button: 0, ctrlKey: false });
    expect(screen.getByTestId("t1").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("t2").getAttribute("data-active")).toBe("false");
  });

  it("resets local terminal tabs when switching workspaces", () => {
    const view = render(createElement(BottomPanel, { workspaceId: "w1" }), { wrapper: TooltipProvider });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(screen.getByTestId("t2").getAttribute("data-active")).toBe("true");
    view.rerender(createElement(BottomPanel, { workspaceId: "w2" }));
    expect(screen.queryByRole("tab", { name: "t2" })).toBeNull();
    expect(screen.getByTestId("t1").getAttribute("data-active")).toBe("true");
  });
});
