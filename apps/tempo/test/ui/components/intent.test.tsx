import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IntentContent } from "@tempo/protocol";
import { expect, it } from "vitest";
import { IntentCard } from "../../../src/ui/components/chat/IntentCard";
import { TypeSafeSection } from "../../../src/ui/components/dialogs/settings/TypeSafeSection";

const intent: IntentContent = {
  intentId: "i1",
  status: "proposed",
  goal: "Add a due date to todos",
  approach: "A nullable column and a picker",
  notDoing: "No reminders",
  decidedBy: null,
  reasons: ["hard_rollback"],
  enforced: false,
};

it("shows the intent with the judge's reason, confirms with ⌘↩ and sends a correction (13, L-ADR-1)", async () => {
  environment.request.mockResolvedValue({});
  render(<IntentCard workspaceId="w1" intent={intent} writable />, { wrapper: environment.Provider });

  const card = screen.getByRole("region", { name: "Intent" });
  expect(card.textContent).toContain("GoalAdd a due date to todos");
  expect(card.textContent).toContain("Asking you because: it is hard to roll back");
  expect(card.textContent).not.toContain("read-only");

  fireEvent.keyDown(card, { key: "Enter", metaKey: true });
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("confirmIntent", { workspaceId: "w1", intentId: "i1" }),
  );

  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Keep the due date optional" } });
  fireEvent.click(screen.getByRole("button", { name: "Send correction" }));
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("correctIntent", {
      workspaceId: "w1",
      intentId: "i1",
      text: "Keep the due date optional",
    }),
  );
});

it("shows a judge-confirmed intent without actions", () => {
  render(
    <IntentCard
      workspaceId="w1"
      intent={{ ...intent, status: "confirmed", decidedBy: "judge", enforced: true }}
      writable
    />,
    {
      wrapper: environment.Provider,
    },
  );

  expect(screen.getByRole("region", { name: "Intent" }).textContent).toContain(
    "Intent confirmed by Tempo (low risk)",
  );
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});

it("saves the TypeSafe AI key and shows a refused key in place (13, L-ADR-9)", async () => {
  environment.request.mockImplementation(async (name) => {
    if (name === "getJudgeSettings") return { keySet: false, updatedAt: null };

    if (name === "setJudgeKey") {
      const { TempoError } = await import("@tempo/protocol");

      throw new TempoError("VALIDATION_FAILED", undefined, "TypeSafe AI did not accept the key.");
    }

    return {};
  });
  render(<TypeSafeSection />, { wrapper: environment.Provider });

  fireEvent.change(await screen.findByLabelText("TypeSafe AI key"), { target: { value: "bad-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("TypeSafe AI did not accept the key.");
  expect(environment.request).toHaveBeenCalledWith("setJudgeKey", { key: "bad-key" });
});

it("saves the project profile and shows the first problem in place (13, L-ADR-3)", async () => {
  const { ProjectProfileEditor } =
    await import("../../../src/ui/components/dialogs/settings/ProjectProfileEditor");

  const { TempoError } = await import("@tempo/protocol");

  environment.request.mockImplementation(async (name, input) => {
    if (name === "getProjectProfile")
      return { projectId: "p1", revision: 2, source: "version: 1\n", updatedAt: 1 };

    if (name === "updateProjectProfile")
      throw new TempoError("PROFILE_INVALID", undefined, "version: must be 1");

    return input;
  });
  render(<ProjectProfileEditor projectId="p1" />, { wrapper: environment.Provider });

  fireEvent.change(await screen.findByLabelText("Profile YAML"), { target: { value: "version: 2\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  expect((await screen.findByRole("alert")).textContent).toBe("version: must be 1");
  expect(environment.request).toHaveBeenCalledWith("updateProjectProfile", {
    projectId: "p1",
    source: "version: 2\n",
    revision: 2,
  });
});

it("turns the intent check off for one chat with the owner's switch (13, L-ADR-1)", async () => {
  const { IntentCheckToggle } = await import("../../../src/ui/components/chat/ComposerParts");
  const { session } = await import("../fixtures");

  environment.request.mockResolvedValue({});

  const { rerender } = render(
    <IntentCheckToggle workspaceId="w1" session={session({ id: "s1", intentCheck: true })} />,
    { wrapper: environment.Provider },
  );

  const toggle = screen.getByRole("button", { name: "Intent check: On" });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("setIntentCheck", {
      workspaceId: "w1",
      sessionId: "s1",
      enabled: false,
    }),
  );

  rerender(<IntentCheckToggle workspaceId="w1" session={session({ id: "s1", runId: "r1" })} />);
  expect(screen.queryByRole("button", { name: /Intent check/ })).toBeNull();
});
