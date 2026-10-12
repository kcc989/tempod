import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS, type CredentialStatus, type Settings } from "@tempo/protocol";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewChatMenu } from "../../../src/ui/components/chat/ChatTabs";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";
import { call } from "../../../src/ui/lib/api";
import { emptyWorkspaceState } from "../../../src/ui/stores/workspace-state";
import { detail } from "../fixtures";

const fixture = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("~/ui/hooks/useWorkspace", () => ({
  useWorkspaceSelector: (_: string, select: (state: unknown) => unknown) => select(fixture.state),
}));
vi.mock("~/ui/lib/api", () => ({ call: vi.fn() }));

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

const show = (settings: Settings, status: CredentialStatus = credentials) => {
  fixture.state = { ...emptyWorkspaceState, ready: true, workspace: detail({ settings }) };
  vi.mocked(call).mockImplementation(async (name) => {
    if (name === "getCredentialStatus") return status as never;
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
        createElement(NewChatMenu, {
          workspaceId: "w1",
          open: true,
          onOpenChange: () => undefined,
          disabled: false,
          onPick: () => undefined,
        }),
      ),
    ),
  );
};

const item = (name: RegExp) => screen.getByRole("menuitem", { name });
const disabled = (name: RegExp) => item(name).getAttribute("aria-disabled") === "true";
const text = (name: RegExp) => item(name).textContent;

beforeEach(() => {
  vi.mocked(call).mockReset();
});

describe("New chat menu (04, Tabs)", () => {
  it("disables OpenCode and Pi while their agent.models entry is empty", async () => {
    show(withModels({ pi: "openrouter/pi" }));
    await waitFor(() => expect(disabled(/^OpenCode/)).toBe(true));
    expect(text(/^OpenCode/)).toBe("OpenCodeSet a model in Settings → Project");
    expect([disabled(/^Pi/), disabled(/^Claude/), disabled(/^Codex/)]).toEqual([false, false, false]);
    expect(screen.getAllByText("Set a model in Settings → Project")).toHaveLength(1);
  });

  it("does not require a model for Claude or Codex, and a missing login wins", async () => {
    show(withModels({ opencode: "openrouter/oc" }), {
      ...credentials,
      openrouter: { set: false, updatedAt: null },
    });
    await waitFor(() => expect(disabled(/^OpenCode/)).toBe(true));
    expect(text(/^OpenCode/)).toBe("OpenCodeAdd login in Settings");
    expect(text(/^Pi/)).toBe("PiAdd login in Settings");
    expect(screen.queryByText("Set a model in Settings → Project")).toBeNull();
    expect([disabled(/^Claude/), disabled(/^Codex/)]).toEqual([false, false]);
  });
});
