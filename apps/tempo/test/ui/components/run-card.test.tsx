import { getWorkspaceUi } from "../../../src/ui/state/workspace-ui";
import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Schema } from "effect";
import { Run } from "@tempo/protocol";
import runFixture from "../../../../../packages/protocol/fixtures/types/Run.jsonl?raw";
import { createElement } from "react";
import { beforeEach, expect, it } from "vitest";
import { RunCard } from "../../../src/ui/components/chat/RunCard";
import { openSessionIds, closedSessions } from "../../../src/ui/components/chat/chat-tabs-model";
import { emptyWorkspaceState } from "../../../src/ui/stores/workspace-state";
import { detail, session } from "../fixtures";

const source = Schema.decodeUnknownSync(Run)(JSON.parse(runFixture.trim()));

beforeEach(() => localStorage.clear());

it("renders plan approval, a tree warning and its pin revert, and keeps run sessions out of chat menus", async () => {
  const run: Run = {
    ...source,
    outputKind: "plan",
    status: "completed",
    originSessionId: source.originSessionId,
    warning: "files_changed",
    pinCheckpointId: source.triggerEventId,
    result: {
      status: "done",
      summary: "Build auth",
      steps: [{ text: "Validate tokens", files: ["auth.ts"] }],
      verify: "Run tests",
    },
  };

  const user = session();
  const activeRun = session({ id: "run-chat", runId: run.id });
  const closedRun = session({ id: "old-run", runId: run.id, status: "closed" });
  environment.setState({
    ...emptyWorkspaceState,
    ready: true,
    workspace: detail(),
    runs: { [run.id]: run },
    sessions: { s1: user, "run-chat": activeRun, "old-run": closedRun },
  });
  environment.request.mockImplementation(async (name) => (name === "listRuns" ? [run] : {}));

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RunCard, { workspaceId: "card-w", runId: run.id, canRevert: true }),
    ),
    { wrapper: environment.Provider },
  );
  expect(await screen.findByText("This read-only agent changed files.")).toBeTruthy();
  expect(screen.getByText(/Validate tokens/)).toBeTruthy();
  expect(screen.getByText("Verify: Run tests")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revert" }));
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("revertToCheckpoint", {
      workspaceId: "card-w",
      checkpointId: source.triggerEventId,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("sendRunToChat", {
      workspaceId: "card-w",
      runId: run.id,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
  expect(getWorkspaceUi("card-w").activeToolKey).toBe(`runTranscript:${run.sessionId}`);
  expect(openSessionIds({ s1: user, "run-chat": activeRun })).toEqual(["s1"]);
  expect(closedSessions({ "old-run": closedRun })).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
});
