import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TempoError, type Environment, type Project } from "@tempo/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentProposalBanner } from "../../../src/ui/components/chat/EnvironmentProposals";
import { Confirm } from "../../../src/ui/components/dialogs/Confirm";
import { EnvironmentsTab } from "../../../src/ui/components/dialogs/settings/EnvironmentsTab";
import { ProjectTab } from "../../../src/ui/components/dialogs/settings/ProjectTab";
import { WorkspaceEnvironmentDialog } from "../../../src/ui/components/dialogs/WorkspaceEnvironmentDialog";
import { call } from "../../../src/ui/lib/api";
import { openDialog, resetUiState } from "../../../src/ui/state/workspace-ui";
import { detail } from "../fixtures";

vi.mock("~/ui/lib/api", () => ({ call: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/ui/components/dialogs/settings/useOpenWorkspace", () => ({ useOpenWorkspaceDetail: () => null }));
const fixture = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("~/ui/hooks/useWorkspace", () => ({
  useWorkspaceSelector: (_: string, select: (state: unknown) => unknown) => select(fixture.state),
}));

const staging: Environment = {
  id: "e1",
  name: "staging",
  egressPolicy: "allowlist",
  egressAllowlist: ["api.example.com"],
  secrets: [
    { name: "STRIPE_KEY", hosts: ["api.stripe.com"], set: true },
    { name: "PLAIN", hosts: [], set: false },
  ],
  injectors: [],
  createdAt: 1,
  updatedAt: 2,
};
const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  installationId: 1,
  repoId: 1,
  owner: "tempo",
  name: "web",
  defaultBranch: "main",
  settings: {},
  sortOrder: 0,
  environmentId: null,
  ...over,
});

let envs: Environment[];
let projects: Project[];

const show = (ui: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {ui}
      <Confirm />
    </QueryClientProvider>,
  );
};

/** Opens a Radix select and picks an option. */
const pick = async (trigger: HTMLElement, option: string) => {
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

beforeEach(() => {
  envs = [staging];
  projects = [project()];
  fixture.state = { workspace: detail() };
  vi.mocked(call).mockImplementation(async (name, input) => {
    if (name === "listEnvironments") return envs as never;
    if (name === "getCredentialStatus")
      return {
        claude: { set: false, updatedAt: null },
        codex: { set: false, updatedAt: null, lastRefresh: null },
        anthropic: { set: false, updatedAt: null },
        openai: { set: false, updatedAt: null },
        openrouter: { set: false, updatedAt: null },
      } as never;
    if (name === "listModels") return [] as never;
    if (name === "listProjects") return projects as never;
    if (name === "listProjectSecretNames") return { names: [] } as never;
    if (name === "createEnvironment")
      return { ...staging, id: "e2", name: (input as { name: string }).name, secrets: [] } as never;
    if (name === "updateEnvironment") return staging as never;
    if (name === "setProjectEnvironment")
      return project({ environmentId: (input as { environmentId: string | null }).environmentId }) as never;
    return {} as never;
  });
});
afterEach(resetUiState);

describe("Settings → Environments", () => {
  it("shows secret hints and never a value", async () => {
    show(<EnvironmentsTab />);
    await screen.findByRole("form", { name: "Environment staging" });
    expect(
      screen.getByText("Use $STRIPE_KEY in the app; Tempo adds the value for api.stripe.com"),
    ).toBeTruthy();
    expect(screen.getByText("Visible to the agent")).toBeTruthy();
    expect(screen.getByText("Set")).toBeTruthy();
    expect(screen.getByText("Not set")).toBeTruthy();
    expect((screen.getByLabelText("STRIPE_KEY value") as HTMLInputElement).value).toBe("");
  });

  it("creates an environment from a name", async () => {
    show(<EnvironmentsTab />);
    fireEvent.click(await screen.findByRole("button", { name: "New environment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New environment name" }), {
      target: { value: " prod " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("createEnvironment", { name: "prod" }));
  });

  it("shows a taken name inline", async () => {
    vi.mocked(call).mockImplementation(async (name) => {
      if (name === "listEnvironments") return envs as never;
      if (name === "getCredentialStatus")
        return {
          claude: { set: false, updatedAt: null },
          codex: { set: false, updatedAt: null, lastRefresh: null },
          anthropic: { set: false, updatedAt: null },
          openai: { set: false, updatedAt: null },
          openrouter: { set: false, updatedAt: null },
        } as never;
      if (name === "listModels") return [] as never;
      throw new TempoError("ENVIRONMENT_EXISTS");
    });
    show(<EnvironmentsTab />);
    fireEvent.click(await screen.findByRole("button", { name: "New environment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New environment name" }), {
      target: { value: "staging" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "An environment with this name already exists.",
    );
  });

  it("saves with updateEnvironment, then sends each filled value", async () => {
    show(<EnvironmentsTab />);
    await screen.findByRole("form", { name: "Environment staging" });
    fireEvent.change(screen.getByRole("textbox", { name: "Allowlist" }), {
      target: { value: "api.example.com\n*.cdn.example.com" },
    });
    fireEvent.change(screen.getByLabelText("PLAIN value"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove STRIPE_KEY" }));
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Secret 2 name" }), {
      target: { value: "gh_token" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "GH_TOKEN hosts" }), {
      target: { value: "api.github.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("setEnvironmentSecret", {
        environmentId: "e1",
        name: "PLAIN",
        value: "hunter2",
      }),
    );
    const names = vi.mocked(call).mock.calls.map((c) => c[0]);
    expect(names.indexOf("updateEnvironment")).toBeLessThan(names.indexOf("setEnvironmentSecret"));
    expect(call).toHaveBeenCalledWith("updateEnvironment", {
      environmentId: "e1",
      name: "staging",
      egressPolicy: "allowlist",
      egressAllowlist: ["api.example.com", "*.cdn.example.com"],
      secrets: [
        { name: "PLAIN", hosts: [] },
        { name: "GH_TOKEN", hosts: ["api.github.com"] },
      ],
      injectors: [],
    });
  });

  it("checks host patterns before saving", async () => {
    show(<EnvironmentsTab />);
    await screen.findByRole("form", { name: "Environment staging" });
    fireEvent.change(screen.getByRole("textbox", { name: "Allowlist" }), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(screen.getByText("Not a host pattern: https://example.com")).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith("updateEnvironment", expect.anything());
  });

  it("adds an injector with monospace code", async () => {
    show(<EnvironmentsTab />);
    await screen.findByRole("form", { name: "Environment staging" });
    fireEvent.click(screen.getByRole("button", { name: "Add injector" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Injector 1 name" }), { target: { value: "sign" } });
    fireEvent.change(screen.getByRole("textbox", { name: "sign hosts" }), {
      target: { value: "*.amazonaws.com" },
    });
    const code = screen.getByRole("textbox", { name: "sign code" });
    expect(code.className).toContain("font-mono");
    fireEvent.change(code, { target: { value: "export default { fetch: (r) => fetch(r) }" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "updateEnvironment",
        expect.objectContaining({
          injectors: [
            { name: "sign", hosts: ["*.amazonaws.com"], code: "export default { fetch: (r) => fetch(r) }" },
          ],
        }),
      ),
    );
  });

  it("deletes after the 04 confirmation", async () => {
    show(<EnvironmentsTab />);
    await screen.findByRole("form", { name: "Environment staging" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete environment staging?");
    expect(dialog.textContent).toContain("Projects that use it will use none.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("deleteEnvironment", { environmentId: "e1" }));
  });
});

describe("Project → Environment", () => {
  it("sets the project's environment at once and locks egress fields", async () => {
    const view = show(<ProjectTab projectId="p1" onProjectChange={() => {}} section="Environment" />);
    const select = await screen.findByRole("combobox", { name: "Environment" });
    expect(screen.queryByText("Set by environment staging")).toBeNull();
    await pick(select, "staging");
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("setProjectEnvironment", { projectId: "p1", environmentId: "e1" }),
    );
    projects = [project({ environmentId: "e1" })];
    view.unmount();
    show(<ProjectTab projectId="p1" onProjectChange={() => {}} section="Environment" />);
    await screen.findAllByText("Set by environment staging");
    const policy = screen.getByRole("group", { name: "Egress policy" });
    expect(within(policy).queryByRole("switch")).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "Egress allowlist" })).getByText("api.example.com"),
    ).toBeTruthy();
  });
});

describe("Environment… dialog", () => {
  it("offers the project default and every environment, and saves at once", async () => {
    projects = [project({ environmentId: "e1" })];
    show(<WorkspaceEnvironmentDialog />);
    act(() => openDialog({ kind: "environment", workspaceId: "w1" }));
    expect(
      await screen.findByText(
        "Changes apply to new requests within a minute. Scripts and agents started later get the new secrets.",
      ),
    ).toBeTruthy();
    const select = await screen.findByRole("combobox", { name: "Environment" });
    await waitFor(() => expect(select.textContent).toBe("Project default (staging)"));
    await pick(select, "staging");
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("setWorkspaceEnvironment", {
        workspaceId: "w1",
        environmentId: "e1",
      }),
    );
  });
});

describe("environment proposals", () => {
  const pending = {
    id: "prop1",
    createdAt: 1,
    proposal: {
      note: "Stripe calls are blocked.",
      allowlistAdd: ["api.stripe.com"],
      secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }],
      injectors: [{ name: "sign", hosts: ["api.stripe.com"], code: "export default {}" }],
    },
  };

  it("shows nothing without proposals", () => {
    show(<EnvironmentProposalBanner workspaceId="w1" />);
    expect(screen.queryByText("The agent suggests environment changes")).toBeNull();
  });

  it("reviews and applies the oldest proposal by creating an environment", async () => {
    envs = [];
    fixture.state = { workspace: detail({ environmentProposals: [pending] }) };
    show(<EnvironmentProposalBanner workspaceId="w1" />);
    expect(screen.getByText("The agent suggests environment changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Stripe calls are blocked.")).toBeTruthy();
    expect(within(dialog).getByLabelText("sign code").textContent).toBe("export default {}");
    expect(
      within(dialog).getByText("Injectors run with access to these secrets. Read the code before you apply."),
    ).toBeTruthy();
    await within(dialog).findByText("Create environment web and use it for this project");
    fireEvent.change(within(dialog).getByLabelText("STRIPE_KEY value"), { target: { value: "sk" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("resolveEnvironmentProposal", {
        workspaceId: "w1",
        proposalId: "prop1",
        status: "applied",
      }),
    );
    expect(
      vi
        .mocked(call)
        .mock.calls.map((c) => c[0])
        .filter((n) => !n.startsWith("list")),
    ).toEqual([
      "createEnvironment",
      "setProjectEnvironment",
      "updateEnvironment",
      "setEnvironmentSecret",
      "resolveEnvironmentProposal",
    ]);
    expect(call).toHaveBeenCalledWith("setEnvironmentSecret", {
      environmentId: "e2",
      name: "STRIPE_KEY",
      value: "sk",
    });
  });

  it("applies to the effective environment and dismisses", async () => {
    projects = [project({ environmentId: "e1" })];
    fixture.state = { workspace: detail({ environmentProposals: [pending] }) };
    show(<EnvironmentProposalBanner workspaceId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Apply to staging");
    expect(within(dialog).queryByLabelText("STRIPE_KEY value")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("resolveEnvironmentProposal", {
        workspaceId: "w1",
        proposalId: "prop1",
        status: "dismissed",
      }),
    );
  });
});
