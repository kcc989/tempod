import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RolesTab } from "../../../src/ui/components/dialogs/settings/RolesTab";
import { LifecycleEvents } from "../../../src/ui/components/dialogs/LifecycleEvents";
import { call } from "../../../src/ui/lib/api";
vi.mock("~/ui/lib/api", () => ({ call: vi.fn() }));
vi.mock("~/ui/components/dialogs/settings/useOpenWorkspace", () => ({ useOpenWorkspaceDetail: () => null }));
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
};
const show = (child: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {child}
    </QueryClientProvider>,
  );
afterEach(() => vi.resetAllMocks());
describe("role controls", () => {
  it("edits user files, keeps builtin files read-only and displays precedence", async () => {
    vi.mocked(call).mockImplementation(async (name) =>
      name === "listRoles"
        ? [base, { ...base, scope: "user", name: "audit", shadowedBy: "repo" }]
        : name === "getRoleText"
          ? { text: "---\ndescription: Audit\nrequestable: true\n---\nAudit" }
          : ({ ...base, name: "custom", scope: "user" } as any),
    );
    show(<RolesTab />);
    await screen.findByText("reviewer · builtin");
    fireEvent.click(screen.getByText("reviewer · builtin"));
    const field = await screen.findByLabelText("Role file");
    await waitFor(() => expect((field as HTMLTextAreaElement).readOnly).toBe(true));
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
      event: { id: "event1", type: "agent.turn.ended", source: "agent", changeId: "change1" },
    };
    vi.mocked(call).mockImplementation(async (name) =>
      name === "listLifecycleEvents"
        ? { events: [event], nextBeforeSeq: null }
        : name === "getTrace"
          ? { chain: [event], children: [], runs: [] }
          : ([base] as any),
    );
    show(<LifecycleEvents workspaceId="workspace1" />);
    fireEvent.click(await screen.findByText(/agent.turn.ended/));
    await screen.findByText("Role filters");
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("getTrace", { workspaceId: "workspace1", eventId: "event1" }),
    );
    fireEvent.change(screen.getByLabelText("Filter events by change"), { target: { value: "change1" } });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("listLifecycleEvents", {
        workspaceId: "workspace1",
        changeId: "change1",
        limit: 500,
      }),
    );
  });
});
