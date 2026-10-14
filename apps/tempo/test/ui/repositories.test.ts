import { describe, expect, it } from "vitest";
import {
  commitTitle,
  importUrlError,
  parentPath,
  repositorySearch,
  shortSha,
} from "~/ui/components/repositories/model";
import { githubUrlFor } from "~/ui/components/topbar/topbar-logic";
import { repositoryPath } from "~/ui/lib/links";

describe("repository navigation", () => {
  it("roundtrips repository IDs, slashed branches and PR numbers safely", () => {
    const url = new URL(repositoryPath("p?owner=x", { ref: "feature/a b", pull: 42 }), "https://tempo.test");

    expect(
      repositorySearch({
        project: url.searchParams.get("project"),
        ref: url.searchParams.get("ref"),
        tab: url.searchParams.get("tab"),
        pull: url.searchParams.get("pull"),
      }),
    ).toEqual({
      project: "p?owner=x",
      ref: "feature/a b",
      tab: "pulls",
      pull: 42,
    });
  });

  it("drops invalid search values and nonpositive, fractional, boolean or nonfinite PR numbers", () => {
    expect(repositorySearch({ project: 7, pull: -1, tab: "bad", ref: null })).toEqual({});
    expect(repositorySearch({ pull: "1.5" })).toEqual({});
    expect(repositorySearch({ pull: "Infinity" })).toEqual({});
    expect(repositorySearch({ pull: true })).toEqual({});
  });

  it("parses owner-scoped issue links and leaves invalid issue numbers on the issues list", () => {
    const url = new URL("/repositories", "https://tempo.test");

    url.searchParams.set("project", "p?owner=x");
    url.searchParams.set("tab", "issues");
    url.searchParams.set("issue", "7");
    expect(
      repositorySearch({
        project: url.searchParams.get("project"),
        tab: url.searchParams.get("tab"),
        issue: url.searchParams.get("issue"),
      }),
    ).toEqual({ project: "p?owner=x", tab: "issues", issue: 7 });
    expect(repositorySearch({ tab: "issues", issue: true })).toEqual({ tab: "issues" });
    expect(repositorySearch({ tab: "issues", issue: "1.5" })).toEqual({ tab: "issues" });
  });

  it("keeps Artifacts workspace links inside Tempo", () => {
    const project = { id: "p1", provider: "artifacts", owner: "tempo", name: "demo" };

    expect(githubUrlFor(project, { prNumber: 7, branch: "feature" }, true)).toBe(
      "/repositories?project=p1&tab=pulls&pull=7",
    );
    expect(githubUrlFor(project, { prNumber: null, branch: "feature/a" }, true)).toBe(
      "/repositories?project=p1&ref=feature%2Fa",
    );
    expect(githubUrlFor(project, { prNumber: null, branch: "feature" }, false)).toBe(
      "/repositories?project=p1",
    );
  });

  it("preserves existing GitHub links", () => {
    expect(githubUrlFor({ owner: "me", name: "demo" }, { prNumber: 2, branch: "feature" }, true)).toBe(
      "https://github.com/me/demo/pull/2",
    );
  });

  it("browses parents and abbreviates commit labels", () => {
    expect(parentPath("src/lib/main.ts")).toBe("src/lib");
    expect(parentPath("src")).toBe("");
    expect(commitTitle("Fix title\n\nLong description")).toBe("Fix title");
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });

  it("rejects credentials and non-HTTPS imports before making a request", () => {
    expect(importUrlError("https://github.com/me/demo.git")).toBeNull();

    for (const url of [
      "git@github.com:me/demo.git",
      "http://github.com/me/demo",
      "https://user:secret@github.com/me/demo",
      "https://github.com/me/demo?token=secret",
      "https://github.com/me/demo#secret",
      "file:///workspace/repo",
    ]) {
      expect(importUrlError(url)).not.toBeNull();
    }
  });
});
