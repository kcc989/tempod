import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProjectConversations } from "../../../src/ui/components/history/ProjectConversations";

const artifact = {
  version: 1,
  conversationId: "deleted-workspace",
  projectId: "p1",
  title: "Saved discussion",
  branch: "tempo/saved",
  updatedAt: 1000,
  sessions: [{ id: "s1", agent: "claude", title: "Chat", status: "closed", createdAt: 0, closedAt: 1000 }],
  turns: [],
  items: Array.from({ length: 101 }, (_, index) => ({
    id: `item-${index}`,
    sessionId: "s1",
    turnId: null,
    kind: "agent_message",
    status: "completed",
    content: {
      text: index === 0 ? '<img src="https://example.com/tracker" onerror="alert(1)">' : `Message ${index}`,
    },
    rev: index + 1,
    createdAt: index,
    updatedAt: index,
  })),
};

vi.mock("~/ui/hooks/useCall", () => ({
  useCallQuery: (name: string) => ({
    isPending: false,
    isError: false,
    data: name === "listProjectConversations" ? { conversations: [artifact], cursor: null } : artifact,
  }),
}));

describe("saved project conversations", () => {
  it("opens retained transcripts and pages through their messages without live workspace actions", () => {
    const { container } = render(
      createElement(ProjectConversations, {
        project: {
          id: "p1",
          installationId: 1,
          repoId: 1,
          owner: "owner",
          name: "repo",
          defaultBranch: "main",
          settings: {},
          sortOrder: 0,
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Saved discussion/ }));
    expect(screen.getByRole("list", { name: "Saved transcript" }).children).toHaveLength(100);
    expect(container.querySelector("img, script")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next messages" }));
    expect(screen.getByText("Message 100")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Saved transcript" }).children).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
    expect(screen.queryByRole("list", { name: "Saved transcript" })).toBeNull();
  });
});
