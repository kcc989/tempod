import { createUiEnvironment, requestInput } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { elementOf } from "../elements.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomAgent, CustomAgentSummary } from "@tempo/protocol";
import { SettingsPage } from "../../../src/ui/components/settings/SettingsPage";

import { openDialog, resetUiState } from "../../../src/ui/state/workspace-ui";

/** Settings → Agents (04, Settings; 01, Custom agents). */

const reviewer: CustomAgent = {
  id: "01ca",
  name: "Reviewer",
  description: "Reviews code",
  baseAgent: "codex",
  model: "gpt-5",
  thoughtLevel: "high",
  systemPrompt: "Review only.",
  tools: { allow: [], deny: ["Edit"] },
  mcp: { playwright: true, servers: [] },
  commitSha: "c".repeat(40),
  updatedAt: 1,
};

const show = (agents: CustomAgentSummary[] = []) => {
  vi.mocked(call).mockImplementation(async (name, input) => {
    if (name === "saveCustomAgent")
      return { ...reviewer, ...requestInput("saveCustomAgent", input).definition, id: "01new" };

    if (name === "getCustomAgent") return reviewer;

    if (name === "deleteCustomAgent") return {};

    return [];
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["call", "listProjects", {}], []);
  client.setQueryData(["call", "listCustomAgents", {}], agents);
  openDialog({ kind: "settings", tab: "agents" });

  return render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
    { wrapper: environment.Provider },
  );
};

afterEach(resetUiState);

describe("Settings → Agents", () => {
  it("is a Personal page after Logins", () => {
    show();
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    const items = screen.getAllByRole("button").map((b) => b.textContent);
    expect(items.indexOf("Agents")).toBe(items.indexOf("Logins") + 1);
    expect(screen.getByText("No custom agents yet.")).toBeTruthy();
  });

  it("creates an agent; tag inputs, switch and fields build the definition", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tester" } });
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "Write tests." } });
    fireEvent.change(screen.getByLabelText("Reasoning level"), { target: { value: "medium" } });
    const deny = screen.getByRole("textbox", { name: "Denied tools" });
    fireEvent.change(deny, { target: { value: "Edit" } });
    fireEvent.keyDown(deny, { key: "Enter" });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveCustomAgent", {
        definition: {
          name: "Tester",
          description: "",
          baseAgent: "claude",
          model: "",
          thoughtLevel: "medium",
          systemPrompt: "Write tests.",
          tools: { allow: [], deny: ["Edit"] },
          mcp: { playwright: false, servers: [] },
        },
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
    expect(call).not.toHaveBeenCalledWith("saveCustomAgent", expect.anything());
  });

  it("loads an agent, notes what its base agent ignores, and deletes after confirming", async () => {
    show([{ id: "01ca", name: "Reviewer", description: "Reviews code", baseAgent: "codex", updatedAt: 1 }]);
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
    await waitFor(() => expect(call).toHaveBeenCalledWith("deleteCustomAgent", { customAgentId: "01ca" }));
  });
});
