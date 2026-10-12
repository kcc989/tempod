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
