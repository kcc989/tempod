import { elementOf } from "../elements.ts";
import { createUiEnvironment, requestInput } from "../environment";
import { detail, session, turn } from "../fixtures";
import { TempoError } from "@tempo/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { GuideTab } from "../../../src/ui/components/review/GuideTab";
import { getWorkspaceUi, openTab, resetUiState } from "../../../src/ui/state/workspace-ui";

const environment = createUiEnvironment();

const request = environment.request;

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

let dirty = false;

let hasUnpushedCommits = false;

let guideContent = "";

let missing = false;

beforeEach(() => {
  resetUiState();
  localStorage.clear();
  dirty = false;
  hasUnpushedCommits = false;
  missing = false;
  guideContent = JSON.stringify(guide);
  environment.setState({
    workspace: detail({ pushed: true, hasUnpushedCommits }),
    sessions: { s1: session() },
  });
  openTab("w1", { kind: "chat", sessionId: "s1" });
  request.mockClear();
  request.mockImplementation(async (name, input) => {
    if (name === "readFile") {
      if (missing) throw new TempoError("NOT_FOUND", "Missing");

      return { content: guideContent, encoding: "utf8", size: guideContent.length };
    }

    if (name === "listReviewComments") return [];

    if (name === "sendPrompt") return turn({ status: "queued", queuePos: 1 });

    if (name === "createPullRequest") return { number: 42, url: "https://github.com/acme/repo/pull/42" };

    if (name === "getFileDiff") {
      const { path } = requestInput(name, input);

      return {
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old value\n+updated ${path}\n`,
      };
    }

    if (name === "getChanges") {
      const { scope } = requestInput(name, input);

      return {
        baseSha: "base",
        headSha: "head",
        files:
          scope === "uncommitted"
            ? dirty
              ? [{ path: ".tempo/pr-guide.json", status: "modified", additions: 1, deletions: 1 }]
              : []
            : [
                { path: "src/cache.ts", status: "modified", additions: 10, deletions: 2 },
                { path: "src/db.ts", status: "modified", additions: 3, deletions: 4 },
                { path: "tests/cache.test.ts", status: "added", additions: 20, deletions: 0 },
              ],
      };
    }

    throw new Error(`Unhandled guide request: ${name}`);
  });
});

afterEach(resetUiState);

const show = () =>
  render(createElement(GuideTab, { workspaceId: "w1", tab: { kind: "guide" }, active: true, seq: 1 }), {
    wrapper: environment.Provider,
  });

describe("guided PR review", () => {
  it("navigates chapters with their live diffs and keeps omitted and missing files reachable", async () => {
    show();
    expect(
      await within(await screen.findByRole("region", { name: "src/cache.ts" })).findByText(
        "updated src/cache.ts",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await within(await screen.findByRole("region", { name: "src/db.ts" })).findByText("updated src/db.ts"),
    ).toBeTruthy();
    expect(screen.getByText(/src\/removed.ts: not in the current branch diff/)).toBeTruthy();
    fireEvent.click(screen.getByText("Files outside guide (1)"));
    fireEvent.click(screen.getByRole("button", { name: "tests/cache.test.ts" }));
    expect(
      getWorkspaceUi("w1").tabs.some(
        (entry) => entry.tab.kind === "diff" && entry.tab.path === "tests/cache.test.ts",
      ),
    ).toBe(true);
  });
  it("asks the user's workspace agent to create a missing guide", async () => {
    missing = true;
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Create guide" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "sendPrompt",
        expect.objectContaining({
          workspaceId: "w1",
          sessionId: "s1",
          text: expect.stringContaining(".tempo/pr-guide.json"),
          mentions: [],
          attachmentIds: [],
          reviewCommentIds: [],
        }),
      ),
    );
    const call = request.mock.calls.find(([name]) => name === "sendPrompt");
    expect(call && requestInput("sendPrompt", call[1]).text).toContain("Inspect the actual diff");
    expect(request.mock.calls.some(([name]) => name === "createPullRequest")).toBe(false);
  });
  it("offers repair for malformed agent output", async () => {
    guideContent = JSON.stringify({ ...guide, version: 2 });
    show();
    expect(await screen.findByText("This guide is not valid.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Repair guide" }));
    await waitFor(() => expect(request.mock.calls.filter(([name]) => name === "sendPrompt")).toHaveLength(1));
  });
  it("creates a PR with the explanation and authenticated guide link", async () => {
    show();
    const button = await screen.findByRole("button", { name: "Create guided PR" });
    await waitFor(() => expect(elementOf(button, HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "createPullRequest",
        expect.objectContaining({
          workspaceId: "w1",
          title: guide.title,
          draft: false,
          body: expect.stringContaining("?guide=true"),
        }),
      ),
    );
    const call = request.mock.calls.find(([name]) => name === "createPullRequest");
    expect(call && requestInput("createPullRequest", call[1]).body).toContain(guide.summary);
  });
  it.each(["dirty", "unpushed"])("requires the guide to be committed and pushed: %s", async (state) => {
    dirty = state === "dirty";
    hasUnpushedCommits = state === "unpushed";
    environment.setState({
      workspace: detail({ pushed: true, hasUnpushedCommits }),
      sessions: { s1: session() },
    });
    show();
    const button = await screen.findByRole("button", { name: "Create guided PR" });
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([name, input]) =>
            name === "getChanges" && requestInput("getChanges", input).scope === "uncommitted",
        ),
      ).toBe(true),
    );
    expect(elementOf(button, HTMLButtonElement).disabled).toBe(true);
  });
});
