import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  TempoError,
  type DeployConfig,
  type DeploySettings,
  type Deployment,
  type ProductionError,
  type Project,
} from "@tempo/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareTab } from "~/ui/components/dialogs/settings/CloudflareTab";
import { RepositoryHub } from "~/ui/components/repositories/RepositoryHub";
import { resetUiState, settingsStore } from "~/ui/state/workspace-ui";
import { elementOf } from "../elements";
import { createUiEnvironment, requestInput } from "../environment";

const project: Project = {
  id: "p1",
  provider: "artifacts",
  installationId: null,
  repoId: null,
  artifactRepoId: "a1",
  cloneUrl: "https://git.test/demo.git",
  owner: "tempo",
  name: "demo",
  defaultBranch: "main",
  settings: {},
  sortOrder: 0,
};

const deployment: Deployment = {
  id: "d1",
  projectId: "p1",
  number: 4,
  target: "production",
  stage: "prod",
  branch: "main",
  sha: "abcdef0123456789abcdef0123456789abcdef01",
  revision: 3,
  trigger: "manual",
  status: "running",
  conclusion: null,
  exitCode: null,
  summary: null,
  workspaceId: null,
  createdAt: 1,
  startedAt: 1_000,
  completedAt: null,
  url: "/repositories?project=p1&tab=deploys&deployment=d1",
  rollout: null,
};

const config: DeployConfig = {
  projectId: "p1",
  revision: 3,
  source: "version: 1\ntool: alchemy\ntargets:\n  production:\n    branch: main\n  preview: {}\n",
  enabled: true,
  tool: "alchemy",
  root: "",
  permissions: ["workers"],
  timeoutMinutes: 20,
  egressAllowlist: [],
  targets: [
    {
      key: "production",
      stage: "prod",
      branch: "main",
      auto: true,
      agent: false,
      rollout: "full",
      workers: [],
      smoke: [],
    },
    {
      key: "preview",
      stage: "preview",
      branch: null,
      auto: false,
      agent: true,
      rollout: "full",
      workers: [],
      smoke: [],
    },
  ],
  autoFix: false,
  updatedAt: 1,
};

let environment = createUiEnvironment();

let current = deployment;

let settings: DeploySettings = { accountId: null, tokenSet: false, updatedAt: null };

let failure: TempoError | null = null;

let errors: ProductionError[] = [];

const show = (child: ReactNode) => render(child, { wrapper: environment.Provider });

const pick = async (combobox: string, option: string) => {
  fireEvent.click(await screen.findByRole("combobox", { name: combobox }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

beforeEach(() => {
  resetUiState();
  environment = createUiEnvironment();
  current = deployment;
  settings = { accountId: null, tokenSet: false, updatedAt: null };
  failure = null;
  errors = [];
  environment.request.mockImplementation(async (name, input) => {
    switch (name) {
      case "listProjects":
        return [project];
      case "listBranches":
        return [{ name: "main" }, { name: "feature" }];
      case "getDeployConfig":
        return config;
      case "listDeployments": {
        const { target } = requestInput("listDeployments", input);

        return target === "preview" ? [] : [current];
      }

      case "getDeployment":
        return current;
      case "listProductionErrors":
        return errors;
      case "startErrorFix":
        errors = errors.map((e) => ({ ...e, fixWorkspaceId: "w-fix" }));

        return { workspaceId: "w-fix" };
      case "getIssuesWebhook":
        return { url: "https://tempo.example.com/api/hooks/cloudflare-issues/p1", secretSet: false };
      case "rotateIssuesWebhook":
        return { url: "https://tempo.example.com/api/hooks/cloudflare-issues/p1", secret: "s3cr3t" };
      case "getDeploymentLog":
        return { text: "wrangler: uploaded", truncated: false };
      case "startDeployment": {
        if (failure) throw failure;
        const start = requestInput("startDeployment", input);

        return { ...deployment, id: "d2", target: start.target, branch: start.branch ?? "main" };
      }

      case "cancelDeployment":
        current = {
          ...current,
          status: "completed",
          conclusion: "cancelled",
          exitCode: 143,
          completedAt: 66_000,
        };

        return current;
      case "rollbackDeployment":
        current = {
          ...current,
          rollout: { ...current.rollout!, phase: "rolled_back", rolledBackAt: Date.now() },
        };

        return current;
      case "redeploy":
        return { ...current, id: "d3", trigger: "redeploy", status: "queued", conclusion: null };
      case "updateDeployConfig":
        if (failure) throw failure;

        return { ...config, revision: 4, source: requestInput("updateDeployConfig", input).source };
      case "getDeploySettings":
        return settings;
      case "updateDeploySettings":
        if (failure) throw failure;
        settings = {
          accountId: requestInput("updateDeploySettings", input).accountId,
          tokenSet: true,
          updatedAt: Date.now(),
        };

        return settings;
      case "deleteDeploySettings":
        settings = { accountId: null, tokenSet: false, updatedAt: null };

        return settings;
      default:
        throw new Error("Unexpected request: " + name);
    }
  });
});

afterEach(resetUiState);

describe("repository deploys (12, Clients)", () => {
  it("lists and filters deployments and deploys a fixed or a picked branch", async () => {
    const navigate = vi.fn();
    show(<RepositoryHub search={{ project: "p1", tab: "deploys" }} onNavigate={navigate} />);

    const row = await screen.findByRole("button", { name: /#4 · production/ });
    expect(row.textContent).toContain("prod · main · abcdef0 · manual");
    expect(within(row).getByText("Running")).toBeTruthy();

    await pick("Filter deployments by target", "preview");
    await screen.findByText("No deployments yet.");
    expect(environment.request).toHaveBeenCalledWith("listDeployments", {
      projectId: "p1",
      offset: 0,
      target: "preview",
    });

    const deploy = elementOf(screen.getByRole("button", { name: "Deploy" }), HTMLButtonElement);
    expect(deploy.disabled).toBe(true);
    await pick("Target to deploy", "production");
    expect(screen.getByText("main", { selector: "code" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /Branch to deploy/ })).toBeNull();
    fireEvent.click(deploy);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ project: "p1", tab: "deploys", deployment: "d2" }),
    );
    expect(environment.request).toHaveBeenCalledWith("startDeployment", {
      projectId: "p1",
      target: "production",
    });

    await pick("Target to deploy", "preview");
    expect(deploy.disabled).toBe(true);
    await pick("Branch to deploy", "feature");
    fireEvent.click(deploy);
    await waitFor(() =>
      expect(environment.request).toHaveBeenCalledWith("startDeployment", {
        projectId: "p1",
        target: "preview",
        branch: "feature",
      }),
    );
  });

  it("shows why a deploy failed and links a missing account to Settings", async () => {
    show(<RepositoryHub search={{ project: "p1", tab: "deploys" }} onNavigate={vi.fn()} />);
    await pick("Target to deploy", "production");

    failure = new TempoError("DEPLOY_NOT_CONFIGURED");
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Add a deploy configuration for this repository first.",
    );
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();

    failure = new TempoError("DEPLOY_ACCOUNT_NOT_SET");
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    await screen.findByText("Add a Cloudflare account and token in Settings first.");
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(settingsStore.getSnapshot()).toEqual({ kind: "settings", tab: "cloudflare" });
  });

  it("shows deployment detail with its log, cancels while unfinished and redeploys when completed", async () => {
    const navigate = vi.fn();
    show(
      <RepositoryHub search={{ project: "p1", tab: "deploys", deployment: "d1" }} onNavigate={navigate} />,
    );

    await screen.findByText("Deployment #4");
    expect(await screen.findByText("wrangler: uploaded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Redeploy" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const redeploy = await screen.findByRole("button", { name: "Redeploy" });
    expect(environment.request).toHaveBeenCalledWith("cancelDeployment", {
      projectId: "p1",
      deploymentId: "d1",
    });
    const facts = screen.getByText("Exit code").closest("dl");
    expect(facts?.textContent).toContain("Exit code143");
    expect(facts?.textContent).toContain("ConclusionCancelled");
    expect(facts?.textContent).toContain("Duration1m 05s");

    fireEvent.click(redeploy);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ project: "p1", tab: "deploys", deployment: "d3" }),
    );
    expect(environment.request).toHaveBeenCalledWith("redeploy", { projectId: "p1", deploymentId: "d1" });
  });

  it("shows a gradual rollout's versions and rolls it back with one action (12, Gradual rollout)", async () => {
    current = {
      ...deployment,
      status: "completed",
      conclusion: "success",
      exitCode: 0,
      completedAt: 66_000,
      rollout: {
        phase: "promoted",
        canaryUntil: 60_000,
        rolledBackAt: null,
        workers: [
          {
            name: "app-web",
            versionId: "v2",
            previousVersionId: "v1",
            percentage: 100,
            cloudflareDeploymentId: "cf-9",
          },
        ],
      },
    };
    show(<RepositoryHub search={{ project: "p1", tab: "deploys", deployment: "d1" }} onNavigate={vi.fn()} />);

    const rollout = await screen.findByRole("region", { name: "Rollout" });
    expect(rollout.textContent).toContain("Promoted to 100%");
    expect(rollout.textContent).toContain("version v2 · previous v1 · Cloudflare deployment cf-9");

    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Rollout" }).textContent).toContain("Rolled back"),
    );
    expect(environment.request).toHaveBeenCalledWith("rollbackDeployment", {
      projectId: "p1",
      deploymentId: "d1",
    });
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
  });

  it("lists production errors, starts a fix and shows a new webhook secret once (12, Production errors)", async () => {
    errors = [
      {
        id: "e1",
        projectId: "p1",
        worker: "app-web",
        versionId: "v2",
        deploymentId: "d1",
        deploymentNumber: 4,
        title: "TypeError in app-web",
        text: "TypeError: x is undefined",
        occurrences: 3,
        firstSeenAt: Date.now() - 120_000,
        lastSeenAt: Date.now() - 60_000,
        fixWorkspaceId: null,
        fixedAt: null,
      },
    ];
    show(<RepositoryHub search={{ project: "p1", tab: "deploys" }} onNavigate={vi.fn()} />);

    const list = await screen.findByRole("region", { name: "Production errors" });
    expect(list.textContent).toContain("TypeError in app-web");
    expect(list.textContent).toContain("app-web · version v2 · 3 times");

    fireEvent.click(within(list).getByRole("button", { name: "Start fix" }));
    await waitFor(() => expect(environment.history.location.pathname).toBe("/w/w-fix"));
    expect(environment.request).toHaveBeenCalledWith("startErrorFix", { projectId: "p1", errorId: "e1" });

    const hook = await screen.findByRole("region", { name: "Production error webhook" });
    expect(hook.textContent).toContain("No secret yet.");
    fireEvent.click(within(hook).getByRole("button", { name: "New secret" }));
    expect((await within(hook).findByRole("status")).textContent).toBe("Secret (shown once): s3cr3t");
  });

  it("shows configuration problems in place and offers a reload for a stale revision", async () => {
    show(<RepositoryHub search={{ project: "p1", tab: "deploys" }} onNavigate={vi.fn()} />);
    const editor = await screen.findByLabelText("Configuration", { selector: "textarea" });
    expect(screen.getByText("Revision 3 · targets production, preview")).toBeTruthy();
    const save = elementOf(screen.getByRole("button", { name: "Save configuration" }), HTMLButtonElement);
    expect(save.disabled).toBe(true);

    failure = new TempoError("DEPLOY_CONFIG_INVALID", undefined, "targets.preview.auto: needs branch");
    fireEvent.change(editor, { target: { value: "version: 1\ntargets:\n  preview:\n    auto: true\n" } });
    fireEvent.click(save);
    expect((await screen.findByRole("alert")).textContent).toBe("targets.preview.auto: needs branch");

    failure = new TempoError("DEPLOY_CONFIG_CHANGED");
    fireEvent.click(save);
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(environment.request).toHaveBeenCalledWith("updateDeployConfig", {
      projectId: "p1",
      source: "version: 1\ntargets:\n  preview:\n    auto: true\n",
      revision: 3,
    });
    await waitFor(() =>
      expect(environment.request.mock.calls.filter(([name]) => name === "getDeployConfig")).toHaveLength(2),
    );
  });
});

describe("Cloudflare settings (12, Owner settings)", () => {
  it("saves the account with a write-only token, shows a rejected token in place and removes it", async () => {
    show(<CloudflareTab />);
    await screen.findByText("No token");
    const token = elementOf(screen.getByLabelText("API token"), HTMLInputElement);
    expect(token.type).toBe("password");
    fireEvent.change(screen.getByLabelText("Account ID"), {
      target: { value: "0123456789abcdef0123456789abcdef" },
    });
    fireEvent.change(token, { target: { value: " bad " } });

    failure = new TempoError("DEPLOY_TOKEN_INVALID");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Cloudflare did not accept the deploy token.",
    );
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();

    failure = null;
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "good" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Token set");
    expect(environment.request).toHaveBeenCalledWith("updateDeploySettings", {
      accountId: "0123456789abcdef0123456789abcdef",
      token: "good",
    });
    expect(elementOf(screen.getByLabelText("API token"), HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText("No token");
    expect(environment.request).toHaveBeenCalledWith("deleteDeploySettings", {});
    expect(elementOf(screen.getByLabelText("Account ID"), HTMLInputElement).value).toBe("");
  });
});
