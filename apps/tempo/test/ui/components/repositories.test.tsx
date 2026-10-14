import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  FnOutput,
  Project,
  RepositoryCommit,
  RepositoryDetail,
  RepositoryPullRequest,
  WorkspaceSummary,
} from "@tempo/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryForm } from "~/ui/components/repositories/RepositoryForm";
import { RepositoryHub } from "~/ui/components/repositories/RepositoryHub";
import { PullRequestForm } from "~/ui/components/repositories/RepositoryPullRequests";
import { resetUiState } from "~/ui/state/workspace-ui";
import { elementOf } from "../elements";
import { createUiEnvironment, requestInput } from "../environment";
import { summary } from "../fixtures";

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

const repository: RepositoryDetail = {
  projectId: "p1",
  name: "demo",
  description: "Hosted code",
  defaultBranch: "main",
  remote: "https://git.test/demo.git",
  readOnly: false,
  ref: "main",
  empty: false,
  entries: [
    { name: "src", path: "src", hash: "tree", type: "tree" },
    { name: "README.md", path: "README.md", hash: "blob", type: "blob" },
  ],
  commit: null,
};

const pull: RepositoryPullRequest = {
  id: "pr1",
  projectId: "p1",
  number: 1,
  title: "Ship feature",
  body: "Description",
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

let request = environment.request;

let currentRepository = repository;

let currentPull = pull;

let workspaces: WorkspaceSummary[] = [];

let commits: RepositoryCommit[] = [];

let file: FnOutput<"getRepositoryFile"> = { content: "Hello repo", encoding: "utf8", size: 10 };

let repositoryFailure = false;

const show = (child: ReactNode) => render(child, { wrapper: environment.Provider });

beforeEach(() => {
  resetUiState();
  environment = createUiEnvironment();
  request = environment.request;
  currentRepository = repository;
  currentPull = pull;
  workspaces = [];
  commits = [];
  file = { content: "Hello repo", encoding: "utf8", size: 10 };
  repositoryFailure = false;
  request.mockImplementation(async (name, input) => {
    switch (name) {
      case "listProjects":
        return [project];
      case "getRepository":
        if (repositoryFailure) throw new Error("Temporary failure");

        return currentRepository;
      case "getRepositoryFile":
        return file;
      case "listBranches":
        return [{ name: "main" }, { name: "feature" }];
      case "listRepositoryCommits":
        return commits;
      case "listRepositoryPullRequests":
        return [currentPull];
      case "listCiRuns":
        return [];
      case "getRepositoryPullRequest":
        return currentPull;
      case "createRepositoryPullRequest": {
        const create = requestInput("createRepositoryPullRequest", input);

        currentPull = {
          ...pull,
          title: create.title,
          body: create.body,
          headBranch: create.headBranch,
          baseBranch: create.baseBranch,
          state: create.draft ? "draft" : "open",
        };

        return currentPull;
      }

      case "updateRepositoryPullRequest": {
        const update = requestInput("updateRepositoryPullRequest", input);

        if (update.state) currentPull = { ...currentPull, state: update.state };

        if (update.title) currentPull = { ...currentPull, title: update.title };

        if (update.body !== undefined) currentPull = { ...currentPull, body: update.body };

        if (update.draft !== undefined)
          currentPull = { ...currentPull, state: update.draft ? "draft" : "open" };

        return currentPull;
      }

      case "createRepository":
      case "importRepository":
      case "linkArtifactRepository":
        return project;
      case "listWorkspaces":
        return workspaces;
      case "createWorkspace":
        return summary();
      case "createPullRequest":
        return { number: currentPull.number, url: currentPull.url };
      default:
        throw new Error("Unexpected repository request: " + name);
    }
  });
});

afterEach(resetUiState);

describe("repository workflows", () => {
  it("shows commit history and opens the selected immutable commit", async () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const navigate = vi.fn();

    commits = [
      {
        hash,
        treeHash: "tree",
        message: "Initial commit\n\nDetails",
        author: { name: "Owner", email: "owner@example.com" },
        committer: { name: "Owner", email: "owner@example.com" },
        parents: [],
        authoredAt: 1,
        committedAt: 1,
      },
    ];
    show(<RepositoryHub search={{ project: "p1", tab: "commits" }} onNavigate={navigate} />);
    await screen.findByText("Initial commit");
    expect(request).toHaveBeenCalledWith("listRepositoryCommits", { projectId: "p1", offset: 0 });
    fireEvent.click(screen.getByRole("button", { name: "0123456" }));
    expect(navigate).toHaveBeenCalledWith({ project: "p1", tab: "code", ref: hash });
  });

  it("shows repository failure, keeps workspace creation disabled, and recovers on Retry", async () => {
    repositoryFailure = true;
    show(<RepositoryHub search={{ project: "p1" }} onNavigate={vi.fn()} />);
    await screen.findByRole("alert");
    expect(elementOf(screen.getByRole("button", { name: "New workspace" }), HTMLButtonElement).disabled).toBe(
      true,
    );
    repositoryFailure = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "src" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(elementOf(screen.getByRole("button", { name: "New workspace" }), HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("blocks workspace and PR creation for a read-only repository", async () => {
    currentRepository = { ...repository, readOnly: true };
    show(<RepositoryHub search={{ project: "p1", tab: "pulls" }} onNavigate={vi.fn()} />);
    await screen.findByText("This repository is read-only.");
    const workspace = elementOf(screen.getByRole("button", { name: "New workspace" }), HTMLButtonElement);
    const newPull = elementOf(screen.getByRole("button", { name: "New pull request" }), HTMLButtonElement);

    expect(workspace.disabled).toBe(true);
    expect(newPull.disabled).toBe(true);
    fireEvent.click(newPull);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(request).not.toHaveBeenCalledWith("createRepositoryPullRequest", expect.anything());
  });

  it("omits the default ref for an empty repository and bootstraps its workspace without a login", async () => {
    currentRepository = { ...repository, empty: true, entries: [] };
    show(<RepositoryHub search={{ project: "p1" }} onNavigate={vi.fn()} />);
    await screen.findByText("This repository is empty.");
    expect(request).toHaveBeenCalledWith("getRepository", { projectId: "p1", path: "" });
    fireEvent.click(screen.getByRole("button", { name: "Start a workspace" }));
    await waitFor(() => expect(environment.history.location.pathname).toBe("/w/w1"));
    expect(request).toHaveBeenCalledWith("createWorkspace", {
      projectId: "p1",
      source: { kind: "new", baseBranch: "main" },
    });
    expect(request).not.toHaveBeenCalledWith("getCredentialStatus", expect.anything());
  });

  it("creates a repository with the submit shortcut without GitHub installation setup", async () => {
    const done = vi.fn();

    show(<RepositoryForm onSuccess={done} />);
    fireEvent.change(screen.getByLabelText("Repository name"), { target: { value: "new-demo" } });
    fireEvent.keyDown(screen.getByLabelText("Repository name"), { code: "Enter", metaKey: true });
    await waitFor(() =>
      expect(done).toHaveBeenCalledWith(project, {
        name: "new-demo",
        visibility: "private",
        defaultBranch: "main",
      }),
    );
    expect(request).toHaveBeenCalledWith("createRepository", {
      name: "new-demo",
      visibility: "private",
      defaultBranch: "main",
    });
    expect(request).not.toHaveBeenCalledWith("listInstallations", expect.anything());
  });

  it("rejects credential-bearing import URLs and completes a valid public import", async () => {
    const done = vi.fn();

    show(<RepositoryForm onSuccess={done} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Import" }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("Repository name"), { target: { value: "imported" } });
    fireEvent.change(screen.getByLabelText("Git URL"), {
      target: { value: "https://user:secret@git.test/demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import repository" }));
    expect(screen.getByRole("alert").textContent).toContain("without credentials");
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Git URL"), {
      target: { value: "https://github.com/me/demo.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import repository" }));
    await waitFor(() =>
      expect(done).toHaveBeenCalledWith(project, {
        name: "imported",
        visibility: "private",
        url: "https://github.com/me/demo.git",
      }),
    );
    expect(request).toHaveBeenCalledWith("importRepository", {
      name: "imported",
      visibility: "private",
      url: "https://github.com/me/demo.git",
    });
  });

  it("browses hosted folders and files without starting a workspace", async () => {
    const navigate = vi.fn();

    show(<RepositoryHub search={{ project: "p1" }} onNavigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    expect(navigate).toHaveBeenCalledWith({ project: "p1", ref: "main", path: "src" });
    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    expect(navigate).toHaveBeenCalledWith({ project: "p1", ref: "main", path: "", file: "README.md" });
    expect(request).not.toHaveBeenCalledWith("getWorkspace", expect.anything());
    expect(request).not.toHaveBeenCalledWith("createWorkspace", expect.anything());
  });

  it("shows a binary-file state for hosted data", async () => {
    file = { content: "AA==", encoding: "base64", size: 1 };
    show(<RepositoryHub search={{ project: "p1", file: "image.png" }} onNavigate={vi.fn()} />);
    await screen.findByText("Binary file.");
    expect(request).toHaveBeenCalledWith("getRepositoryFile", {
      projectId: "p1",
      ref: "main",
      path: "image.png",
    });
  });

  it("uses the real branch picker and returns a draft PR from the selected branches", async () => {
    const done = vi.fn();

    show(<PullRequestForm project={project} onSuccess={done} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Head branch" }));
    fireEvent.click(await screen.findByRole("option", { name: "feature" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Ship feature" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Description" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    await waitFor(() =>
      expect(done).toHaveBeenCalledWith(
        { ...pull, state: "draft" },
        {
          projectId: "p1",
          title: "Ship feature",
          body: "Description",
          headBranch: "feature",
          baseBranch: "main",
          draft: true,
        },
      ),
    );
    expect(request).toHaveBeenCalledWith("listBranches", { projectId: "p1" });
  });

  it("closes and reopens a local PR through the shared RPC and refreshes its controls", async () => {
    show(<RepositoryHub search={{ project: "p1", tab: "pulls", pull: 1 }} onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close pull request" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reopen pull request" }));
    await screen.findByRole("button", { name: "Close pull request" });
    expect(request).toHaveBeenCalledWith("updateRepositoryPullRequest", {
      projectId: "p1",
      number: 1,
      state: "closed",
    });
    expect(request).toHaveBeenCalledWith("updateRepositoryPullRequest", {
      projectId: "p1",
      number: 1,
      state: "open",
    });
  });

  it("opens a local PR's workspace for review and merge", async () => {
    show(<RepositoryHub search={{ project: "p1", tab: "pulls", pull: 1 }} onNavigate={vi.fn()} />);
    const review = await screen.findByRole("button", { name: "Review and merge in workspace" });

    await waitFor(() => expect(elementOf(review, HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(review);
    await waitFor(() => expect(environment.history.location.pathname).toBe("/w/w1"));
    expect(request).toHaveBeenCalledWith("createWorkspace", {
      projectId: "p1",
      source: { kind: "pr", number: 1 },
    });
  });

  it("adopts a local PR into its existing head workspace instead of creating a conflicting workspace", async () => {
    workspaces = [summary({ id: "existing", branch: "feature", prNumber: null })];
    show(<RepositoryHub search={{ project: "p1", tab: "pulls", pull: 1 }} onNavigate={vi.fn()} />);
    const review = await screen.findByRole("button", { name: "Review and merge in workspace" });

    await waitFor(() => expect(elementOf(review, HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(review);
    await waitFor(() => expect(environment.history.location.pathname).toBe("/w/existing"));
    expect(request).toHaveBeenCalledWith("createPullRequest", {
      workspaceId: "existing",
      title: "Ship feature",
      body: "Description",
      draft: false,
    });
    expect(request).not.toHaveBeenCalledWith("createWorkspace", expect.anything());
  });
});
