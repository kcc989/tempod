import { fireEvent, render, screen } from "@testing-library/react";
import type { ItemOf } from "@tempo/protocol";
import { describe, expect, it, vi } from "vitest";
import { BlockViewer } from "../../../src/ui/components/chat/ContentBlocks";
import { resetExpand } from "../../../src/ui/components/chat/expand-store";
import { ItemView } from "../../../src/ui/components/chat/TranscriptItems";

vi.mock("~/ui/state/workspace-ui", () => ({ openFile: vi.fn() }));
vi.mock("~/ui/lib/api", () => ({ call: vi.fn(async () => ({})) }));

describe("tool text", () => {
  it("expands an ACP command row into rendered Markdown", () => {
    resetExpand();
    const item: ItemOf<"tool_call"> = {
      id: "tool1",
      sessionId: "s1",
      turnId: "t1",
      kind: "tool_call",
      status: "completed",
      rev: 1,
      createdAt: 1,
      updatedAt: 1,
      content: {
        toolCallId: "call1",
        title: "List repo layout and read key docs",
        toolKind: "execute",
        locations: [],
        content: [{ type: "content", content: { type: "text", text: "```console\nREADME.md\n```" } }],
      },
    };
    const { container } = render(
      <ItemView
        ctx={{ workspaceId: "w1", sessionId: "s1", agent: "claude", writable: true, canRevert: false }}
        item={item}
        turn={undefined}
      />,
    );
    const trigger = screen.getByRole("button", { name: /List repo layout/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("pre code")?.textContent).toBe("README.md");
    fireEvent.click(trigger);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders fenced command output as code without literal Markdown fences", () => {
    const { container } = render(
      <BlockViewer
        workspaceId="w1"
        block={{ kind: "text", text: "```console\nAGENTS.md\nREADME.md\n```" }}
        monospace
        markdown
        streaming
      />,
    );
    expect(container.querySelector("pre code")?.textContent).toBe("AGENTS.md\nREADME.md");
    expect(container.textContent).not.toContain("```");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });

  it("keeps unfenced terminal output literal and strips ANSI escapes", () => {
    const text = "\u001b[32m# heading\u001b[0m\n* literal glob\n  indented";
    const { container } = render(
      <BlockViewer workspaceId="w1" block={{ kind: "text", text }} monospace markdown />,
    );
    expect(container.querySelector("pre")?.textContent).toBe("# heading\n* literal glob\n  indented");
    expect(container.querySelector("h1, ul")).toBeNull();
  });

  it("renders tool prose with GitHub Markdown and safe HTML handling", () => {
    const { container } = render(
      <BlockViewer
        workspaceId="w1"
        block={{ kind: "text", text: "**Done**\n\n- [x] Read docs\n\n<script>alert(1)</script>" }}
        markdown
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("Done");
    expect(container.querySelector('input[type="checkbox"]')).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });
});
