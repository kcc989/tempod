import { Schema } from "effect";
import { API } from "@tempo/protocol";
import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TempoError, type McpServer } from "@tempo/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServersTab } from "../../../src/ui/components/dialogs/settings/McpServersTab";
import { SettingsPage } from "../../../src/ui/components/settings/SettingsPage";

import { dialogStore, openDialog, resetUiState, resolveConfirm } from "../../../src/ui/state/workspace-ui";

const stdio: McpServer = {
  id: "m1",
  name: "everything",
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
  env: [{ name: "LOG_LEVEL", value: "debug" }],
  url: null,
  headers: [],
  createdAt: 1,
  updatedAt: 1,
};

const http: McpServer = {
  id: "m2",
  name: "linear",
  enabled: false,
  transport: "http",
  command: null,
  args: [],
  env: [],
  url: "https://mcp.linear.app/mcp",
  headers: [
    { name: "Authorization", secret: true, value: null, set: true },
    { name: "X-Team", secret: false, value: "eng" },
  ],
  createdAt: 1,
  updatedAt: 1,
};

const show = (servers: ReadonlyArray<McpServer> = [stdio, http]) => {
  vi.mocked(call).mockImplementation(async (name) => {
    if (name === "listMcpServers") return servers;

    if (name === "saveMcpServer") return stdio;

    return {};
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <McpServersTab />
    </QueryClientProvider>,
    { wrapper: environment.Provider },
  );
};

const saved = () => vi.mocked(call).mock.calls.filter(([n]) => n === "saveMcpServer");

afterEach(resetUiState);

describe("MCP servers settings", () => {
  it("is listed under Personal after Environments (04)", () => {
    vi.mocked(call).mockResolvedValue([]);
    openDialog({ kind: "settings", tab: "mcp" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPage />
      </QueryClientProvider>,
      { wrapper: environment.Provider },
    );
    expect(screen.getByRole("heading", { name: "MCP servers" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings" });

    const labels = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);

    expect(labels.indexOf("MCP servers")).toBe(labels.indexOf("Environments") + 1);
  });

  it("lists each server with transport, command or URL and an Enabled switch", async () => {
    show();
    const row = await screen.findByRole("listitem", { name: "everything" });
    expect(row.textContent).toContain("stdio");
    expect(row.textContent).toContain("npx -y @modelcontextprotocol/server-everything");
    const other = screen.getByRole("listitem", { name: "linear" });
    expect(other.textContent).toContain("https://mcp.linear.app/mcp");
    expect(within(other).getByRole("switch", { name: "Enable linear" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByText(/Changes apply to new sessions/)).toBeTruthy();
  });

  it("toggles Enabled without sending stored secret values", async () => {
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Enable linear" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]?.[1]).toEqual({
      id: "m2",
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: [
        { name: "Authorization", secret: true },
        { name: "X-Team", secret: false, value: "eng" },
      ],
    });
  });

  it("adds a stdio server with only stdio fields", async () => {
    show([]);
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "fs" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: " npx " } });
    fireEvent.change(screen.getByLabelText("Arguments"), { target: { value: "-y\n\n@mcp/fs\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Add env var" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Env var 1 name" }), { target: { value: "ROOT" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Env var 1 value" }), { target: { value: "/w" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]?.[1]).toEqual({
      name: "fs",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@mcp/fs"],
      env: [{ name: "ROOT", value: "/w" }],
    });
  });

  it("keeps a stored secret header when its field is left empty and never shows it", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Edit linear" }));

    const secret = screen
      .getByRole("form", { name: "Edit linear" })
      .querySelector<HTMLInputElement>('input[aria-label="Header 1 value"]');

    expect(secret?.type).toBe("password");
    expect(secret?.value).toBe("");
    expect(secret?.placeholder).toContain("leave empty to keep");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    const input = Schema.decodeUnknownSync(API.saveMcpServer.input)(saved()[0]?.[1]);
    expect(input.headers).toEqual([
      { name: "Authorization", secret: true },
      { name: "X-Team", secret: false, value: "eng" },
    ]);
    expect(input.command).toBeUndefined();
  });

  it("shows validation problems before saving and server validation errors after", async () => {
    show([]);
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bad Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("Name uses a to z");
    expect(saved()).toHaveLength(0);

    vi.mocked(call).mockRejectedValueOnce(new TempoError("VALIDATION_FAILED", "That name is taken."));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "fs" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("That name is taken."));
  });

  it("asks before deleting", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete everything" }));
    await waitFor(() => expect(dialogStore.getSnapshot().confirm).not.toBeNull());
    expect(call).not.toHaveBeenCalledWith("deleteMcpServer", expect.anything());
    resolveConfirm(dialogStore.getSnapshot().confirm?.id ?? 0, true);
    await waitFor(() => expect(call).toHaveBeenCalledWith("deleteMcpServer", { id: "m1" }));
  });
});
