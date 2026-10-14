import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TempoError, type Project, type ProjectSummary, type RepositoryDetail } from "@tempo/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "~/ui/components/profile/ProfilePage";
import { PublicProjectPage } from "~/ui/components/profile/PublicProjectPage";
import { RepositoryHub } from "~/ui/components/repositories/RepositoryHub";
import { dialogStore, resetUiState, resolveConfirm } from "~/ui/state/workspace-ui";
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
  username: "octo",
  slug: "demo",
  visibility: "private",
  pinned: false,
};

const site: ProjectSummary = {
  id: "p1",
  username: "octo",
  slug: "demo",
  provider: "artifacts",
  owner: "tempo",
  name: "demo",
  defaultBranch: "main",
  pinned: true,
  updatedAt: 2,
};

const web: ProjectSummary = {
  ...site,
  id: "p2",
  slug: "web",
  provider: "github",
  owner: "acme",
  name: "web",
  pinned: false,
};

const repository: RepositoryDetail = {
  projectId: "p1",
  name: "demo",
  description: null,
  defaultBranch: "main",
  remote: "",
  readOnly: false,
  ref: "main",
  empty: false,
  entries: [{ name: "README.md", path: "README.md", hash: "blob", type: "blob" }],
  commit: null,
};

let environment = createUiEnvironment();

let current = project;

const show = (child: ReactNode) => render(child, { wrapper: environment.Provider });

beforeEach(() => {
  resetUiState();
  environment = createUiEnvironment();
  current = project;
  environment.request.mockImplementation(async (name, input) => {
    switch (name) {
      case "listProjects":
        return [current];
      case "getRepository":
        return { ...repository, remote: "https://git.test/demo.git" };
      case "listBranches":
        return [{ name: "main" }];
      case "setProjectVisibility": {
        const { visibility } = requestInput("setProjectVisibility", input);
        current = { ...current, visibility, pinned: visibility === "private" ? false : current.pinned };

        return current;
      }

      case "setProjectPinned":
        current = { ...current, pinned: requestInput("setProjectPinned", input).pinned };

        return current;
      default:
        throw new Error("Unexpected request: " + name);
    }
  });
});

afterEach(resetUiState);

describe("public profile (04, 11)", () => {
  it("confirms before making a repository public, then offers Pin and the public page", async () => {
    show(<RepositoryHub search={{ project: "p1" }} onNavigate={vi.fn()} />);
    const select = await screen.findByRole("combobox", { name: "Visibility" });
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();

    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Public" }));
    await waitFor(() => expect(dialogStore.getSnapshot().confirm).not.toBeNull());
    expect(environment.request).not.toHaveBeenCalledWith("setProjectVisibility", expect.anything());
    resolveConfirm(dialogStore.getSnapshot().confirm!.id, true);

    fireEvent.click(await screen.findByRole("button", { name: "Pin" }));
    await screen.findByRole("button", { name: "Unpin" });
    expect(environment.request).toHaveBeenCalledWith("setProjectVisibility", {
      projectId: "p1",
      visibility: "public",
    });
    expect(environment.request).toHaveBeenCalledWith("setProjectPinned", { projectId: "p1", pinned: true });
    expect(screen.getByRole("link", { name: "Public page" }).getAttribute("href")).toBe("/octo/demo");
  });

  it("shows the profile with pinned projects first, and not-found for an unknown user", async () => {
    environment.request.mockImplementation(async (name, input) => {
      if (name === "getProfile") {
        if (requestInput("getProfile", input).username !== "octo") throw new TempoError("NOT_FOUND");

        return { username: "octo", name: "Octo Cat", image: null, bio: "Builds things." };
      }

      if (name === "listProfileProjects") return [site, web];
      throw new Error("Unexpected request: " + name);
    });
    const { unmount } = show(<ProfilePage username="octo" />);

    await screen.findByRole("heading", { name: "Octo Cat" });
    expect(screen.getByText("@octo")).toBeTruthy();
    expect(screen.getByText("Builds things.")).toBeTruthy();
    const cards = await screen.findAllByRole("link", { name: /^octo\// });
    expect(cards.map((a) => a.getAttribute("href"))).toEqual(["/octo/demo", "/octo/web"]);
    expect(screen.getAllByText("Pinned")).toHaveLength(1);
    unmount();

    show(<ProfilePage username="ghost" />);
    await screen.findByText("Not found.");
  });

  it("shows a visitor read-only code, and a GitHub link for a GitHub project", async () => {
    environment.request.mockImplementation(async (name, input) => {
      if (name === "getPublicProject")
        return requestInput("getPublicProject", input).slug === "web" ? web : site;

      if (name === "getRepository") return repository;

      if (name === "listBranches") return [{ name: "main" }];
      throw new Error("Unexpected request: " + name);
    });

    const { unmount } = show(
      <PublicProjectPage username="octo" slug="demo" search={{}} onNavigate={vi.fn()} owner={false} />,
    );

    await screen.findByRole("button", { name: "README.md" });
    expect(screen.getByRole("tab", { name: "Commits" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Issues" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Clone URL/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open in Tempo" })).toBeNull();
    unmount();

    show(<PublicProjectPage username="octo" slug="web" search={{}} onNavigate={vi.fn()} owner />);
    const github = await screen.findByRole("link", { name: /Open on GitHub/ });
    expect(github.getAttribute("href")).toBe("https://github.com/acme/web");
    expect(screen.getByRole("link", { name: "Open in Tempo" })).toBeTruthy();
    expect(environment.request).not.toHaveBeenCalledWith("getRepository", { projectId: "p2" });
  });
});
