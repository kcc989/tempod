import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TempoError, type CredentialStatus } from "@tempo/protocol";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../src/ui/components/ui/tooltip";
import { Composer } from "../../../src/ui/components/chat/Composer";
import { call } from "../../../src/ui/lib/api";
import { insertIntoComposer, syncChatTabs } from "../../../src/ui/state/workspace-ui";
import { emptyWorkspaceState } from "../../../src/ui/stores/workspace-state";
import { detail, session, turn } from "../fixtures";

const fixture = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("~/ui/hooks/useWorkspace", () => ({
  useWorkspaceSelector: (_: string, select: (state: unknown) => unknown) => select(fixture.state),
  useWorkspaceStore: () => ({ getSnapshot: () => fixture.state, clearCredentialInvalid: vi.fn() }),
}));
vi.mock("~/ui/lib/api", () => ({ call: vi.fn() }));
const credentials: CredentialStatus = {
  claude: { set: true, updatedAt: 1 },
  codex: { set: true, updatedAt: 1, lastRefresh: 1 },
  openrouter: { set: true, updatedAt: 1 },
  anthropic: { set: false, updatedAt: null },
  openai: { set: false, updatedAt: null },
};

const show = (sessionId = "s1") => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          TooltipProvider,
          null,
          createElement(Composer, { workspaceId: "composer-w", sessionId }),
        ),
      ),
    ),
    client,
  };
};
const message = () => screen.getByRole("textbox", { name: "Message" });
const type = (text: string) =>
  fireEvent.change(message(), { target: { value: text, selectionStart: text.length } });
const enter = () => fireEvent.keyDown(message(), { key: "Enter", code: "Enter" });
const pending = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  localStorage.clear();
  fixture.state = {
    ...emptyWorkspaceState,
    ready: true,
    backlogDone: true,
    workspace: detail({ runningTurnId: "t1", state: "working" }),
    sessions: { s1: session({ steering: true }), s2: session({ id: "s2" }) },
    turns: { t1: turn() },
  };
  vi.mocked(call).mockImplementation(async (name) => {
    if (name === "getCredentialStatus") return credentials as never;
    if (name === "listRoles") return [] as never;
    if (name === "listFiles") return { paths: ["src/main.ts"] } as never;
    return turn({ status: "queued" }) as never;
  });
  syncChatTabs("composer-w", ["s1", "s2"]);
});

describe("composer delivery and draft recovery", () => {
  it("Enter queues and Send now steers without cancelling the running turn", async () => {
    show();
    type("Queued prompt");
    enter();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "sendPrompt",
        expect.objectContaining({ text: "Queued prompt", delivery: "queue" }),
      ),
    );
    await waitFor(() => expect((message() as HTMLTextAreaElement).value).toBe(""));
    type("Live guidance");
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "sendPrompt",
        expect.objectContaining({ text: "Live guidance", delivery: "steer" }),
      ),
    );
    expect(vi.mocked(call).mock.calls.some(([name]) => name === "cancelTurn")).toBe(false);
  });

  it("keeps the saved draft until acknowledgement and guards repeated Enter", async () => {
    const request = pending<never>();
    vi.mocked(call).mockImplementation(async (name) =>
      name === "sendPrompt" ? request.promise : (credentials as never),
    );
    show();
    type("Keep until saved");
    enter();
    enter();
    await waitFor(() =>
      expect(vi.mocked(call).mock.calls.filter(([name]) => name === "sendPrompt")).toHaveLength(1),
    );
    expect((message() as HTMLTextAreaElement).value).toBe("Keep until saved");
    expect(localStorage.getItem("tempo:composer:draft:composer-w:s1")).toContain("Keep until saved");
    await act(async () => request.resolve(turn() as never));
    await waitFor(() => expect((message() as HTMLTextAreaElement).value).toBe(""));
  });

  it("keeps edits made during a failed request", async () => {
    const request = pending<never>();
    vi.mocked(call).mockImplementation(async (name) =>
      name === "sendPrompt" ? request.promise : (credentials as never),
    );
    show();
    type("First draft");
    enter();
    await waitFor(() => expect(call).toHaveBeenCalledWith("sendPrompt", expect.anything()));
    type("First draft plus my next thought");
    await act(async () => request.reject(new TempoError("INTERNAL")));
    expect((message() as HTMLTextAreaElement).value).toBe("First draft plus my next thought");
  });

  it("does not resend a pending draft after switching away and back", async () => {
    const request = pending<never>();
    vi.mocked(call).mockImplementation(async (name) =>
      name === "sendPrompt" ? request.promise : (credentials as never),
    );
    const view = show();
    type("One delivery");
    enter();
    await waitFor(() => expect(call).toHaveBeenCalledWith("sendPrompt", expect.anything()));
    const switchTo = (sessionId: string) =>
      view.rerender(
        createElement(
          QueryClientProvider,
          { client: view.client },
          createElement(
            TooltipProvider,
            null,
            createElement(Composer, { workspaceId: "composer-w", sessionId }),
          ),
        ),
      );
    switchTo("s2");
    switchTo("s1");
    expect((screen.getByRole("button", { name: "Queue" }) as HTMLButtonElement).disabled).toBe(true);
    enter();
    expect(vi.mocked(call).mock.calls.filter(([name]) => name === "sendPrompt")).toHaveLength(1);
    await act(async () => request.resolve(turn() as never));
    await waitFor(() => expect((message() as HTMLTextAreaElement).value).toBe(""));
  });

  it("clears only the submitted draft after switching tabs during a successful send", async () => {
    const request = pending<never>();
    vi.mocked(call).mockImplementation(async (name) =>
      name === "sendPrompt" ? request.promise : (credentials as never),
    );
    const view = show();
    type("Sent from first chat");
    enter();
    await waitFor(() => expect(call).toHaveBeenCalledWith("sendPrompt", expect.anything()));
    view.unmount();
    show("s2");
    type("Unsent second chat");
    await act(async () => request.resolve(turn() as never));
    expect((message() as HTMLTextAreaElement).value).toBe("Unsent second chat");
    expect(JSON.parse(localStorage.getItem("tempo:composer:draft:composer-w:s1")!).text).toBe("");
  });

  it("retains mentions and review chips when a chat body unmounts", async () => {
    const view = show();
    act(() => insertIntoComposer("composer-w", { kind: "reviewComments", commentIds: ["r1"] }));
    type("@main");
    await waitFor(() => expect(screen.getByRole("option").textContent).toBe("src/main.ts"));
    enter();
    type("Review this");
    view.unmount();
    show();
    expect(screen.getByText("src/main.ts")).toBeTruthy();
    expect(screen.getByText("1 review comment")).toBeTruthy();
    enter();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "sendPrompt",
        expect.objectContaining({ mentions: [{ path: "src/main.ts" }], reviewCommentIds: ["r1"] }),
      ),
    );
  });

  it("accepts legacy text drafts and keeps typing when storage is blocked", () => {
    localStorage.setItem("tempo:composer:draft:composer-w:s1", JSON.stringify("Old draft"));
    show();
    expect((message() as HTMLTextAreaElement).value).toBe("Old draft");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    type("New typing survives");
    expect((message() as HTMLTextAreaElement).value).toBe("New typing survives");
  });
  it("sends a role request from the Roles picker without sending it to the agent", async () => {
    const role = {
      name: "reviewer",
      scope: "builtin",
      sha: "a".repeat(64),
      description: "Review auth",
      agent: "other",
      access: "read-only",
      requestable: true,
      on: [],
      limits: { rounds: 1, continues: 2, timeout: "20m", tokens: 0 },
    };
    vi.mocked(call).mockImplementation(async (name) =>
      name === "listRoles"
        ? ([role] as never)
        : name === "listFiles"
          ? ({ paths: [] } as never)
          : name === "requestRole"
            ? ({ changeId: "change", roleRunId: "run" } as never)
            : (credentials as never),
    );
    show();
    type("@reviewer");
    await screen.findByRole("option");
    enter();
    await waitFor(() => expect((message() as HTMLTextAreaElement).value).toBe("/role reviewer "));
    type("/role reviewer focus on auth");
    enter();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("requestRole", {
        workspaceId: "composer-w",
        sessionId: "s1",
        role: "reviewer",
        text: "focus on auth",
      }),
    );
    expect(vi.mocked(call).mock.calls.some(([name]) => name === "sendPrompt")).toBe(false);
  });
});
