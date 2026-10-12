import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../../src/ui/components/settings/SettingsPage";
import { call } from "../../../src/ui/lib/api";
import { dialogStore, openDialog, resetUiState, settingsStore } from "../../../src/ui/state/workspace-ui";

vi.mock("~/ui/lib/api", () => ({
  call: vi.fn(async (name: string) => (name === "listEnvironments" ? [] : { names: [] })),
}));
vi.mock("~/ui/components/dialogs/settings/useOpenWorkspace", () => ({ useOpenWorkspaceDetail: () => null }));
const projects = [
  { id: "p1", owner: "tempo", name: "first", settings: {}, sortOrder: 0 },
  { id: "p2", owner: "tempo", name: "second", settings: {}, sortOrder: 1 },
];
const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["call", "listProjects", {}], projects);
  return render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
};
afterEach(resetUiState);

describe("settings page", () => {
  it("opens General without a modal and returns with Back or Escape", () => {
    openDialog({ kind: "settings" });
    show();
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(settingsStore.getSnapshot()).toBeNull();
    openDialog({ kind: "settings" });
    fireEvent.keyDown(screen.getByRole("main"), { code: "Escape" });
    expect(settingsStore.getSnapshot()).toBeNull();
  });
  it("lists Environments after Logins in Personal", () => {
    openDialog({ kind: "settings" });
    show();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    const labels = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels.slice(0, 7)).toEqual([
      "General",
      "Logins",
      "Environments",
      "MCP servers",
      "Appearance",
      "Shortcuts",
      "Devices",
    ]);
    fireEvent.click(within(nav).getByRole("button", { name: "Environments" }));
    expect(screen.getByRole("heading", { name: "Environments" })).toBeTruthy();
  });
  it("filters navigation and focuses search with the find shortcut", () => {
    openDialog({ kind: "settings" });
    show();
    fireEvent.keyDown(screen.getByRole("main"), { code: "KeyF", ctrlKey: true });
    const search = screen.getByRole("textbox", { name: "Search settings" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "appearance" } });
    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Logins" })).toBeNull();
  });
  it("shows the Tempo and Conductor keys on Shortcuts", () => {
    openDialog({ kind: "settings", tab: "shortcuts" });
    show();
    const table = screen.getByRole("table", { name: "Keyboard shortcuts" });
    expect(within(table).getByRole("columnheader", { name: "Tempo" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Conductor" })).toBeTruthy();
    expect(within(table).getByRole("row", { name: /^Settings/ }).textContent).toContain("⌘,");
  });
  it("shows a default model per agent and Browser Run on Agents", () => {
    openDialog({ kind: "settings", tab: "project", projectId: "p1" });
    show();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "General",
      "Logins",
      "Environments",
      "MCP servers",
      "Appearance",
      "Shortcuts",
      "Devices",
      "tempo/first",
      "Agents",
      "Scripts",
      "Environment",
      "Git",
      "Prompts",
      "Secrets",
      "General",
      "tempo/second",
    ]);
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    for (const agent of ["Claude", "Codex", "OpenCode", "Pi"])
      expect(screen.getByRole("group", { name: `${agent} default model` })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Browser Run" })).toBeTruthy();
    fireEvent.click(within(nav).getByRole("button", { name: "Scripts" }));
    expect(screen.queryByRole("group", { name: "Browser Run" })).toBeNull();
  });
  it("keeps settings open when another dialog opens", () => {
    openDialog({ kind: "settings", tab: "project", projectId: "p2" });
    openDialog({ kind: "addProject" });
    expect(settingsStore.getSnapshot()?.projectId).toBe("p2");
    expect(dialogStore.getSnapshot().dialog?.kind).toBe("addProject");
  });
  it("preserves edits across project sections and saves to the selected project", async () => {
    openDialog({ kind: "settings", tab: "project", projectId: "p2" });
    show();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    fireEvent.click(within(nav).getByRole("button", { name: "Git" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Branch prefix" }), {
      target: { value: "custom/" },
    });
    fireEvent.click(within(nav).getByRole("button", { name: "Scripts" }));
    expect(screen.queryByRole("textbox", { name: "Branch prefix" })).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "Git" }));
    const input = screen.getByRole("textbox", { name: "Branch prefix" }) as HTMLInputElement;
    expect(input.value).toBe("custom/");
    fireEvent.keyDown(input, { code: "Enter", metaKey: true });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("updateProjectSettings", {
        projectId: "p2",
        settings: { git: { branch_prefix: "custom/" } },
      }),
    );
  });
  it("reveals the section containing an invalid edited field", () => {
    openDialog({ kind: "settings", tab: "project", projectId: "p1" });
    show();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    fireEvent.click(within(nav).getByRole("button", { name: "Environment" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Sleep after idle (minutes)" }), {
      target: { value: "1" },
    });
    fireEvent.click(within(nav).getByRole("button", { name: "Git" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(screen.getByRole("heading", { name: "Environment" })).toBeTruthy();
    expect(
      screen.getByRole("spinbutton", { name: "Sleep after idle (minutes)" }).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(call).not.toHaveBeenCalledWith("updateProjectSettings", expect.anything());
  });
});
