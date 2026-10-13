import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Artifact, ItemOf } from "@tempo/protocol";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactCard } from "../../../src/ui/components/artifacts/ArtifactCard";
import { ArtifactsView } from "../../../src/ui/components/artifacts/ArtifactsView";
import { MessageMarkdown } from "../../../src/ui/components/chat/Markdown";
import { renderMermaid } from "../../../src/ui/components/chat/mermaid";
import { FileTab } from "../../../src/ui/components/review/FileTab";
import { call } from "../../../src/ui/lib/api";
import { openArtifactTab } from "../../../src/ui/state/workspace-ui";

/** 04: artifact cards, the Artifacts tab, Mermaid diagrams and file tab previews. */

vi.mock("~/ui/lib/api", () => ({ call: vi.fn() }));
vi.mock("~/ui/hooks/useWorkspace", () => ({
  useWorkspaceSelector: (_id: string, select: (state: unknown) => unknown) =>
    select({
      workspace: { state: "ready" },
      changesSeq: 0,
      items: {},
      sessions: { s1: { title: "Fix login", agent: "claude" } },
    }),
}));
vi.mock("~/ui/hooks/useWorkspaceUi", () => ({
  useWorkspaceUiSelector: (_id: string, select: (state: unknown) => unknown) =>
    select({ tabs: [], activeKey: null }),
}));
vi.mock("~/ui/components/review/highlight", () => ({
  highlightFile: async () => null,
  splitLines: (text: string) => text.split("\n"),
}));
vi.mock("~/ui/components/chat/mermaid", () => ({ renderMermaid: vi.fn() }));
vi.mock("~/ui/state/workspace-ui", async (orig) => ({
  ...(await orig<typeof import("../../../src/ui/state/workspace-ui")>()),
  openArtifactTab: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const A = "01jart00000000000000000001";

const show = (child: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, child));
};

const item = (status: "pending" | "completed" | "failed", over: object = {}): ItemOf<"artifact"> => ({
  id: "i1",
  sessionId: "s1",
  turnId: "t1",
  kind: "artifact",
  status,
  rev: 1,
  createdAt: 1,
  updatedAt: 1,
  content: {
    artifactId: A,
    version: 2,
    title: "Login screen",
    summary: "After the fix",
    name: "login.png",
    path: "/workspace/login.png",
    mime: "image/png",
    artifactKind: "image",
    size: 2048,
    ...over,
  },
});

describe("artifact card", () => {
  it("shows title, version, name, size, summary and a thumbnail; a click or Enter opens the tab", () => {
    show(createElement(ArtifactCard, { workspaceId: "w1", item: item("completed") }));
    expect(screen.getByText("Login screen")).toBeDefined();
    expect(screen.getByText("v2")).toBeDefined();
    expect(screen.getByText("login.png · 2.0 KiB")).toBeDefined();
    expect(screen.getByText("After the fix")).toBeDefined();
    expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/workspaces/w1/artifacts/${A}/2`);
    const card = screen.getByRole("button", { name: "Artifact: Login screen" });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(openArtifactTab).toHaveBeenCalledTimes(2);
    expect(openArtifactTab).toHaveBeenCalledWith("w1", A, 2);
  });

  it("pending shows Saving; failed shows the lost text; neither opens", () => {
    const { unmount } = show(createElement(ArtifactCard, { workspaceId: "w1", item: item("pending") }));
    expect(screen.getByText("Saving")).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("group", { name: "Artifact: Login screen" }));
    unmount();
    show(createElement(ArtifactCard, { workspaceId: "w1", item: item("failed", { version: 1 }) }));
    expect(screen.getByText("This artifact was lost before it was saved.")).toBeDefined();
    expect(screen.queryByText("v1")).toBeNull();
    fireEvent.click(screen.getByRole("group", { name: "Artifact: Login screen" }));
    expect(openArtifactTab).not.toHaveBeenCalled();
  });
});

const artifact = (version: number, createdAt: number): Artifact => ({
  id: A,
  version,
  sessionId: "s1",
  turnId: null,
  itemId: `i${version}`,
  path: "/workspace/plan.md",
  name: "plan.md",
  title: "Plan",
  summary: null,
  mime: "text/markdown",
  kind: "markdown",
  size: 10,
  sha256: "x",
  status: "ready",
  createdAt,
});

describe("Artifacts tab", () => {
  it("shows the empty state", async () => {
    vi.mocked(call).mockResolvedValue([]);
    show(createElement(ArtifactsView, { workspaceId: "w1" }));
    await screen.findByText("No artifacts yet. Agents publish them with publish_artifact.");
    expect(call).toHaveBeenCalledWith("listArtifacts", { workspaceId: "w1" });
  });

  it("one row per artifact with the newest version and the chat title; older versions in the menu", async () => {
    vi.mocked(call).mockResolvedValue([artifact(2, 2), artifact(1, 1)]);
    show(createElement(ArtifactsView, { workspaceId: "w1" }));
    await screen.findByText("Plan");
    expect(screen.getAllByText("Plan")).toHaveLength(1);
    expect(screen.getByText("v2")).toBeDefined();
    expect(screen.getByText("Fix login")).toBeDefined();
    fireEvent.click(screen.getByText("Plan"));
    expect(openArtifactTab).toHaveBeenCalledWith("w1", A, null);
    expect(screen.getByRole("button", { name: "Versions of Plan" })).toBeDefined();
  });
});

describe("Mermaid in Markdown", () => {
  const md = (streaming: boolean) =>
    show(
      createElement(MessageMarkdown, {
        workspaceId: "w1",
        text: "```mermaid\ngraph TD; A-->B\n```",
        streaming,
      }),
    );

  it("renders a diagram only through <img>", async () => {
    vi.mocked(renderMermaid).mockResolvedValue("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
    const { container } = md(false);
    const img = await screen.findByRole("img", { name: "Diagram" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(container.querySelector("svg:not([aria-hidden])")).toBeNull();
    expect(renderMermaid).toHaveBeenCalledWith("graph TD; A-->B", false);
  });

  it("keeps the code block while streaming, and under a failure says so", async () => {
    md(true);
    expect(screen.getByText("graph TD; A-->B")).toBeDefined();
    expect(renderMermaid).not.toHaveBeenCalled();
    vi.mocked(renderMermaid).mockRejectedValue(new Error("bad"));
    md(false);
    await screen.findByText("Diagram failed to render.");
  });
});

describe("file tab previews", () => {
  const tab = (path: string) =>
    show(
      createElement(FileTab, {
        workspaceId: "w1",
        active: true,
        tab: { kind: "file", path, line: null },
        seq: 1,
      }),
    );

  it("shows a PNG as an image from the base64 content", async () => {
    vi.mocked(call).mockResolvedValue({ content: "iVBORw0KGgo=", encoding: "base64", size: 8 });
    tab("logo.png");
    const img = await screen.findByRole("img", { name: "logo.png" });
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("Markdown has Source and Preview; SVG shows source with a Preview through <img>", async () => {
    vi.mocked(call).mockResolvedValue({ content: "# Title\n", encoding: "utf8", size: 8 });
    const { unmount } = tab("README.md");
    await screen.findByRole("heading", { name: "Title" });
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    await screen.findByText("# Title");
    unmount();
    vi.mocked(call).mockResolvedValue({ content: "<svg/>", encoding: "utf8", size: 6 });
    tab("icon.svg");
    await screen.findByText("<svg/>");
    fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "icon.svg" }).getAttribute("src")).toMatch(
        /^data:image\/svg\+xml/,
      ),
    );
  });
});
