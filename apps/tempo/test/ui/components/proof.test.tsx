import { detail } from "../fixtures";
import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChecklistItem, ProofContent } from "@tempo/protocol";
import { beforeEach, expect, it } from "vitest";
import { AddToChecklist, ProofCard } from "../../../src/ui/components/chat/ProofCard";

const W = detail().id;

const item = (over: Partial<ChecklistItem>): ChecklistItem => ({
  id: "c1",
  text: "Use the theme's input style",
  status: "open",
  sourceItemId: "m1",
  resolvedBy: null,
  createdAt: 1,
  ...over,
});

const proof: ProofContent = {
  proofId: "p1",
  summary: "Todos have a due date.",
  screens: [
    {
      route: "/todos",
      viewport: "phone",
      theme: "dark",
      artifactId: "a1",
      version: 2,
      recordingArtifactId: null,
    },
  ],
  checks: [
    { name: "typecheck", runId: "r1", status: "passed", exitCode: 0 },
    { name: "test", runId: "r2", status: "failed", exitCode: 1 },
  ],
  resolved: [{ checklistId: "c1", note: "Uses the input style." }],
  missingRoutes: ["/settings"],
  missingChecklist: ["c2"],
  status: "incomplete",
};

beforeEach(() => {
  environment.request.mockReset();
  environment.request.mockResolvedValue({});
});

it("shows what a proof is missing and reopens an item it resolved (13, L-ADR-2)", async () => {
  environment.setState({
    workspace: detail({
      checklist: [
        item({ status: "resolved", resolvedBy: "p1" }),
        item({ id: "c2", text: "Align the title", sourceItemId: "m2" }),
      ],
    }),
  });
  render(<ProofCard workspaceId={W} proof={proof} writable />, { wrapper: environment.Provider });

  const card = screen.getByRole("region", { name: "Proof" });
  expect(card.textContent).toContain("Proof incomplete");
  expect(card.textContent).toContain("test: failed (exit 1)");
  expect(card.textContent).toContain("No screen for: /settings");
  expect(card.textContent).toContain("Align the title");
  expect(screen.getByRole("img", { name: "/todos, phone, dark" })).toBeTruthy();

  fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("reopenChecklistItem", {
      workspaceId: W,
      checklistId: "c1",
    }),
  );
});

it("adds a message to the checklist once", async () => {
  environment.setState({ workspace: detail({ checklist: [item({})] }) });
  render(
    <>
      <AddToChecklist workspaceId={W} itemId="m1" />
      <AddToChecklist workspaceId={W} itemId="m9" />
    </>,
    { wrapper: environment.Provider },
  );

  expect(screen.getByText("On checklist")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add to checklist" }));
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("addChecklistItem", { workspaceId: W, itemId: "m9" }),
  );
});
