import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

call.mockImplementation(async (name) =>
  name === "getCredentialStatus"
    ? {
        claude: { set: false, updatedAt: null },
        codex: { set: false, updatedAt: null, lastRefresh: null },
        anthropic: { set: false, updatedAt: null },
        openai: { set: false, updatedAt: null },
        openrouter: { set: false, updatedAt: null },
      }
    : name === "listModels" || name === "listEnvironments"
      ? []
      : { names: [] },
);

import { elementOf } from "../elements.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsPage } from "../../../src/ui/components/settings/SettingsPage";

import { dialogStore, openDialog, resetUiState, settingsStore } from "../../../src/ui/state/workspace-ui";

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
    { wrapper: environment.Provider },
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

    expect(labels.slice(0, 8)).toEqual([
      "General",
      "Logins",
      "Agents",
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
  it("shows the Tempo and Mac keys on Shortcuts", () => {
    openDialog({ kind: "settings", tab: "shortcuts" });
    show();
    const table = screen.getByRole("table", { name: "Keyboard shortcuts" });
    expect(within(table).getByRole("columnheader", { name: "Tempo" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Mac" })).toBeTruthy();
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
      "Agents",
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
    expect(screen.getByRole("combobox", { name: "Default model" })).toBeTruthy();

    for (const agent of ["Claude", "Codex", "OpenCode", "Pi"])
      expect(screen.queryByRole("group", { name: `${agent} default model` })).toBeNull();
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
    const input = elementOf(screen.getByRole("textbox", { name: "Branch prefix" }), HTMLInputElement);
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
    fireEvent.change(screen.getByLabelText("Sleep after idle (minutes)", { selector: "input" }), {
      target: { value: "1" },
    });
    fireEvent.click(within(nav).getByRole("button", { name: "Git" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(screen.getByRole("heading", { name: "Environment" })).toBeTruthy();
    expect(
      screen.getByLabelText("Sleep after idle (minutes)", { selector: "input" }).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(call).not.toHaveBeenCalledWith("updateProjectSettings", expect.anything());
  });
});
