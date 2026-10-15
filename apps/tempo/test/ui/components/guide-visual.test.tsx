import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_CSP, Comparison, GuideVisual } from "../../../src/ui/components/review/GuideVisual";

import { getWorkspaceUi, resetUiState } from "../../../src/ui/state/workspace-ui";

beforeEach(resetUiState);

describe("guide visuals", () => {
  it("switches the before/after comparison without leaving the chapter", () => {
    render(createElement(Comparison, { workspaceId: "w1", before: "Database read", after: "Cache read" }), {
      wrapper: environment.Provider,
    });
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
        source: { kind: "workspace" as const, workspaceId: "w1", live: true },
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
      { wrapper: environment.Provider },
    );
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    expect(screen.getByText("Fetch on a miss.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open diff: src/db.ts" }));
    expect(getWorkspaceUi("w1").tabs.map((entry) => entry.tab)).toEqual([
      { kind: "diff", path: "src/db.ts" },
    ]);
  });
  it("loads HTML only after opening and isolates executable content", async () => {
    call.mockResolvedValue({
      content: "<script>window.test=1</script><button>Try it</button>",
      encoding: "utf8",
      size: 72,
    });

    const { container } = render(
      createElement(GuideVisual, {
        source: { kind: "workspace" as const, workspaceId: "w1", live: true },
        visual: { kind: "html", title: "Try the change", path: ".tempo/artifacts/demo.html" },
      }),
      { wrapper: environment.Provider },
    );

    expect(container.querySelector("iframe")).toBeNull();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open artifact" }));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(call).toHaveBeenCalledWith("readFile", { workspaceId: "w1", path: ".tempo/artifacts/demo.html" });
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain(ARTIFACT_CSP);
    expect(frame.getAttribute("srcdoc")!.indexOf(ARTIFACT_CSP)).toBeLessThan(
      frame.getAttribute("srcdoc")!.indexOf("<script>"),
    );
    expect(container.querySelector("script")).toBeNull();
  });
  it("uses inline image data and refuses SVG artifacts", async () => {
    call.mockResolvedValue({ content: "aW1hZ2U=", encoding: "base64", size: 5 });

    const props = {
      source: { kind: "workspace" as const, workspaceId: "w1", live: true },
      visual: { kind: "image" as const, title: "Screenshot", path: "demo.png" },
    };

    const view = render(createElement(GuideVisual, props), { wrapper: environment.Provider });
    fireEvent.click(screen.getByRole("button", { name: "Open artifact" }));
    expect((await screen.findByRole("img")).getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    view.rerender(createElement(GuideVisual, { ...props, visual: { ...props.visual, path: "demo.svg" } }));
    expect(screen.queryByRole("img")).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("unsupported");
  });
});
