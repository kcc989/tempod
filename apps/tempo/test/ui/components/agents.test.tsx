import { createUiEnvironment, requestInput } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { elementOf } from "../elements.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentSummary, CredentialStatus } from "@tempo/protocol";
import { SettingsPage } from "../../../src/ui/components/settings/SettingsPage";

import { openDialog, resetUiState } from "../../../src/ui/state/workspace-ui";

/** Settings → Agents (04, Settings; 01, Saved agents). */

const reviewer: Agent = {
  id: "01ca",
  handle: "reviewer",
  access: "read-only",
  outputKind: "review",
  version: 1,
  starter: null,
  createdAt: 0,
  name: "Reviewer",
  description: "Reviews code",
  baseAgent: "codex",
  model: "gpt-5",
  thoughtLevel: "high",
  prompt: "Review only.",
  tools: { allow: [], deny: ["Edit"] },
  mcp: { playwright: true, servers: [] },
  sha: "c".repeat(64),
  updatedAt: 1,
};

const status = (connected: string[]): CredentialStatus => ({
  claude: { set: connected.includes("claude"), updatedAt: null },
  codex: { set: connected.includes("codex"), updatedAt: null, lastRefresh: null },
  openrouter: { set: connected.includes("openrouter"), updatedAt: null },
  anthropic: { set: connected.includes("anthropic"), updatedAt: null },
  openai: { set: connected.includes("openai"), updatedAt: null },
});

const show = (
  agents: AgentSummary[] = [],
  connected = ["claude", "codex"],
  loginResponse?: Promise<CredentialStatus>,
) => {
  vi.mocked(call).mockImplementation(async (name, input) => {
    if (name === "getCredentialStatus") return loginResponse ?? status(connected);

    if (name === "saveAgent")
      return { ...reviewer, ...requestInput("saveAgent", input).definition, id: "01new" };

    if (name === "getAgent") return reviewer;

    if (name === "deleteAgent") return {};

    return [];
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["call", "listProjects", {}], []);
  client.setQueryData(["call", "listAgents", {}], agents);

  if (!loginResponse) client.setQueryData(["call", "getCredentialStatus", {}], status(connected));
  openDialog({ kind: "settings", tab: "agents" });

  const rendered = render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
    { wrapper: environment.Provider },
  );

  return { ...rendered, client };
};

afterEach(resetUiState);

describe("Settings → Agents", () => {
  it("is a Personal page after Logins and Models", () => {
    show();
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    const items = screen.getAllByRole("button").map((b) => b.textContent);
    expect(items.indexOf("Agents")).toBe(items.indexOf("Logins") + 2);
    expect(screen.getByText("No agents yet.")).toBeTruthy();
  });

  it("creates an agent; tag inputs, switch and fields build the definition", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tester" } });
    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "tester" } });
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "Write tests." } });
    fireEvent.change(screen.getByLabelText("Reasoning level"), { target: { value: "medium" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Base agent" }), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: "OpenCode" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Pi" })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));
    expect(screen.getByRole("combobox", { name: "Base agent" }).textContent).toBe("Codex");
    const deny = screen.getByRole("textbox", { name: "Denied tools" });
    fireEvent.change(deny, { target: { value: "Edit" } });
    fireEvent.keyDown(deny, { key: "Enter" });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveAgent", {
        definition: {
          name: "Tester",
          handle: "tester",
          access: "read-only",
          outputKind: "note",
          description: "",
          baseAgent: "codex",
          model: "",
          thoughtLevel: "medium",
          prompt: "Write tests.",
          tools: { allow: [], deny: ["Edit"] },
          mcp: { playwright: false, servers: [] },
        },
      }),
    );
  });

  it("starts a new definition from the first connected base rather than an unconnected Claude", async () => {
    show([], ["openai"]);
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    expect(screen.getByRole("combobox", { name: "Base agent" }).textContent).toBe("Codex");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Connected" } });
    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "connected" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveAgent", {
        definition: expect.objectContaining({ name: "Connected", baseAgent: "codex" }),
      }),
    );
  });

  it("prevents creation until logins are confirmed and exposes recovery when loading fails", async () => {
    let reject!: (error: Error) => void;

    const response = new Promise<CredentialStatus>((_, fail) => {
      reject = fail;
    });

    show([], [], response);
    expect(screen.getByRole("button", { name: "New agent" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Loading logins…")).toBeTruthy();
    reject(new Error("Login status unavailable"));
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("button", { name: "New agent" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect another agent" }));
    expect(screen.getByRole("heading", { name: "Logins" })).toBeTruthy();
  });

  it("blocks a new draft after its selected base loses its login", async () => {
    const { client } = show();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    await act(async () => {
      client.setQueryData(["call", "getCredentialStatus", {}], status([]));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Save/ }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByRole("combobox", { name: "Base agent" }).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "New agent" }));
    expect(call).not.toHaveBeenCalledWith("saveAgent", expect.anything());
  });

  it("preserves a saved disconnected base without offering it as a choice", async () => {
    show([{ ...reviewer, baseAgent: "codex" }], ["claude"]);
    fireEvent.click(screen.getByRole("button", { name: /Reviewer/ }));
    await screen.findByText(/Codex is not connected/);
    expect(screen.getByRole("combobox", { name: "Base agent" }).textContent).toBe("Codex");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Base agent" }), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "Claude" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Codex" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveAgent", {
        agentId: "01ca",
        definition: expect.objectContaining({ baseAgent: "codex", description: "Updated" }),
      }),
    );
  });

  it("shows field errors and does not save an invalid form", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Add MCP server" }));
    fireEvent.change(screen.getByLabelText("Env"), { target: { value: "TOKEN=sk-live-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(screen.getByText("Enter a name.")).toBeTruthy();
    expect(screen.getByText("Enter the command.")).toBeTruthy();
    expect(screen.getByText(/TOKEN: use \$\{NAME\}/)).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith("saveAgent", expect.anything());
  });

  it("loads an agent, notes what its base agent ignores, and deletes after confirming", async () => {
    show([
      {
        id: "01ca",
        handle: "reviewer",
        name: "Reviewer",
        description: "Reviews code",
        baseAgent: "codex",
        access: "read-only",
        outputKind: "review",
        version: 1,
        sha: reviewer.sha,
        starter: null,
        updatedAt: 1,
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Reviewer/ }));
    await waitFor(() =>
      expect(elementOf(screen.getByLabelText("Name"), HTMLInputElement).value).toBe("Reviewer"),
    );
    expect(screen.getByText("Tool limits are not supported.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const { dialogStore, resolveConfirm } = await import("../../../src/ui/state/workspace-ui");
    const request = dialogStore.getSnapshot().confirm!;
    expect(request.title).toBe("Delete Reviewer? Open chats keep using it.");
    resolveConfirm(request.id, true);
    await waitFor(() => expect(call).toHaveBeenCalledWith("deleteAgent", { agentId: "01ca" }));
  });
  it("duplicates a definition into a new editable draft", async () => {
    show([
      {
        id: "01ca",
        handle: "reviewer",
        name: "Reviewer",
        description: "Reviews code",
        baseAgent: "codex",
        access: "read-only",
        outputKind: "review",
        version: 1,
        sha: reviewer.sha,
        starter: null,
        updatedAt: 1,
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Reviewer/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Duplicate" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(elementOf(screen.getByLabelText("Handle"), HTMLInputElement).value).toBe("reviewer-copy");
    expect(elementOf(screen.getByLabelText("System prompt"), HTMLTextAreaElement).value).toBe(
      reviewer.prompt,
    );
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "saveAgent",
        expect.objectContaining({
          definition: expect.objectContaining({
            handle: "reviewer-copy",
            prompt: reviewer.prompt,
            outputKind: "review",
          }),
        }),
      ),
    );
    const input = vi.mocked(call).mock.calls.find(([name]) => name === "saveAgent")?.[1];
    expect(input).not.toHaveProperty("agentId");
  });
});
