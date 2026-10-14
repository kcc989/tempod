import { Schema, SchemaGetter } from "effect";
import {
  TempoError,
  type PrState,
  type ChecksState,
  type MergeMethod,
  type CheckRun as CheckRunWire,
} from "@tempo/protocol";
import { githubFetch, githubPaginate } from "./client.ts";
import { GhPull } from "./api.ts";

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
  listCheckRuns(token: string, repo: Repo, sha: string): Promise<CheckRunWire[]>;
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
    const all = await githubPaginate(
      { path: `${r(repo)}/branches`, token },
      2000,
      Schema.Array(Schema.Struct({ name: Schema.String })),
    );

    const q = query?.toLowerCase() ?? "";

    return all
      .filter((b) => b.name.toLowerCase().includes(q))
      .slice(0, 100)
      .map((b) => ({ name: b.name }));
  },
  async branchExists(token, repo, branch) {
    try {
      await githubFetch(
        { path: `${r(repo)}/branches/${encodeURIComponent(branch)}`, token },
        Schema.Struct({ name: Schema.String }),
      );

      return true;
    } catch (e) {
      if (e instanceof TempoError && "status" in e && Schema.is(Schema.Number)(e.status) && e.status === 404)
        return false;
      throw e;
    }
  },
  async listOpenPullRequests(token, repo) {
    const pulls = await githubPaginate(
      { path: `${r(repo)}/pulls`, token, query: { state: "open" } },
      300,
      Schema.Array(GhPull),
    );

    return pulls.map((p) => ({ number: p.number, title: p.title, headBranch: p.head.ref }));
  },
  getPullRequest(token, repo, number) {
    return githubFetch(
      {
        path: `${r(repo)}/pulls/${number}`,
        token,
        mapError: (s) => (s === 404 ? "NOT_FOUND" : undefined),
      },
      GhPull,
    );
  },
  async createPullRequest(token, repo, input) {
    const pr = await githubFetch(
      {
        method: "POST",
        path: `${r(repo)}/pulls`,
        token,
        body: input,
        mapError: (status, body) =>
          status === 422 && JSON.stringify(body).toLowerCase().includes("already exists")
            ? "PR_EXISTS"
            : undefined,
      },
      GhPull,
    );

    return { number: pr.number, url: pr.html_url, state: prStateOf(pr) };
  },
  async mergePullRequest(token, repo, number, method) {
    await githubFetch(
      {
        method: "PUT",
        path: `${r(repo)}/pulls/${number}/merge`,
        token,
        body: { merge_method: method },
        mapError: (status) => (status === 405 || status === 409 ? "PR_NOT_MERGEABLE" : undefined),
      },
      Schema.Struct({}),
    );
  },
  async listCheckRuns(token, repo, sha) {
    const CheckRun = Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      html_url: Schema.String,
      output: Schema.optional(Schema.Struct({ summary: Schema.NullOr(Schema.String) })),
    });

    const runs = await githubPaginate(
      { path: `${r(repo)}/commits/${sha}/check-runs`, token },
      500,
      Schema.Struct({ check_runs: Schema.Array(CheckRun) }).pipe(
        Schema.decodeTo(Schema.Array(CheckRun), {
          decode: SchemaGetter.transform((page) => page.check_runs),
          encode: SchemaGetter.transform((check_runs) => ({ check_runs })),
        }),
      ),
    );

    return runs.map((c) => {
      let check: CheckRunWire = { name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url };

      if (c.output?.summary) check = { ...check, summary: c.output.summary };

      return check;
    });
  },
  async deleteBranch(token, repo, branch) {
    await githubFetch(
      {
        method: "DELETE",
        path: `${r(repo)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
        token,
        mapError: (s) => (s === 422 || s === 404 ? "NOT_FOUND" : undefined),
      },
      Schema.Undefined,
    );
  },
};
