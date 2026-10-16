import { createUiEnvironment } from "../environment";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ModelsTab } from "~/ui/components/dialogs/settings/ModelsTab";
import { NewWorkspaceDialog } from "~/ui/components/dialogs/NewWorkspaceDialog";
import { openDialog, resetUiState } from "~/ui/state/workspace-ui";

const environment = createUiEnvironment();

const request = environment.request;

const off = { set: false, updatedAt: null };

let saved: ReadonlyArray<{ agent: string; model: string }> = [];

let failSave = false;

beforeEach(() => {
  resetUiState();
  saved = [{ agent: "codex", model: "gone" }];
  failSave = false;
  request.mockImplementation(async (name, input) => {
    if (name === "getCredentialStatus")
      return {
        claude: { set: true, updatedAt: 1 },
        codex: { set: true, updatedAt: 1, lastRefresh: 1 },
        openrouter: off,
        anthropic: off,
        openai: off,
      };

    if (name === "listModels")
      return [
        {
          agent: "claude",
          currentValue: "opus",
          options: [
            { value: "opus", name: "Opus" },
            { value: "sonnet", name: "Sonnet" },
          ],
        },
        { agent: "codex", currentValue: "gpt", options: [{ value: "gpt", name: "GPT" }] },
      ];

    if (name === "getModelList") return { models: saved, updatedAt: 1 };

    if (name === "setModelList") {
      if (failSave) throw new Error("save failed");
      // SAFETY: setModelList input is always `{models}` (02, Model list).
      saved = (input as { models: typeof saved }).models;

      return { models: saved, updatedAt: 2 };
    }

    if (name === "listProjects")
      return [
        {
          id: "p1",
          installationId: 1,
          repoId: 1,
          owner: "owner",
          name: "repo",
          defaultBranch: "main",
          settings: { agent: { default: "claude" } },
          sortOrder: 0,
        },
      ];

    return [];
  });
});

describe("Settings → Models", () => {
  it("appends checked models, keeps unreported picks and restores the list when a save fails", async () => {
    render(<ModelsTab />, { wrapper: environment.Provider });
    const claude = await screen.findByRole("region", { name: "Claude" });
    expect(screen.getByRole("region", { name: "Codex" }).textContent).toContain("gone · Not reported");
    fireEvent.click(claude.querySelector('[role="checkbox"]')!);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("setModelList", {
        models: [
          { agent: "codex", model: "gone" },
          { agent: "claude", model: "opus" },
        ],
      }),
    );
    expect(screen.getByRole("list", { name: "Your models" }).textContent).toContain("Opus");
    failSave = true;
    fireEvent.click(screen.getByRole("button", { name: "Show all models" }));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Your models" }).textContent).toContain("Opus"),
    );
    expect(saved).toHaveLength(2);
  });

  it("limits the New workspace picker to the picks in list order", async () => {
    saved = [
      { agent: "codex", model: "gpt" },
      { agent: "claude", model: "sonnet" },
    ];
    openDialog({ kind: "newWorkspace", projectId: "p1", prompt: "" });
    render(<NewWorkspaceDialog />, { wrapper: environment.Provider });
    const model = await screen.findByRole("button", { name: "Model" });
    await waitFor(() => expect(model.textContent).toContain("Sonnet"));
    fireEvent.pointerDown(model, { button: 0, ctrlKey: false });
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["GPT · Codex", "Sonnet · Claude"]);
  });
});
