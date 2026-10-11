import { TempoError, type PrState, type ChecksState, type MergeMethod } from "@tempo/protocol";
import { githubFetch, githubPaginate } from "./client.ts";
import type { GhPull } from "./api.ts";

/**
 * The repo provider (00, Git and repos). GitHub is the only provider in version 1. Every call
 * takes a repo-scoped installation token.
 */
export interface Repo {
  readonly owner: string;
  readonly name: string;
}

export interface GitProvider {
  listBranches(token: string, repo: Repo, query?: string): Promise<{ name: string }[]>;
  branchExists(token: string, repo: Repo, branch: string): Promise<boolean>;
  listOpenPullRequests(
    token: string,
    repo: Repo,
  ): Promise<{ number: number; title: string; headBranch: string }[]>;
  getPullRequest(token: string, repo: Repo, number: number): Promise<GhPull>;
  createPullRequest(
    token: string,
    repo: Repo,
    input: { title: string; head: string; base: string; body: string; draft: boolean },
  ): Promise<{ number: number; url: string; state: PrState }>;
  mergePullRequest(token: string, repo: Repo, number: number, method: MergeMethod): Promise<void>;
  listCheckRuns(
    token: string,
    repo: Repo,
    sha: string,
  ): Promise<{ name: string; status: string; conclusion: string | null; url: string }[]>;
  deleteBranch(token: string, repo: Repo, branch: string): Promise<void>;
}

const r = (repo: Repo) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

export const prStateOf = (pr: Pick<GhPull, "merged" | "merged_at" | "state" | "draft">): PrState =>
  pr.merged || pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";

/** 03, Status polling. `null` when there are no check runs. */
export const checksStateOf = (
  runs: ReadonlyArray<{ status: string; conclusion: string | null }>,
): ChecksState | null => {
  if (runs.length === 0) return null;
  if (runs.some((x) => x.status === "queued" || x.status === "in_progress")) return "pending";
  if (runs.some((x) => ["failure", "cancelled", "timed_out", "action_required"].includes(x.conclusion ?? "")))
    return "failure";
  return "success";
};

export const github: GitProvider = {
  async listBranches(token, repo, query) {
    const all = await githubPaginate<{ name: string }>({ path: `${r(repo)}/branches`, token }, 2000);
    const q = query?.toLowerCase() ?? "";
    return all
      .filter((b) => b.name.toLowerCase().includes(q))
      .slice(0, 100)
      .map((b) => ({ name: b.name }));
  },
  async branchExists(token, repo, branch) {
    try {
      await githubFetch({ path: `${r(repo)}/branches/${encodeURIComponent(branch)}`, token });
      return true;
    } catch (e) {
      if (e instanceof TempoError && "status" in e && (e as { status: number }).status === 404) return false;
      throw e;
    }
  },
  async listOpenPullRequests(token, repo) {
    const pulls = await githubPaginate<GhPull>(
      { path: `${r(repo)}/pulls`, token, query: { state: "open" } },
      300,
    );
    return pulls.map((p) => ({ number: p.number, title: p.title, headBranch: p.head.ref }));
  },
  getPullRequest(token, repo, number) {
    return githubFetch<GhPull>({
      path: `${r(repo)}/pulls/${number}`,
      token,
      mapError: (s) => (s === 404 ? "NOT_FOUND" : undefined),
    });
  },
  async createPullRequest(token, repo, input) {
    const pr = await githubFetch<GhPull>({
      method: "POST",
      path: `${r(repo)}/pulls`,
      token,
      body: input,
      mapError: (status, body) =>
        status === 422 && JSON.stringify(body).toLowerCase().includes("already exists")
          ? "PR_EXISTS"
          : undefined,
    });
    return { number: pr.number, url: pr.html_url, state: prStateOf(pr) };
  },
  async mergePullRequest(token, repo, number, method) {
    await githubFetch({
      method: "PUT",
      path: `${r(repo)}/pulls/${number}/merge`,
      token,
      body: { merge_method: method },
      mapError: (status) => (status === 405 || status === 409 ? "PR_NOT_MERGEABLE" : undefined),
    });
  },
  async listCheckRuns(token, repo, sha) {
    const runs = await githubPaginate<{
      name: string;
      status: string;
      conclusion: string | null;
      html_url: string;
    }>(
      { path: `${r(repo)}/commits/${sha}/check-runs`, token },
      500,
      (page) => (page as { check_runs: never[] }).check_runs,
    );
    return runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url }));
  },
  async deleteBranch(token, repo, branch) {
    await githubFetch({
      method: "DELETE",
      path: `${r(repo)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      token,
      mapError: (s) => (s === 422 || s === 404 ? "NOT_FOUND" : undefined),
    });
  },
};
