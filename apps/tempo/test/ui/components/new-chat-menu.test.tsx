import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS, type CredentialStatus, type Settings } from "@tempo/protocol";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewChatComposer } from "../../../src/ui/components/chat/NewChatComposer";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";

import { emptyWorkspaceState } from "../../../src/ui/stores/workspace-state";
import { detail } from "../fixtures";

const on = { set: true, updatedAt: 1 };

const credentials: CredentialStatus = {
  claude: on,
  codex: { ...on, lastRefresh: 1 },
  openrouter: on,
  anthropic: { set: false, updatedAt: null },
  openai: { set: false, updatedAt: null },
};

const withModels = (models: Partial<Settings["agent"]["models"]>): Settings => ({
  ...DEFAULT_SETTINGS,
  agent: { ...DEFAULT_SETTINGS.agent, models: { ...DEFAULT_SETTINGS.agent.models, ...models } },
});

const show = (settings: Settings, status: CredentialStatus | Promise<CredentialStatus> = credentials) => {
  environment.setState({ ...emptyWorkspaceState, ready: true, workspace: detail({ settings }) });
  vi.mocked(call).mockImplementation(async (name) => {
    if (name === "getCredentialStatus") return status;

    if (name === "listModels")
      return [
        { agent: "claude", currentValue: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }] },
        {
          agent: "codex",
          currentValue: "codex-test",
          options: [{ value: "codex-test", name: "Codex test" }],
        },
        { agent: "pi", currentValue: "pi-test", options: [{ value: "pi-test", name: "Pi test" }] },
      ];

    if (name === "listAgents")
      return [
        {
          id: "a1",
          handle: "reviewer",
          name: "Reviewer",
          description: "",
          baseAgent: "codex",
          access: "read-only",
          outputKind: "review",
          version: 1,
          sha: "a".repeat(64),
          starter: null,
          updatedAt: 1,
        },
        {
          id: "a2",
          handle: "router-tester",
          name: "Router tester",
          description: "",
          baseAgent: "pi",
          access: "read-only",
          outputKind: "note",
          version: 1,
          sha: "a".repeat(64),
          starter: null,
          updatedAt: 1,
        },
      ];
    throw new Error(`unexpected ${name}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        TooltipProvider,
        null,
        createElement(NewChatComposer, {
          workspaceId: "w1",
          open: true,
          onOpenChange: () => undefined,
          onCreated: () => undefined,
        }),
      ),
    ),
    { wrapper: environment.Provider },
  );
};

beforeEach(() => {
  vi.mocked(call).mockReset();
});

describe("New chat model choices (04, Tabs)", () => {
  it("offers discovered models even without a configured OpenRouter model", async () => {
    show(withModels({}));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Sonnet"),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: /Pi test/ })).toBeDefined();
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Reviewer/ })).toBeDefined());
  });
  it("hides models and saved agents without a confirmed login", async () => {
    show(DEFAULT_SETTINGS, { ...credentials, openrouter: { set: false, updatedAt: null } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Sonnet"),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), { key: "ArrowDown" });
    expect(screen.queryByRole("menuitemradio", { name: /Pi test/ })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /Router tester/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Manage agents/ })).toBeDefined();
  });
  it("keeps Manage agents available with no confirmed login", async () => {
    const off = { set: false, updatedAt: null };
    show(DEFAULT_SETTINGS, {
      claude: off,
      codex: { ...off, lastRefresh: null },
      openrouter: off,
      anthropic: off,
      openai: off,
    });
    await waitFor(() => expect(vi.mocked(call)).toHaveBeenCalledWith("getCredentialStatus", {}));
    fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), { key: "ArrowDown" });
    expect(screen.getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["Manage agents…"]);
  });
  it("offers only Manage agents while logins load", () => {
    show(DEFAULT_SETTINGS, new Promise(() => undefined));
    fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), { key: "ArrowDown" });
    expect(screen.getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["Manage agents…"]);
  });
});
