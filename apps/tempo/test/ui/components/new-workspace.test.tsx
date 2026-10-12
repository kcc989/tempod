import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewWorkspaceDialog } from "~/ui/components/dialogs/NewWorkspaceDialog";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("~/ui/hooks/useMediaQuery", () => ({ useIsPhone: () => false }));
vi.mock("~/ui/hooks/useWorkspaceUi", () => ({
  useDialog: () => ({ open: true, args: { projectId: "p1", prompt: "Fix login" }, onOpenChange: vi.fn() }),
}));
vi.mock("~/ui/hooks/useProjects", () => ({
  useProjects: () => ({
    data: [
      {
        id: "p1",
        owner: "owner",
        name: "repo",
        defaultBranch: "main",
        settings: { agent: { default: "codex" } },
      },
    ],
  }),
}));
vi.mock("~/ui/hooks/useCall", () => ({
  useCallQuery: (name: string) => ({
    isSuccess: true,
    data:
      name === "getCredentialStatus"
        ? {
            claude: { set: false },
            codex: { set: true },
            openrouter: { set: false },
            anthropic: { set: false },
            openai: { set: false },
          }
        : [
            {
              agent: "codex",
              currentValue: "reported-model",
              options: [{ value: "reported-model", name: "Reported model" }],
            },
          ],
  }),
  useCallMutation: () => ({ mutate, isPending: false }),
}));

describe("new workspace composer", () => {
  it("focuses the prompt and creates a new branch with the selected model and initial prompt", async () => {
    render(<NewWorkspaceDialog />);
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(document.activeElement).toBe(prompt));
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Reported model");
    expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Source" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Create/ }));
    expect(mutate).toHaveBeenCalledWith({
      projectId: "p1",
      source: { kind: "new", baseBranch: "main" },
      agent: "codex",
      model: "reported-model",
      prompt: { text: "Fix login" },
    });
  });
});
