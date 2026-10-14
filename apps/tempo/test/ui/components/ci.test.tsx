import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  TempoError,
  type CiJob,
  type CiPipeline,
  type CiRun,
  type Project,
  type RepositoryPullRequest,
} from "@tempo/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryHub } from "~/ui/components/repositories/RepositoryHub";
import { resetUiState } from "~/ui/state/workspace-ui";
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

const run: CiRun = {
  id: "r1",
  projectId: "p1",
  number: 7,
  branch: "feature",
  sha: "abcdef0123456789abcdef0123456789abcdef01",
  revision: 2,
  attempt: 1,
  trigger: "push",
  status: "running",
  conclusion: null,
  createdAt: 1,
  startedAt: 1,
  completedAt: null,
  url: "https://tempo.test/repositories?project=p1&tab=checks&run=r1",
};

const jobs: CiJob[] = [
  {
    key: "lint",
    name: "Lint",
    needs: [],
    status: "completed",
    conclusion: "failure",
    exitCode: 2,
    summary: null,
    startedAt: 1_000,
    completedAt: 66_000,
  },
  {
    key: "test",
    name: "Tests",
    needs: ["lint"],
    status: "completed",
    conclusion: "skipped",
    exitCode: null,
    summary: null,
    startedAt: null,
    completedAt: 66_000,
  },
];

const pipeline: CiPipeline = {
  projectId: "p1",
  revision: 2,
  source: "version: 1\njobs:\n  lint:\n    run: bun run lint\n",
  enabled: true,
  jobs: [{ key: "lint", name: "lint", needs: [], timeoutMinutes: 20 }],
  required: ["lint"],
  egressAllowlist: [],
  updatedAt: 1,
};

const pull: RepositoryPullRequest = {
  id: "pr1",
  projectId: "p1",
  number: 1,
  title: "Ship feature",
  body: "",
  headBranch: "feature",
  baseBranch: "main",
  state: "open",
  url: "/repositories?project=p1&tab=pulls&pull=1",
  headSha: null,
  baseSha: null,
  mergeSha: null,
  createdAt: 1,
  updatedAt: 1,
  mergedAt: null,
};

let environment = createUiEnvironment();

let current = run;

let saveError: TempoError | null = null;

const show = (child: ReactNode) => render(child, { wrapper: environment.Provider });

beforeEach(() => {
  resetUiState();
  environment = createUiEnvironment();
  current = run;
  saveError = null;
  environment.request.mockImplementation(async (name, input) => {
    switch (name) {
      case "listProjects":
        return [project];
      case "listBranches":
        return [{ name: "main" }, { name: "feature" }];
      case "listCiRuns":
        return [current];
      case "getCiRun":
        return { run: current, jobs };
      case "getCiJobLog":
        return { text: `log of ${requestInput("getCiJobLog", input).job}`, truncated: false };
      case "cancelCiRun":
        current = { ...current, status: "completed", conclusion: "cancelled" };

        return current;
      case "startCiRun":
        return { ...run, id: "r2", branch: requestInput("startCiRun", input).branch, trigger: "manual" };
      case "getCiPipeline":
        return pipeline;
      case "updateCiPipeline":
        if (saveError) throw saveError;

        return { ...pipeline, revision: 3, source: requestInput("updateCiPipeline", input).source };
      case "getRepositoryPullRequest":
        return pull;
      default:
        throw new Error("Unexpected request: " + name);
    }
  });
});

afterEach(resetUiState);

describe("repository checks (10, Clients)", () => {
  it("lists runs, starts a branch run and opens a run with job logs and cancel", async () => {
    const navigate = vi.fn();

    const { unmount } = show(
      <RepositoryHub search={{ project: "p1", tab: "checks" }} onNavigate={navigate} />,
    );

    const row = await screen.findByRole("button", { name: /#7 · feature/ });
    expect(within(row).getByText("Running")).toBeTruthy();
    expect(row.textContent).toContain("abcdef0 · push");
    expect(elementOf(screen.getByRole("button", { name: "Run checks" }), HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(row);
    expect(navigate).toHaveBeenCalledWith({ project: "p1", tab: "checks", run: "r1" });
    unmount();

    show(<RepositoryHub search={{ project: "p1", tab: "checks", run: "r1" }} onNavigate={navigate} />);
    await screen.findByText("Run #7");
    const lint = screen.getByRole("button", { name: /Lint/ });
    expect(lint.textContent).toContain("exit 2 · 1m 05s");
    expect(within(lint).getByText("Failed")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /Tests/ })).getByText("Skipped")).toBeTruthy();
    expect(await screen.findByText("log of lint")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Tests/ }));
    expect(navigate).toHaveBeenLastCalledWith({ project: "p1", tab: "checks", run: "r1", job: "test" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Rerun" });
    expect(environment.request).toHaveBeenCalledWith("cancelCiRun", { projectId: "p1", runId: "r1" });
  });

  it("shows pipeline problems in place and offers a reload for a stale revision", async () => {
    show(<RepositoryHub search={{ project: "p1", tab: "checks" }} onNavigate={vi.fn()} />);
    const editor = await screen.findByLabelText("Pipeline", { selector: "textarea" });
    expect(screen.getByText("Revision 2 · merges need lint")).toBeTruthy();
    const save = elementOf(screen.getByRole("button", { name: "Save pipeline" }), HTMLButtonElement);
    expect(save.disabled).toBe(true);

    saveError = new TempoError("CI_PIPELINE_INVALID", undefined, "jobs.lint.run: required");
    fireEvent.change(editor, { target: { value: "version: 1\njobs:\n  lint: {}\n" } });
    fireEvent.click(save);
    expect((await screen.findByRole("alert")).textContent).toBe("jobs.lint.run: required");

    saveError = new TempoError("CI_PIPELINE_CHANGED");
    fireEvent.click(save);
    await screen.findByRole("button", { name: "Reload" });
    expect(environment.request).toHaveBeenLastCalledWith("updateCiPipeline", {
      projectId: "p1",
      source: "version: 1\njobs:\n  lint: {}\n",
      revision: 2,
    });

    saveError = null;
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows the head branch's newest run on a pull request", async () => {
    const navigate = vi.fn();
    show(<RepositoryHub search={{ project: "p1", tab: "pulls", pull: 1 }} onNavigate={navigate} />);
    const checks = await screen.findByLabelText("Checks");
    expect(checks.textContent).toContain("Run #7 on abcdef0");
    expect(environment.request).toHaveBeenCalledWith("listCiRuns", {
      projectId: "p1",
      branch: "feature",
      offset: 0,
    });
    fireEvent.click(within(checks).getByRole("button", { name: "View run" }));
    expect(navigate).toHaveBeenCalledWith({ project: "p1", tab: "checks", run: "r1" });
  });
});
