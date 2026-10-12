import type { Item } from "@tempo/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../../src/ui/components/chat/Transcript";
import { emptyWorkspaceState } from "../../../src/ui/stores/workspace-state";
import { agentMessage, detail, session, turn } from "../fixtures";

const fixture = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("~/ui/hooks/useWorkspace", () => ({ useWorkspace: () => fixture.state }));
vi.mock("~/ui/lib/api", () => ({ call: vi.fn(async () => ({})) }));
const state = () => ({
  ...emptyWorkspaceState,
  ready: true,
  backlogDone: true,
  workspace: detail(),
  sessions: { s1: session() },
  turns: { t1: turn({ status: "completed", endedAt: 2000 }) },
});
const element = (client: QueryClient, id: string) =>
  createElement(
    QueryClientProvider,
    { client },
    createElement(Transcript, { workspaceId: id, sessionId: "s1" }),
  );
beforeEach(() => {
  fixture.state = state();
});

describe("transcript reading", () => {
  it("announces every message in a completion batch, without announcing streaming deltas", async () => {
    const client = new QueryClient();
    const view = render(element(client, "announce-w"));
    fixture.state = {
      ...state(),
      order: { s1: ["a1", "a2", "a3"] },
      items: {
        a1: agentMessage("a1", "First response", { status: "completed" }),
        a2: agentMessage("a2", "Second response", { status: "completed" }),
        a3: agentMessage("a3", "Streaming response"),
      },
    };
    view.rerender(element(client, "announce-w"));
    await waitFor(() =>
      expect(view.container.querySelector("[aria-live]")?.textContent).toBe("First response Second response"),
    );
    fixture.state = {
      ...state(),
      order: { s1: ["a1", "a2", "a3"] },
      items: {
        a1: agentMessage("a1", "First response", { status: "completed" }),
        a2: agentMessage("a2", "Second response", { status: "completed" }),
        a3: agentMessage("a3", "Streaming response with delta"),
      },
    };
    view.rerender(element(client, "announce-w"));
    expect(view.container.querySelector("[aria-live]")?.textContent).toBe("First response Second response");
  });

  it("restores a chat's reading position after its body unmounts", () => {
    fixture.state = {
      ...state(),
      order: { s1: ["a1"] },
      items: { a1: agentMessage("a1", "A long response", { status: "completed" }) },
    };
    const client = new QueryClient();
    const view = render(element(client, "scroll-w"));
    const scroller = view.container.querySelector('[aria-label="Transcript"]')!;
    Object.defineProperties(scroller, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
    scroller.scrollTop = 240;
    fireEvent.scroll(scroller);
    view.unmount();
    const reopened = render(element(client, "scroll-w"));
    expect(reopened.container.querySelector('[aria-label="Transcript"]')?.scrollTop).toBe(240);
  });
});

describe("work row (04, Work row)", () => {
  const tool = (id: string, toolKind: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      sessionId: "s1",
      turnId: "t1",
      kind: "tool_call",
      status: "completed",
      content: { toolCallId: id, title: id, toolKind, locations: [], content: [], ...over },
      rev: 1,
      createdAt: 1000,
      updatedAt: 1000,
    }) as Item;

  it("folds work into one collapsed row and keeps edits, failures and the answer visible", () => {
    fixture.state = {
      ...state(),
      turns: { t1: turn({ status: "completed", startedAt: 1000, endedAt: 49_000 }) },
      order: { s1: ["r1", "x1", "e1", "f1", "a1"] },
      items: {
        r1: tool("r1", "read", { locations: [{ path: "/workspace/README.md" }] }),
        x1: tool("x1", "execute", {
          title: "bun test",
          rawInput: { command: "bun test", description: "Run the tests" },
        }),
        e1: tool("e1", "edit", {
          content: [{ type: "diff", path: "/workspace/src/a.ts", oldText: "a\n", newText: "a\nb\n" }],
        }),
        f1: {
          ...tool("f1", "execute", {
            title: "bun lint",
            content: [{ type: "content", content: { type: "text", text: "lint error" } }],
          }),
          status: "failed",
        },
        a1: agentMessage("a1", "The answer", { status: "completed" }),
      },
    };
    const view = render(element(new QueryClient(), "work-w"));
    const row = view.getByRole("button", { name: "Explored 1 file · ran 1 command · 48 s" });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("Run the tests")).toBeNull();
    expect(view.getByText("a.ts")).toBeTruthy();
    expect(view.getByText("+1")).toBeTruthy();
    expect(view.getByRole("button", { name: "Changes" })).toBeTruthy();
    expect(view.getByText("lint error")).toBeTruthy();
    expect(view.getByText("The answer")).toBeTruthy();
    expect(view.queryByLabelText("Done")).toBeNull();
    fireEvent.click(row);
    expect(view.getByText("Run the tests")).toBeTruthy();
  });
});
