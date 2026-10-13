import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuideTab } from "../../../src/ui/components/review/GuideTab";
import { useCallMutation, useCallQuery } from "../../../src/ui/hooks/useCall";
import { useWorkspaceSelector } from "../../../src/ui/hooks/useWorkspace";
import { useWorkspaceUiSelector } from "../../../src/ui/hooks/useWorkspaceUi";
import { openDiff } from "../../../src/ui/state/workspace-ui";

vi.mock("~/ui/hooks/useCall", () => ({ useCallMutation: vi.fn(), useCallQuery: vi.fn() }));
vi.mock("~/ui/hooks/useWorkspace", () => ({ useWorkspaceSelector: vi.fn() }));
vi.mock("~/ui/hooks/useWorkspaceUi", () => ({ useWorkspaceUiSelector: vi.fn() }));
vi.mock("~/ui/hooks/useHub", () => ({ useHubWorkspace: () => ({ prState: null }) }));
vi.mock("~/ui/components/topbar/useWorkspaceActions", () => ({ copyText: vi.fn() }));
vi.mock("~/ui/components/review/use-review", () => ({
  useLive: () => true,
  useInvalidateOnChanges: vi.fn(),
  useReviewComments: () => ({ drafts: [] }),
}));
vi.mock("~/ui/components/review/DiffTab", () => ({ DraftsMenu: () => null, SendComments: () => null }));
vi.mock("~/ui/components/review/DiffFile", () => ({
  DiffFile: ({ file }: { file: { path: string } }) =>
    createElement("div", { "data-testid": "chapter-diff" }, file.path),
}));
vi.mock("~/ui/state/workspace-ui", async (original) => ({
  ...(await original<typeof import("../../../src/ui/state/workspace-ui")>()),
  openDiff: vi.fn(),
  openFile: vi.fn(),
}));

const send = vi.fn();
const createPr = vi.fn();
const guide = {
  version: 1,
  title: "Cache reads",
  summary: "Avoid repeated database reads.",
  before: "Always fetch.",
  after: "Cache repeated reads.",
  chapters: [
    {
      id: "lookup",
      title: "Read from cache",
      description: "Try the cache first.",
      files: ["src/cache.ts"],
      visuals: [{ kind: "comparison", title: "Read behavior", before: "Miss", after: "Hit" }],
    },
    {
      id: "fallback",
      title: "Handle misses",
      description: "Fetch only on a miss.",
      files: ["src/db.ts", "src/removed.ts"],
      visuals: [],
    },
  ],
};
const query = (data: unknown, error: Error | null = null) =>
  ({ data, error, isError: !!error, isFetching: false, refetch: vi.fn() }) as unknown as ReturnType<
    typeof useCallQuery
  >;
let fileQuery: ReturnType<typeof useCallQuery>;
let dirty = false;
let hasUnpushedCommits = false;

beforeEach(() => {
  dirty = false;
  hasUnpushedCommits = false;
  fileQuery = query({ content: JSON.stringify(guide), encoding: "utf8", size: 1024 });
  vi.mocked(useCallMutation).mockImplementation(
    (name) =>
      ({ mutate: name === "sendPrompt" ? send : createPr, isPending: false }) as unknown as ReturnType<
        typeof useCallMutation
      >,
  );
  vi.mocked(useCallQuery).mockImplementation((name, input) => {
    if (name === "readFile") return fileQuery;
    return query({
      files:
        "scope" in input && input.scope === "uncommitted"
          ? dirty
            ? [{ path: ".tempo/pr-guide.json" }]
            : []
          : [
              { path: "src/cache.ts", status: "modified", additions: 10, deletions: 2 },
              { path: "src/db.ts", status: "modified", additions: 3, deletions: 4 },
              { path: "tests/cache.test.ts", status: "added", additions: 20, deletions: 0 },
            ],
    });
  });
  vi.mocked(useWorkspaceSelector).mockImplementation((_id, select) =>
    select({
      sessions: { s1: { id: "s1", status: "idle" } },
      turns: {},
      changesSeq: 0,
      workspace: { pushed: true, hasUnpushedCommits },
    } as never),
  );
  vi.mocked(useWorkspaceUiSelector).mockImplementation((_id, select) =>
    select({ tabs: [], activeKey: null, lastChatSessionId: "s1" } as never),
  );
});

const show = () =>
  render(createElement(GuideTab, { workspaceId: "w1", tab: { kind: "guide" }, active: true, seq: 1 }));

describe("guided PR review", () => {
  it("navigates chapters with their live diffs and keeps omitted and missing files reachable", () => {
    show();
    expect(screen.getByTestId("chapter-diff").textContent).toBe("src/cache.ts");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("chapter-diff").textContent).toBe("src/db.ts");
    expect(screen.getByText(/src\/removed.ts: not in the current branch diff/)).toBeTruthy();
    fireEvent.click(screen.getByText("Files outside guide (1)"));
    fireEvent.click(screen.getByRole("button", { name: "tests/cache.test.ts" }));
    expect(openDiff).toHaveBeenCalledWith("w1", "tests/cache.test.ts");
  });
  it("asks the user's workspace agent to create a missing guide", () => {
    fileQuery = query(undefined, Object.assign(new Error("Missing"), { code: "NOT_FOUND" }));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Create guide" }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        sessionId: "s1",
        text: expect.stringContaining(".tempo/pr-guide.json"),
        mentions: [],
        attachmentIds: [],
        reviewCommentIds: [],
      }),
    );
    expect(send.mock.calls[0]![0].text).toContain("Inspect the actual diff");
    expect(createPr).not.toHaveBeenCalled();
  });
  it("offers repair for malformed agent output", () => {
    fileQuery = query({ content: JSON.stringify({ ...guide, version: 2 }), encoding: "utf8", size: 1024 });
    show();
    expect(screen.getByText("This guide is not valid.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Repair guide" }));
    expect(send).toHaveBeenCalledOnce();
  });
  it("creates a PR with the explanation and authenticated guide link", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Create guided PR" }));
    expect(createPr).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        title: guide.title,
        draft: false,
        body: expect.stringContaining("?guide=true"),
      }),
    );
    expect(createPr.mock.calls[0]![0].body).toContain(guide.summary);
  });
  it.each(["dirty", "unpushed"])("requires the guide to be committed and pushed: %s", (state) => {
    dirty = state === "dirty";
    hasUnpushedCommits = state === "unpushed";
    show();
    expect((screen.getByRole("button", { name: "Create guided PR" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
