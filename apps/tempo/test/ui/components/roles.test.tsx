import { createUiEnvironment } from "../environment";
import { elementOf } from "../elements";
import type { RoleInfo, LifecycleLogEvent } from "@tempo/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RolesTab } from "../../../src/ui/components/dialogs/settings/RolesTab";
import { LifecycleEvents } from "../../../src/ui/components/dialogs/LifecycleEvents";

const environment = createUiEnvironment();

const call = environment.request;

const base = {
  name: "reviewer",
  scope: "builtin",
  sha: "a".repeat(64),
  description: "Review",
  agent: "other",
  access: "read-only",
  requestable: true,
  on: [],
  limits: { rounds: 1, continues: 2, timeout: "20m", tokens: 0 },
} satisfies RoleInfo;

const show = (child: React.ReactNode) => render(child, { wrapper: environment.Provider });

afterEach(() => vi.resetAllMocks());

describe("role controls", () => {
  it("edits user files, keeps builtin files read-only and displays precedence", async () => {
    call.mockImplementation(async (name) => {
      if (name === "listRoles") return [base, { ...base, scope: "user", name: "audit", shadowedBy: "repo" }];

      if (name === "getRoleText") return { text: "---\ndescription: Audit\nrequestable: true\n---\nAudit" };

      return { ...base, name: "custom", scope: "user" };
    });
    show(<RolesTab />);
    await screen.findByText("reviewer · builtin");
    fireEvent.click(screen.getByText("reviewer · builtin"));
    const field = await screen.findByLabelText("Role file");
    await waitFor(() => expect(elementOf(field, HTMLTextAreaElement).readOnly).toBe(true));
    expect(screen.queryByText("Save")).toBeNull();
    expect(screen.getByText("Shadowed by repo")).toBeTruthy();
    fireEvent.click(screen.getByText("Add role"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Role file"), {
      target: { value: "---\ndescription: Job\nrequestable: true\n---\nJob" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("putUserRole", {
        name: "custom",
        text: "---\ndescription: Job\nrequestable: true\n---\nJob",
      }),
    );
  });
  it("filters events by change and loads a selected trace and role filters", async () => {
    const event = {
      seq: 1,
      event: {
        id: "00000000000000000000000001",
        workspaceId: "00000000000000000000000002",
        occurredAt: 1,
        type: "agent.turn.ended",
        source: "agent",
        changeId: "00000000000000000000000003",
        dedupeKey: "test",
        payload: { status: "completed", stopReason: null },
      },
    } satisfies LifecycleLogEvent;

    call.mockImplementation(async (name) => {
      if (name === "listLifecycleEvents") return { events: [event], nextBeforeSeq: null };

      if (name === "getTrace") return { chain: [event], children: [], runs: [] };

      return [base];
    });
    show(<LifecycleEvents workspaceId="00000000000000000000000002" />);
    fireEvent.click(await screen.findByText(/agent.turn.ended/));
    await screen.findByText("Role filters");
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("getTrace", {
        workspaceId: "00000000000000000000000002",
        eventId: "00000000000000000000000001",
      }),
    );
    fireEvent.change(screen.getByLabelText("Filter events by change"), {
      target: { value: "00000000000000000000000003" },
    });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("listLifecycleEvents", {
        workspaceId: "00000000000000000000000002",
        changeId: "00000000000000000000000003",
        limit: 500,
      }),
    );
  });
});
