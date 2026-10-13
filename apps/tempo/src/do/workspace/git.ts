import { desc } from "drizzle-orm";
import { TempoError, type ChangedFile, type ChangesSummary, type FnOutput } from "@tempo/protocol";
import { EMPTY_PROMPT, json } from "../../db/json.ts";
import { turns } from "../../db/workspace-do.ts";
import { requireGithubAppConfig } from "../../github/app.ts";
import { mintInstallationToken } from "../../github/api.ts";
import { checksStateOf, github, prStateOf } from "../../github/provider.ts";
import { errorText, log } from "../../log.ts";
import { requireTempod } from "./container.ts";
import type { WorkspaceCore } from "./core.ts";

const TOKEN_MARGIN_MS = 5 * 60_000;

/** Repo-scoped installation token, cached in memory until 5 minutes before expiry (01). */
export const getGithubToken = async (core: WorkspaceCore): Promise<string> => {
  if (core.ghToken && core.ghToken.expiresAt - TOKEN_MARGIN_MS > Date.now()) return core.ghToken.token;
  const project = await core.project();
  const config = await requireGithubAppConfig(core.env);
  const token = await mintInstallationToken(config, project.installationId, [project.repoId]);
  core.ghToken = token;

  return token.token;
};

export const summarize = (files: ReadonlyArray<ChangedFile>): ChangesSummary => ({
  files: [...files],
  additions: files.reduce((n, f) => n + f.additions, 0),
  deletions: files.reduce((n, f) => n + f.deletions, 0),
});

export const storeChanges = (core: WorkspaceCore, summary: ChangesSummary): void => {
  core.setKv("changes", summary);
  core.broadcast({ type: "changes", ...summary });
};

/** git.changes for the branch scope; updates the Changes summary and the "unpushed" flag. */
export const refreshChanges = async (core: WorkspaceCore): Promise<void> => {
  const res = await requireTempod(core).request("git.changes", { scope: "branch" });
  storeChanges(core, summarize(res.files));
  const unpushed = (res.dirty ?? false) || (res.ahead ?? 0) > 0;

  if (unpushed !== (core.kv<boolean>("hasUnpushedCommits") ?? false)) {
    core.setKv("hasUnpushedCommits", unpushed);
    core.broadcastDetailSoon();
  }
};

/** 03, Status polling: PR state, then check runs for the PR head. */
export const refreshPullRequest = async (core: WorkspaceCore): Promise<FnOutput<"refreshPullRequest">> => {
  const row = core.ws();

  if (row.prNumber === null) return { prNumber: null, prState: null, checksState: null, prTitle: null };
  const project = await core.project();
  const token = await getGithubToken(core);
  const repo = { owner: project.owner, name: project.name };
  const pr = await github.getPullRequest(token, repo, row.prNumber);
  const prState = prStateOf(pr);
  const runs = await github.listCheckRuns(token, repo, pr.head.sha);
  const checksState = checksStateOf(runs);
  const titleChanged = core.kv<string>("prTitle") !== pr.title;
  core.setKv("prTitle", pr.title);

  if (prState !== row.prState || checksState !== row.checksState || titleChanged) {
    core.ctx.storage.transactionSync(() => {
      core.updateWs({ prState, checksState });

      if (checksState !== row.checksState && (checksState === "success" || checksState === "failure")) {
        const type = checksState === "success" ? "tempo.check.passed" : "tempo.check.failed";
        core.lifecycle.append({
          type,
          source: "tempo",
          changeId: core.lifecycle.newestOpenChange(),
          dedupeKey: `checks:${row.prNumber}:${pr.head.sha}:${type}`,
          payload: { prNumber: row.prNumber! },
        });
      }
    });
    core.lifecycle.kick();
    core.publish();
  }

  return { prNumber: row.prNumber, prState, checksState, prTitle: pr.title };
};

export const pollPullRequestSafe = async (core: WorkspaceCore): Promise<void> => {
  try {
    await refreshPullRequest(core);
  } catch (e) {
    log("warn", "pr poll failed", { workspaceId: core.workspaceId, error: errorText(e) });
  }
};

/** Default PR body (03): `Created with Tempo.`, a blank line, the first line of each prompt, at most 20. */
export const defaultPrBody = (core: WorkspaceCore): string => {
  const lines = core.db
    .select({ promptJson: turns.promptJson })
    .from(turns)
    .orderBy(desc(turns.seq))
    .all()
    .reverse()
    .map((t) => json.prompt.read(t.promptJson, EMPTY_PROMPT).text.split("\n")[0]?.trim() ?? "")
    .filter((l) => l.length > 0)
    .slice(0, 20);

  return ["Created with Tempo.", "", ...lines.map((l) => `- ${l}`)].join("\n");
};

export const requirePushed = (core: WorkspaceCore): void => {
  if (core.ws().pushed !== 1) throw new TempoError("NOT_PUSHED");
};
