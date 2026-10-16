import { createUiEnvironment } from "../environment";
import { detail } from "../fixtures";
import { openDialog, resetUiState } from "~/ui/state/workspace-ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { NewWorkspaceDialog } from "~/ui/components/dialogs/NewWorkspaceDialog";

const environment = createUiEnvironment();

const request = environment.request;

beforeEach(() => {
  resetUiState();
  openDialog({ kind: "newWorkspace", projectId: "p1", prompt: "Fix login" });
  request.mockImplementation(async (name) => {
    if (name === "listProjects")
      return [
        {
          id: "p1",
          installationId: 1,
          repoId: 1,
          owner: "owner",
          name: "repo",
          defaultBranch: "main",
          settings: { agent: { default: "codex" } },
          sortOrder: 0,
        },
      ];

    if (name === "getCredentialStatus")
      return {
        claude: { set: false, updatedAt: null },
        codex: { set: true, updatedAt: 1, lastRefresh: 1 },
        openrouter: { set: false, updatedAt: null },
        anthropic: { set: false, updatedAt: null },
        openai: { set: false, updatedAt: null },
      };

    if (name === "listModels")
      return [
        {
          agent: "codex",
          currentValue: "reported-model",
          options: [{ value: "reported-model", name: "Reported model" }],
        },
      ];

    if (name === "createWorkspace") return detail();

    return [];
  });
});

afterEach(resetUiState);

describe("new workspace composer", () => {
  it("focuses the prompt and creates a new branch with the selected model and initial prompt", async () => {
    render(<NewWorkspaceDialog />, { wrapper: environment.Provider });
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(document.activeElement).toBe(prompt));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Reported model"),
    );
    expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Source" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Create/ }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("createWorkspace", {
        projectId: "p1",
        source: { kind: "new", baseBranch: "main" },
        agent: "codex",
        model: "reported-model",
        prompt: { text: "Fix login" },
      }),
    );
  });

  it("offers Retry instead of loading forever when login status fails", async () => {
    const answer = request.getMockImplementation()!;
    let failStatus = true;

    request.mockImplementation(async (name, input) => {
      if (name === "getCredentialStatus" && failStatus) throw new Error("status unavailable");

      return answer(name, input);
    });
    render(<NewWorkspaceDialog />, { wrapper: environment.Provider });
    const retry = await screen.findByRole("button", { name: "Retry loading models" });
    expect(screen.getByRole("button", { name: "Model" }).textContent).not.toContain("Loading models");
    failStatus = false;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Reported model"),
    );
  });
});
