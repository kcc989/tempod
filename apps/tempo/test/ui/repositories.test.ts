import { describe, expect, it } from "vitest";
import {
  ciDuration,
  ciRunsInput,
  ciState,
  deployInput,
  deploymentsInput,
  deployState,
  selectedJob,
  commitTitle,
  importUrlError,
  parentPath,
  pullRequestGuideRefs,
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

  it("reads PR guides from the live head, the merged head commit, or the closed branch before its tip", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const pull = { headBranch: "feature", headSha: sha };

    expect(pullRequestGuideRefs({ ...pull, state: "draft" })).toEqual(["feature"]);
    expect(pullRequestGuideRefs({ ...pull, state: "merged" })).toEqual([sha, "feature"]);
    expect(pullRequestGuideRefs({ ...pull, state: "closed" })).toEqual(["feature", sha]);
    expect(pullRequestGuideRefs({ ...pull, state: "merged", headSha: null })).toEqual(["feature"]);
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

describe("repository checks model (10, Clients)", () => {
  it("parses check run and job links and builds run list input", () => {
    expect(repositorySearch({ project: "p1", tab: "checks", run: "r1", job: "test" })).toEqual({
      project: "p1",
      tab: "checks",
      run: "r1",
      job: "test",
    });
    expect(ciRunsInput("p1", null, 0)).toEqual({ projectId: "p1", offset: 0 });
    expect(ciRunsInput("p1", "feature/x", 50)).toEqual({ projectId: "p1", offset: 50, branch: "feature/x" });
  });

  it("never labels unfinished work as passed and formats durations", () => {
    expect(ciState({ status: "queued", conclusion: null })).toEqual({ label: "Queued", tone: "muted" });
    expect(ciState({ status: "running", conclusion: null })).toEqual({ label: "Running", tone: "warning" });
    expect(ciState({ status: "running", conclusion: "success" }).label).toBe("Running");
    expect(ciState({ status: "completed", conclusion: "success" })).toEqual({
      label: "Passed",
      tone: "success",
    });
    expect(ciState({ status: "completed", conclusion: "timed_out" })).toEqual({
      label: "Timed out",
      tone: "danger",
    });
    expect(ciState({ status: "completed", conclusion: null }).label).toBe("Completed");
    expect(ciDuration(null, null)).toBe("");
    expect(ciDuration(1_000, 6_000)).toBe("5s");
    expect(ciDuration(0, 125_000)).toBe("2m 05s");
    expect(ciDuration(0, null, 61_000)).toBe("1m 01s");
  });

  it("selects the requested job, else the first that started", () => {
    const job = (key: string, startedAt: number | null) => ({
      key,
      name: key,
      needs: [],
      status: "queued" as const,
      conclusion: null,
      exitCode: null,
      summary: null,
      startedAt,
      completedAt: null,
    });

    const jobs = [job("a", null), job("b", 5), job("c", 6)];

    expect(selectedJob(jobs, "c")?.key).toBe("c");
    expect(selectedJob(jobs, "missing")?.key).toBe("b");
    expect(selectedJob([job("a", null)], undefined)?.key).toBe("a");
    expect(selectedJob([], undefined)).toBeUndefined();
  });
});

describe("repository deploys model (12, Clients)", () => {
  it("parses deployment links and builds list and deploy input", () => {
    expect(repositorySearch({ project: "p1", tab: "deploys", deployment: "d1" })).toEqual({
      project: "p1",
      tab: "deploys",
      deployment: "d1",
    });
    expect(deploymentsInput("p1", null, 0)).toEqual({ projectId: "p1", offset: 0 });
    expect(deploymentsInput("p1", "preview", 50)).toEqual({ projectId: "p1", offset: 50, target: "preview" });

    const fixed = { key: "production", stage: "production", branch: "main", auto: true, agent: false };
    const open = { key: "preview", stage: "preview", branch: null, auto: false, agent: true };
    expect(deployInput("p1", fixed, "feature")).toEqual({ projectId: "p1", target: "production" });
    expect(deployInput("p1", open, null)).toBeNull();
    expect(deployInput("p1", open, "feature")).toEqual({
      projectId: "p1",
      target: "preview",
      branch: "feature",
    });
    expect(deployInput("p1", undefined, "feature")).toBeNull();
  });

  it("never labels an unfinished deployment as succeeded", () => {
    expect(deployState({ status: "running", conclusion: "success" })).toEqual({
      label: "Running",
      tone: "warning",
    });
    expect(deployState({ status: "queued", conclusion: null }).label).toBe("Queued");
    expect(deployState({ status: "completed", conclusion: "success" })).toEqual({
      label: "Succeeded",
      tone: "success",
    });
    expect(deployState({ status: "completed", conclusion: "timed_out" }).tone).toBe("danger");
  });
});
