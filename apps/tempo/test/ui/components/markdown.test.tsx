import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { MessageMarkdown } from "../../../src/ui/components/chat/Markdown";
import { getWorkspaceUi, resetUiState } from "../../../src/ui/state/workspace-ui";

beforeEach(resetUiState);

const markdown = (text: string) =>
  render(createElement(MessageMarkdown, { workspaceId: "w1", text, streaming: true }));

describe("agent Markdown (04, 05)", () => {
  it("renders remote images as explicit links without image elements", () => {
    const { container } = markdown("![Preview](https://example.com/tracker.png)");
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "Preview" });
    expect(link.getAttribute("href")).toBe("https://example.com/tracker.png");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows raw HTML as text without creating executable elements", () => {
    const text = '<script>alert(1)</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)">';
    const { container } = markdown(text);
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("<img");
  });

  it("rejects executable link schemes", () => {
    const { container } = markdown("[Run](javascript:alert%281%29)");
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("Run")).toBeTruthy();
  });

  it.each(["%FF", "%00", "../etc/passwd", "%2e%2e/etc/passwd", "src//main.ts"])(
    "ignores an invalid workspace file link: %s",
    (path) => {
      const { container } = markdown(`[Source](file:///workspace/${path})`);
      expect(container.querySelector("a, button")).toBeNull();
      expect(getWorkspaceUi("w1").tabs).toEqual([]);
      expect(screen.getByText("Source")).toBeTruthy();
    },
  );

  it("opens workspace file links in the file panel", () => {
    markdown("[Source](file:///workspace/src/main.ts#L12)");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(getWorkspaceUi("w1").tabs[0]?.tab).toEqual({ kind: "file", path: "src/main.ts", line: 12 });
  });
});
