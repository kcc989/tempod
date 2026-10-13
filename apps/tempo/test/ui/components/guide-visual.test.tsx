import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_CSP, Comparison, GuideVisual } from "../../../src/ui/components/review/GuideVisual";
import { useCallQuery } from "../../../src/ui/hooks/useCall";
import { openDiff } from "../../../src/ui/state/workspace-ui";

vi.mock("~/ui/state/workspace-ui", () => ({ openDiff: vi.fn(), openFile: vi.fn() }));
vi.mock("~/ui/hooks/useCall", () => ({ useCallQuery: vi.fn() }));

describe("guide visuals", () => {
  it("switches the before/after comparison without leaving the chapter", () => {
    render(createElement(Comparison, { workspaceId: "w1", before: "Database read", after: "Cache read" }));
    expect(screen.getByText("Database read")).toBeTruthy();
    expect(screen.getByText("Cache read")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "After" }));
    expect(screen.queryByText("Database read")).toBeNull();
    expect(screen.getByText("Cache read")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.getByText("Database read")).toBeTruthy();
    expect(screen.queryByText("Cache read")).toBeNull();
  });
  it("selects flow nodes and opens their code", () => {
    render(
      createElement(GuideVisual, {
        workspaceId: "w1",
        live: true,
        visual: {
          kind: "flow",
          title: "Request flow",
          nodes: [
            { id: "cache", label: "Cache", description: "Check a key." },
            { id: "db", label: "Database", description: "Fetch on a miss.", path: "src/db.ts" },
          ],
          edges: [{ from: "cache", to: "db", label: "miss" }],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    expect(screen.getByText("Fetch on a miss.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open diff: src/db.ts" }));
    expect(openDiff).toHaveBeenCalledWith("w1", "src/db.ts");
  });
  it("loads HTML only after opening and isolates executable content", () => {
    vi.mocked(useCallQuery).mockReturnValue({
      data: { content: "<script>window.test=1</script><button>Try it</button>", encoding: "utf8", size: 72 },
      isError: false,
    } as ReturnType<typeof useCallQuery>);
    const { container } = render(
      createElement(GuideVisual, {
        workspaceId: "w1",
        live: true,
        visual: { kind: "html", title: "Try the change", path: ".tempo/artifacts/demo.html" },
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(useCallQuery).toHaveBeenLastCalledWith(
      "readFile",
      { workspaceId: "w1", path: ".tempo/artifacts/demo.html" },
      { enabled: false, retry: false },
    );
    fireEvent.click(screen.getByRole("button", { name: "Open artifact" }));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain(ARTIFACT_CSP);
    expect(frame.getAttribute("srcdoc")!.indexOf(ARTIFACT_CSP)).toBeLessThan(
      frame.getAttribute("srcdoc")!.indexOf("<script>"),
    );
    expect(container.querySelector("script")).toBeNull();
  });
  it("uses inline image data and refuses SVG artifacts", () => {
    vi.mocked(useCallQuery).mockReturnValue({
      data: { content: "aW1hZ2U=", encoding: "base64", size: 5 },
      isError: false,
    } as ReturnType<typeof useCallQuery>);
    const props = {
      workspaceId: "w1",
      live: true,
      visual: { kind: "image" as const, title: "Screenshot", path: "demo.png" },
    };
    const view = render(createElement(GuideVisual, props));
    fireEvent.click(screen.getByRole("button", { name: "Open artifact" }));
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    view.rerender(createElement(GuideVisual, { ...props, visual: { ...props.visual, path: "demo.svg" } }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("unsupported");
  });
});
