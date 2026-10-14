import { createUiEnvironment } from "../environment";
import { detail, session, turn } from "../fixtures";
import { elementOf } from "../elements";
import { openDialog, resetUiState, dialogStore } from "~/ui/state/workspace-ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NewChatComposer } from "~/ui/components/chat/NewChatComposer";
import { NewWorkspaceDialog } from "~/ui/components/dialogs/NewWorkspaceDialog";

const environment = createUiEnvironment();

const state = { call: environment.request, modelsLoading: false, modelsError: false, refetchModels: vi.fn() };

let createFails = false;

let createPending = false;

let sendFails = false;

const requestsOf = (name: string) => state.call.mock.calls.filter(([key]) => key === name);

const promptField = async () =>
  elementOf(await screen.findByRole("textbox", { name: "Prompt" }), HTMLTextAreaElement);

const readyModels = async () =>
  waitFor(() => expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Test Opus"), {
    timeout: 3000,
  });

function show() {
  return render(<NewWorkspaceDialog />, { wrapper: environment.Provider });
}

beforeEach(() => {
  resetUiState();
  localStorage.clear();
  environment.history.replace("/");
  environment.setState({ workspace: detail() });
  openDialog({ kind: "newWorkspace" });
  state.modelsLoading = false;
  createFails = false;
  createPending = false;
  sendFails = false;
  state.modelsError = false;
  state.refetchModels.mockReset();
  state.call.mockReset();
  state.call.mockImplementation(async (name) => {
    if (name === "listProjects")
      return [
        {
          id: "p1",
          installationId: 1,
          repoId: 1,
          owner: "acme",
          name: "tempo",
          defaultBranch: "main",
          settings: {},
          sortOrder: 0,
        },
      ];

    if (name === "getCredentialStatus")
      return {
        claude: { set: true, updatedAt: 1 },
        codex: { set: true, updatedAt: 1, lastRefresh: 1 },
        anthropic: { set: false, updatedAt: null },
        openai: { set: false, updatedAt: null },
        openrouter: { set: false, updatedAt: null },
      };

    if (name === "listModels") {
      if (state.modelsLoading) return new Promise(() => {});

      return [
        { agent: "claude", currentValue: "test-opus", options: [{ value: "test-opus", name: "Test Opus" }] },
        {
          agent: "codex",
          currentValue: "test-codex",
          options: [{ value: "test-codex", name: "Test Codex" }],
        },
      ];
    }

    if (name === "createWorkspace") {
      if (createPending) return new Promise(() => {});

      if (createFails) {
        createFails = false;
        throw new Error("Could not create");
      }

      return detail();
    }

    if (name === "createSession") return session();

    if (name === "sendPrompt") {
      if (sendFails) {
        sendFails = false;
        throw new Error("Send failed");
      }

      return turn();
    }

    return [];
  });
});

afterEach(resetUiState);

describe("workspace creation composer", () => {
  it("retries model discovery without submitting the workspace form", () => {
    state.modelsError = true;
    show();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading models" }));
    expect(state.refetchModels).toHaveBeenCalledOnce();
    expect(state.call).not.toHaveBeenCalled();
  });
  it("opens an empty workspace while model discovery is still loading", async () => {
    state.modelsLoading = true;
    show();
    fireEvent.keyDown(await promptField(), { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(state.call).toHaveBeenCalledWith("createWorkspace", {
        projectId: "p1",
        source: { kind: "new", baseBranch: "main" },
        agent: "claude",
      }),
    );
  });
  it.each(["", "   \n "])("Enter on a blank prompt creates and opens a workspace (%j)", async (text) => {
    show();
    const prompt = await promptField();
    await readyModels();
    expect(document.activeElement).toBe(prompt);
    fireEvent.change(prompt, { target: { value: text } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(state.call).toHaveBeenCalledWith("createWorkspace", {
        projectId: "p1",
        source: { kind: "new", baseBranch: "main" },
        agent: "claude",
        model: "test-opus",
      }),
    );
    await waitFor(() => expect(environment.history.location.pathname).toBe("/w/w1"));
    expect(dialogStore.getSnapshot().dialog).toBeNull();
  });
  it("sends a trimmed first prompt and a model picked inside the composer", async () => {
    show();
    await readyModels();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Test Codex/ }));
    const prompt = await promptField();
    fireEvent.change(prompt, { target: { value: "  Fix the login  " } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(state.call).toHaveBeenCalledWith("createWorkspace", {
        projectId: "p1",
        source: { kind: "new", baseBranch: "main" },
        agent: "codex",
        model: "test-codex",
        prompt: { text: "Fix the login" },
      }),
    );
  });
  it("does not submit Shift+Enter or IME composition", async () => {
    show();
    const prompt = await promptField();
    await readyModels();
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter", shiftKey: true });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter", isComposing: true });
    expect(requestsOf("createWorkspace")).toHaveLength(0);
  });
  it("keeps branch options out of the initial composer", async () => {
    show();
    await promptField();
    expect(screen.queryByRole("tab", { name: "Existing branch" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Workspace options" }));
    expect(screen.getByRole("tab", { name: "Existing branch" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Keep open" })).toBeDefined();
  });
  it("prevents duplicate creation while a request is pending", async () => {
    createPending = true;
    show();
    const prompt = await promptField();
    await readyModels();
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(requestsOf("createWorkspace")).toHaveLength(1));
    expect(elementOf(screen.getByRole("button", { name: "Creating…" }), HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it("keeps the draft after a failed create and allows retry", async () => {
    createFails = true;
    show();
    const prompt = await promptField();
    await readyModels();
    fireEvent.change(prompt, { target: { value: "Fix this" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(requestsOf("createWorkspace")).toHaveLength(1));
    await waitFor(() =>
      expect(elementOf(screen.getByRole("button", { name: "Create" }), HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(prompt.value).toBe("Fix this");
    expect(environment.history.location.pathname).toBe("/");
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(environment.history.location.pathname).toBe("/w/w1"));
  });
});

describe("new chat composer", () => {
  function chat() {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NewChatComposer workspaceId="w1" open={true} onCreated={onCreated} onOpenChange={onOpenChange} />,
      { wrapper: environment.Provider },
    );

    return { onCreated, onOpenChange };
  }

  it("opens an empty chat without sending a blank message", async () => {
    const { onCreated, onOpenChange } = chat();
    await readyModels();
    fireEvent.keyDown(await promptField(), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(session()));
    expect(requestsOf("createSession")).toHaveLength(1);
    expect(requestsOf("sendPrompt")).toHaveLength(0);
    expect(state.call).toHaveBeenCalledWith("createSession", {
      workspaceId: "w1",
      agent: "claude",
      model: "test-opus",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("keeps the prompt and reuses the created chat when sending fails", async () => {
    sendFails = true;
    const { onCreated } = chat();
    const prompt = await promptField();
    await readyModels();
    fireEvent.change(prompt, { target: { value: "Fix this" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(requestsOf("sendPrompt")).toHaveLength(1));
    await waitFor(() =>
      expect(elementOf(screen.getByRole("button", { name: "Create chat" }), HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(prompt.value).toBe("Fix this");
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(state.call.mock.calls.filter(([name]) => name === "createSession")).toHaveLength(1);
    expect(state.call.mock.calls.filter(([name]) => name === "sendPrompt")).toHaveLength(2);
  });
});
