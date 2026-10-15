import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  TempoError,
  type Project,
  type RepositoryDetail,
  type RepositoryIssue,
  type RepositoryIssueComment,
  type RepositoryLabel,
} from "@tempo/protocol";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryHub } from "~/ui/components/repositories/RepositoryHub";
import { RepositoryLabelManager } from "~/ui/components/repositories/RepositoryLabels";
import type { RepositorySearch } from "~/ui/components/repositories/model";
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

const repository: RepositoryDetail = {
  projectId: "p1",
  name: "demo",
  description: null,
  defaultBranch: "main",
  remote: "https://git.test/demo.git",
  readOnly: true,
  ref: "main",
  empty: false,
  entries: [],
  commit: null,
};

const bug: RepositoryLabel = {
  id: "bug",
  projectId: "p1",
  name: "Bug",
  color: "112233",
  description: "Something is broken",
  createdAt: 1,
  updatedAt: 1,
};

const issue: RepositoryIssue = {
  id: "issue1",
  projectId: "p1",
  number: 1,
  title: "Track this bug",
  body: "Original description",
  state: "open",
  authorId: "owner",
  createdAt: 1,
  updatedAt: 1,
  closedAt: null,
  url: "/repositories?project=p1&tab=issues&issue=1",
  labels: [bug],
  commentCount: 0,
};

const comment: RepositoryIssueComment = {
  id: "comment1",
  issueId: "issue1",
  authorId: "owner",
  body: "First comment",
  createdAt: 1,
  updatedAt: 1,
};

let environment = createUiEnvironment();

let request = environment.request;

let issues: RepositoryIssue[] = [];

let labels: RepositoryLabel[] = [];

let comments: RepositoryIssueComment[] = [];

let bindingAvailable = true;

const show = (child: ReactNode) => render(child, { wrapper: environment.Provider });

function IssueHub({ initial = { project: "p1", tab: "issues" } }: { initial?: RepositorySearch }) {
  const [search, setSearch] = useState(initial);

  return <RepositoryHub search={search} onNavigate={setSearch} />;
}

beforeEach(() => {
  resetUiState();
  environment = createUiEnvironment();
  request = environment.request;
  issues = [issue];
  labels = [bug];
  comments = [];
  bindingAvailable = true;
  request.mockImplementation(async (name, input) => {
    switch (name) {
      case "listProjects":
        return [project];
      case "getRepository":
        if (!bindingAvailable) throw new TempoError("ARTIFACTS_NOT_CONFIGURED");

        return repository;
      case "listRepositoryLabels":
        return labels;
      case "listRepositoryIssues": {
        const list = requestInput("listRepositoryIssues", input);

        return issues
          .filter((entry) => {
            if (list.state !== "all" && entry.state !== (list.state ?? "open")) return false;

            if (list.labelId && !entry.labels.some((label) => label.id === list.labelId)) return false;

            return (
              !list.query || (entry.title + " " + entry.body).toLowerCase().includes(list.query.toLowerCase())
            );
          })
          .slice(list.offset ?? 0, (list.offset ?? 0) + 50);
      }

      case "getRepositoryIssue": {
        const get = requestInput("getRepositoryIssue", input);
        const result = issues.find((entry) => entry.number === get.number);

        if (!result) throw new TempoError("NOT_FOUND");

        return { ...result, commentCount: comments.filter((entry) => entry.issueId === result.id).length };
      }

      case "createRepositoryIssue": {
        const create = requestInput("createRepositoryIssue", input);

        const created: RepositoryIssue = {
          ...issue,
          id: "issue2",
          number: 2,
          title: create.title,
          body: create.body ?? "",
          labels: labels.filter((label) => create.labelIds?.includes(label.id)),
          url: "/repositories?project=p1&tab=issues&issue=2",
        };

        issues = [created, ...issues];

        return created;
      }

      case "updateRepositoryIssue": {
        const update = requestInput("updateRepositoryIssue", input);
        let result = issues.find((entry) => entry.number === update.number);

        if (!result) throw new TempoError("NOT_FOUND");

        if (update.title !== undefined) result = { ...result, title: update.title };

        if (update.body !== undefined) result = { ...result, body: update.body };

        if (update.state !== undefined)
          result = { ...result, state: update.state, closedAt: update.state === "closed" ? 2 : null };

        if (update.labelIds !== undefined)
          result = { ...result, labels: labels.filter((label) => update.labelIds?.includes(label.id)) };

        const updated = result;

        issues = issues.map((entry) => (entry.id === updated.id ? updated : entry));

        return updated;
      }

      case "listRepositoryIssueComments": {
        const list = requestInput("listRepositoryIssueComments", input);

        return comments.slice(list.offset ?? 0, (list.offset ?? 0) + 50);
      }

      case "createRepositoryIssueComment": {
        const create = requestInput("createRepositoryIssueComment", input);
        const created = { ...comment, id: "new-comment", body: create.body, createdAt: 100, updatedAt: 100 };

        comments = [...comments, created];

        return created;
      }

      case "updateRepositoryIssueComment": {
        const update = requestInput("updateRepositoryIssueComment", input);
        const current = comments.find((entry) => entry.id === update.commentId);

        if (!current) throw new TempoError("NOT_FOUND");

        const updated = { ...current, body: update.body, updatedAt: 101 };

        comments = comments.map((entry) => (entry.id === updated.id ? updated : entry));

        return updated;
      }

      case "deleteRepositoryIssueComment": {
        const remove = requestInput("deleteRepositoryIssueComment", input);

        comments = comments.filter((entry) => entry.id !== remove.commentId);

        return {};
      }

      case "createRepositoryLabel": {
        const create = requestInput("createRepositoryLabel", input);

        const created = {
          ...bug,
          id: "new-label",
          name: create.name,
          color: create.color,
          description: create.description ?? "",
        };

        labels = [...labels, created];

        return created;
      }

      case "updateRepositoryLabel": {
        const update = requestInput("updateRepositoryLabel", input);
        let current = labels.find((label) => label.id === update.labelId);

        if (!current) throw new TempoError("NOT_FOUND");

        if (update.name !== undefined) current = { ...current, name: update.name };

        if (update.color !== undefined) current = { ...current, color: update.color };

        if (update.description !== undefined) current = { ...current, description: update.description };

        const updated = current;

        labels = labels.map((label) => (label.id === updated.id ? updated : label));

        return updated;
      }

      case "deleteRepositoryLabel": {
        const remove = requestInput("deleteRepositoryLabel", input);

        labels = labels.filter((label) => label.id !== remove.labelId);
        issues = issues.map((entry) => ({
          ...entry,
          labels: entry.labels.filter((label) => label.id !== remove.labelId),
        }));

        return {};
      }

      default:
        throw new Error("Unexpected issue request: " + name);
    }
  });
});

afterEach(resetUiState);

describe("repository issues", () => {
  it("creates a labeled issue, edits its content and labels, then closes and reopens it", async () => {
    show(<IssueHub />);
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "New bug" } });
    fireEvent.change(within(dialog).getByLabelText("Description"), {
      target: { value: "Steps to reproduce" },
    });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "Bug" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create issue" }));
    await screen.findByRole("heading", { name: "New bug #2" });
    expect(screen.getByText("Steps to reproduce")).toBeDefined();
    expect(screen.getByText("Bug")).toBeDefined();
    expect(request).toHaveBeenCalledWith("createRepositoryIssue", {
      projectId: "p1",
      title: "New bug",
      body: "Steps to reproduce",
      labelIds: ["bug"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit issue" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Revised bug" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "New details" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Bug" }));
    fireEvent.click(screen.getByRole("button", { name: "Save issue" }));
    await screen.findByRole("heading", { name: "Revised bug #2" });
    await screen.findByText("New details");
    expect(screen.queryByText("Bug")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close issue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reopen issue" }));
    await screen.findByRole("button", { name: "Close issue" });
    expect(request).toHaveBeenCalledWith("updateRepositoryIssue", {
      projectId: "p1",
      number: 2,
      title: "Revised bug",
      body: "New details",
      labelIds: [],
    });
    expect(request).toHaveBeenCalledWith("updateRepositoryIssue", {
      projectId: "p1",
      number: 2,
      state: "closed",
    });
    expect(request).toHaveBeenCalledWith("updateRepositoryIssue", {
      projectId: "p1",
      number: 2,
      state: "open",
    });
  });

  it("searches issue content, filters closed issues and labels, and opens the selected result", async () => {
    issues = [
      issue,
      {
        ...issue,
        id: "closed",
        number: 2,
        title: "Completed followup",
        body: "Searchable detail",
        state: "closed",
      },
    ];
    show(<IssueHub />);
    await screen.findByText("Track this bug");
    expect(screen.queryByText("Completed followup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    await screen.findByText("Completed followup");
    expect(screen.queryByText("Track this bug")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search issues"), { target: { value: "Searchable detail" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("listRepositoryIssues", {
        projectId: "p1",
        state: "closed",
        offset: 0,
        query: "Searchable detail",
      }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Filter issues by label" }));
    fireEvent.click(await screen.findByRole("option", { name: "Bug" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("listRepositoryIssues", {
        projectId: "p1",
        state: "closed",
        offset: 0,
        query: "Searchable detail",
        labelId: "bug",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Completed followup/ }));
    await screen.findByRole("heading", { name: "Completed followup #2" });
    expect(screen.getByRole("button", { name: "Reopen issue" })).toBeDefined();
  });

  it("shows the 51st posted comment on its page and allows editing and deleting it", async () => {
    comments = Array.from({ length: 50 }, (_, index) => ({
      ...comment,
      id: "comment-" + index,
      body: "Earlier comment " + index,
    }));
    show(<IssueHub initial={{ project: "p1", tab: "issues", issue: 1 }} />);
    await screen.findByText("Earlier comment 0");
    fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "Newest comment" } });
    fireEvent.keyDown(screen.getByLabelText("Add a comment"), { code: "Enter", metaKey: true });
    // Role queries over the 50-comment page are slow on a loaded runner; wait for page 2 first.
    await waitFor(() => expect(screen.queryByText("Earlier comment 0")).toBeNull());
    const edit = await screen.findByRole("button", { name: "Edit comment" });

    expect(screen.getByText("Newest comment")).toBeDefined();
    expect(screen.queryByText("Earlier comment 0")).toBeNull();
    expect(elementOf(screen.getByLabelText("Add a comment"), HTMLTextAreaElement).value).toBe("");
    expect(request).toHaveBeenCalledWith("listRepositoryIssueComments", {
      projectId: "p1",
      number: 1,
      offset: 50,
    });
    fireEvent.click(edit);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), {
      target: { value: "Edited newest comment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull());
    expect(screen.getByText("Edited newest comment")).toBeDefined();
    expect(screen.queryByText("Newest comment")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(screen.queryByText("Edited newest comment")).toBeNull());
    expect(request).toHaveBeenCalledWith("createRepositoryIssueComment", {
      projectId: "p1",
      number: 1,
      body: "Newest comment",
    });
    expect(request).toHaveBeenCalledWith("updateRepositoryIssueComment", {
      projectId: "p1",
      number: 1,
      commentId: "new-comment",
      body: "Edited newest comment",
    });
    expect(request).toHaveBeenCalledWith("deleteRepositoryIssueComment", {
      projectId: "p1",
      number: 1,
      commentId: "new-comment",
    });
  });

  it("creates, changes and deletes repository labels through the manager", async () => {
    show(<RepositoryLabelManager projectId="p1" open onOpenChange={vi.fn()} />);
    await screen.findByRole("list", { name: "Repository labels" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Needs review" } });
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: "#abcdef" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Awaiting review" } });
    fireEvent.click(screen.getByRole("button", { name: "Create label" }));
    const list = screen.getByRole("list", { name: "Repository labels" });

    await within(list).findByText("Needs review");
    expect(within(list).getByText("Awaiting review")).toBeDefined();
    expect(elementOf(screen.getByLabelText("Name"), HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Edit label Needs review" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reviewed" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Review complete" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    await within(list).findByText("Reviewed");
    expect(within(list).queryByText("Needs review")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete label Reviewed" }));
    await waitFor(() => expect(within(list).queryByText("Reviewed")).toBeNull());
    expect(within(list).getByText("Bug")).toBeDefined();
    expect(request).toHaveBeenCalledWith("createRepositoryLabel", {
      projectId: "p1",
      name: "Needs review",
      color: "abcdef",
      description: "Awaiting review",
    });
    expect(request).toHaveBeenCalledWith("updateRepositoryLabel", {
      projectId: "p1",
      labelId: "new-label",
      name: "Reviewed",
      color: "abcdef",
      description: "Review complete",
    });
    expect(request).toHaveBeenCalledWith("deleteRepositoryLabel", { projectId: "p1", labelId: "new-label" });
  });

  it("allows issue metadata when Git is read-only or the Artifacts binding is unavailable", async () => {
    const rendered = show(<IssueHub initial={{ project: "p1", tab: "code" }} />);

    await screen.findByText("This repository is read-only.");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Issues" }), { button: 0, ctrlKey: false });
    await screen.findByText("Track this bug");
    expect(elementOf(screen.getByRole("button", { name: "New issue" }), HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "New issue" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Metadata still works" } });
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }));
    await screen.findByRole("heading", { name: "Metadata still works #2" });
    rendered.unmount();
    bindingAvailable = false;
    request.mockClear();
    show(<IssueHub />);
    await screen.findByText("Metadata still works");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(elementOf(screen.getByRole("button", { name: "New issue" }), HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(request).not.toHaveBeenCalledWith("getRepository", expect.anything());
  });
});
