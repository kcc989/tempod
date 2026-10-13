import { DEFAULT_SETTINGS } from "@tempo/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewChatComposer } from "~/ui/components/chat/NewChatComposer";
import { NewWorkspaceDialog } from "~/ui/components/dialogs/NewWorkspaceDialog";

const state = vi.hoisted(() => ({
  call: vi.fn(),
  navigate: vi.fn(),
  close: vi.fn(),
  modelsLoading: false,
  summary: { id: "w1", title: "lisbon" },
}));

vi.mock("~/ui/lib/api", () => ({ call: state.call }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));

vi.mock("~/ui/hooks/useProjects", () => ({
  useProjects: () => ({
    isPending: false,
    isError: false,
    data: [{ id: "p1", name: "tempo", owner: "acme", defaultBranch: "main", settings: {} }],
  }),
}));

vi.mock("~/ui/hooks/useCredentialStatus", () => ({
  useCredentialStatus: () => ({
    isSuccess: true,
    data: {
      claude: { set: true },
      anthropic: { set: false },
      codex: { set: true },
      openai: { set: false },
      openrouter: { set: false },
    },
  }),
}));

vi.mock("~/ui/hooks/useWorkspace", () => ({ useWorkspaceSelector: () => DEFAULT_SETTINGS }));

vi.mock("~/ui/hooks/useMediaQuery", () => ({ useIsPhone: () => false }));

vi.mock("~/ui/hooks/useWorkspaceUi", () => ({
  useDialog: () => ({ open: true, args: {}, onOpenChange: vi.fn() }),
}));

vi.mock("~/ui/state/workspace-ui", () => ({
  closeDialog: state.close,
  openDialog: vi.fn(),
  setPhonePane: vi.fn(),
}));

vi.mock("~/ui/stores/hub-store", () => ({ getHubStore: () => ({ merge: vi.fn() }) }));

vi.mock("~/ui/hooks/useCustomAgents", () => ({ useCustomAgents: () => ({ data: [] }) }));

vi.mock("~/ui/hooks/useCall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/ui/hooks/useCall")>();

  return {
    ...actual,
    useCallQuery: (name: string) => ({
      isSuccess: !state.modelsLoading,
      isPending: state.modelsLoading,
      data:
        name === "listModels" && !state.modelsLoading
          ? [
              {
                agent: "claude",
                currentValue: "test-opus",
                options: [{ value: "test-opus", name: "Test Opus" }],
              },
              {
                agent: "codex",
                currentValue: "test-codex",
                options: [{ value: "test-codex", name: "Test Codex" }],
              },
            ]
          : [],
      refetch: vi.fn(),
    }),
  };
});

vi.mock("~/ui/stores/workspace-store", () => ({
  knownModels: () => [
    { agent: "claude", value: "test-opus", name: "Test Opus" },
    { agent: "codex", value: "test-codex", name: "Test Codex" },
  ],
}));

function show() {
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { mutations: { retry: false } } }) },
      createElement(NewWorkspaceDialog),
    ),
  );
}

beforeEach(() => {
  state.modelsLoading = false;
  state.call.mockReset();
  state.call.mockResolvedValue(state.summary);
});

describe("workspace creation composer", () => {
  it("opens an empty workspace while model discovery is still loading", async () => {
    state.modelsLoading = true;
    show();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), { key: "Enter", code: "Enter" });
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
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
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
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({ to: "/w/$workspaceId", params: { workspaceId: "w1" } }),
    );
    expect(state.close).toHaveBeenCalledWith("newWorkspace");
  });
  it("sends a trimmed first prompt and a model picked inside the composer", async () => {
    show();
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: /Test Codex/ }));
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
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
  it("does not submit Shift+Enter or IME composition", () => {
    show();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter", shiftKey: true });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter", isComposing: true });
    expect(state.call).not.toHaveBeenCalled();
  });
  it("keeps branch options out of the initial composer", () => {
    show();
    expect(screen.queryByRole("tab", { name: "Existing branch" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Workspace options" }));
    expect(screen.getByRole("tab", { name: "Existing branch" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Keep open" })).toBeDefined();
  });
  it("prevents duplicate creation while a request is pending", async () => {
    state.call.mockReturnValue(new Promise(() => {}));
    show();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(state.call).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Creating…" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps the draft after a failed create and allows retry", async () => {
    state.call.mockRejectedValueOnce(new Error("Could not create"));
    show();
    const prompt = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "Fix this" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(state.call).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(prompt.value).toBe("Fix this");
    expect(state.navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(state.navigate).toHaveBeenCalledTimes(1));
  });
});

describe("new chat composer", () => {
  function chat() {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(NewChatComposer, { workspaceId: "w1", open: true, onCreated, onOpenChange }),
      ),
    );

    return { onCreated, onOpenChange };
  }

  it("opens an empty chat without sending a blank message", async () => {
    state.call.mockResolvedValue({ id: "s1", agent: "claude" });
    const { onCreated, onOpenChange } = chat();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "s1", agent: "claude" }));
    expect(state.call).toHaveBeenCalledTimes(1);
    expect(state.call).toHaveBeenCalledWith("createSession", {
      workspaceId: "w1",
      agent: "claude",
      model: "test-opus",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("keeps the prompt and reuses the created chat when sending fails", async () => {
    let sends = 0;
    state.call.mockImplementation(async (name: string) => {
      if (name === "createSession") return { id: "s1", agent: "claude" };

      if (sends++ === 0) throw new Error("Send failed");

      return {};
    });
    const { onCreated } = chat();
    const prompt = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "Fix this" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(state.call).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Create chat" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(prompt.value).toBe("Fix this");
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(state.call.mock.calls.filter(([name]) => name === "createSession")).toHaveLength(1);
    expect(state.call.mock.calls.filter(([name]) => name === "sendPrompt")).toHaveLength(2);
  });
});
