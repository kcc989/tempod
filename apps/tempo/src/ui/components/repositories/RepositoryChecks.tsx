import { TempoError, type CiPipeline, type CiRun } from "@tempo/protocol";
import { ArrowLeftIcon, CircleCheckBigIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { BranchPicker } from "~/ui/components/dialogs/BranchPicker";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Label } from "~/ui/components/ui/label";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative } from "~/ui/lib/format";
import type { RepositoryHubProps } from "./RepositoryHub";
import { canAdmin, canWrite, useRepositoryAccess } from "./access";
import { ciDuration, ciRunsInput, ciState, selectedJob, shortSha, type RepositoryProject } from "./model";

type Props = RepositoryHubProps & { project: RepositoryProject };

const LIVE_MS = 5_000;

const PAGE = 50;

/** 10, Clients: runs, run detail with logs, and the owner pipeline. */
export function RepositoryChecks(props: Props) {
  const admin = canAdmin(useRepositoryAccess());

  if (props.search.run) return <CiRunDetail {...props} runId={props.search.run} />;

  return (
    <div className="flex flex-col gap-6 p-5">
      <CiRuns {...props} />
      {admin && <CiPipelineEditor projectId={props.project.id} />}
    </div>
  );
}

function StateBadge({ item }: { item: Parameters<typeof ciState>[0] }) {
  const state = ciState(item);

  return <Badge variant={state.tone}>{state.label}</Badge>;
}

function CiRuns({ project, onNavigate }: Props) {
  const writer = canWrite(useRepositoryAccess());
  const [branch, setBranch] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const runs = useCallQuery("listCiRuns", ciRunsInput(project.id, branch, offset), {
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status !== "completed") ? LIVE_MS : false,
  });

  const start = useCallMutation("startCiRun", {
    invalidates: ["listCiRuns"],
    onSuccess: (run) => onNavigate({ project: project.id, tab: "checks", run: run.id }),
  });

  return (
    <section className="flex flex-col gap-4" aria-label="Check runs">
      <div className="flex flex-wrap items-center gap-2">
        <BranchPicker
          id="ci-branch"
          label="Branch"
          placeholder="All branches"
          projectId={project.id}
          value={branch}
          onChange={(value) => {
            setBranch(value);
            setOffset(0);
          }}
        />
        {branch && (
          <Button size="sm" variant="ghost" onClick={() => setBranch(null)}>
            All branches
          </Button>
        )}
        {writer && (
          <Button
            size="sm"
            className="ml-auto"
            disabled={!branch || start.isPending}
            onClick={() => branch && start.mutate({ projectId: project.id, branch })}
          >
            <PlayIcon />
            {start.isPending ? "Starting…" : "Run checks"}
          </Button>
        )}
      </div>
      {runs.isPending ? (
        <SkeletonRows rows={4} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      ) : runs.data.length === 0 ? (
        <EmptyState
          icon={CircleCheckBigIcon}
          title={offset > 0 ? "No older runs." : "No check runs yet."}
          description="Save a pipeline below. Pushes then run it; you can also run a branch."
        />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Runs">
          {runs.data.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30"
                onClick={() => onNavigate({ project: project.id, tab: "checks", run: run.id })}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    #{run.number} · {run.branch}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {shortSha(run.sha)} · {run.trigger}
                    {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""} · {formatRelative(run.createdAt)}
                  </p>
                </div>
                <StateBadge item={run} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {offset > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Newer runs
          </Button>
        )}
        {runs.data?.length === PAGE && (
          <Button size="sm" variant="ghost" onClick={() => setOffset(offset + PAGE)}>
            Older runs
          </Button>
        )}
      </div>
    </section>
  );
}

function CiRunDetail({ project, search, onNavigate, runId }: Props & { runId: string }) {
  const detail = useCallQuery(
    "getCiRun",
    { projectId: project.id, runId },
    { refetchInterval: (query) => (query.state.data?.run.status === "completed" ? false : LIVE_MS) },
  );

  const cancel = useCallMutation("cancelCiRun", { invalidates: ["getCiRun", "listCiRuns"] });
  const writer = canWrite(useRepositoryAccess());

  const rerun = useCallMutation("rerunCiRun", {
    invalidates: ["listCiRuns"],
    onSuccess: (run) => onNavigate({ project: project.id, tab: "checks", run: run.id }),
  });

  const back = (
    <Button
      variant="ghost"
      size="sm"
      className="self-start"
      onClick={() => onNavigate({ project: project.id, tab: "checks" })}
    >
      <ArrowLeftIcon />
      Check runs
    </Button>
  );

  if (detail.isPending)
    return (
      <div className="flex flex-col gap-4 p-5">
        {back}
        <SkeletonRows rows={4} />
      </div>
    );

  if (detail.isError)
    return (
      <div className="flex flex-col gap-4 p-5">
        {back}
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  const { run, jobs } = detail.data;
  const job = selectedJob(jobs, search.job);

  return (
    <div className="flex flex-col gap-4 p-5">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">
          Run #{run.number} <span className="text-muted-foreground">{run.branch}</span>
        </h2>
        <StateBadge item={run} />
        <span className="text-sm text-muted-foreground">
          {shortSha(run.sha)} · {run.trigger}
          {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""} · pipeline revision {run.revision}
        </span>
        <span className="ml-auto flex gap-2">
          {!writer ? null : run.status === "completed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={rerun.isPending}
              onClick={() => rerun.mutate({ projectId: project.id, runId: run.id })}
            >
              Rerun
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ projectId: project.id, runId: run.id })}
            >
              Cancel
            </Button>
          )}
        </span>
      </div>
      <ul className="divide-y rounded-lg border" aria-label="Jobs">
        {jobs.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              aria-current={item.key === job?.key ? "true" : undefined}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/30 aria-[current=true]:bg-muted/40"
              onClick={() => onNavigate({ ...search, job: item.key })}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {[
                    item.needs.length ? `needs ${item.needs.join(", ")}` : "",
                    item.exitCode === null ? "" : `exit ${item.exitCode}`,
                    ciDuration(item.startedAt, item.completedAt),
                    item.summary ?? "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <StateBadge item={item} />
            </button>
          </li>
        ))}
      </ul>
      {job && <CiJobLog projectId={project.id} run={run} jobKey={job.key} live={job.status === "running"} />}
    </div>
  );
}

function CiJobLog({
  projectId,
  run,
  jobKey,
  live,
}: {
  projectId: string;
  run: CiRun;
  jobKey: string;
  live: boolean;
}) {
  const log = useCallQuery(
    "getCiJobLog",
    { projectId, runId: run.id, job: jobKey },
    { refetchInterval: live ? LIVE_MS : false },
  );

  return (
    <section aria-label={`Log for ${jobKey}`} className="rounded-lg border">
      <p className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
        Log{log.data?.truncated ? " (last 1 MiB)" : ""}
      </p>
      {log.isPending ? (
        <SkeletonRows rows={3} />
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : (
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs">
          {log.data.text || "No output yet."}
        </pre>
      )}
    </section>
  );
}

function CiPipelineEditor({ projectId }: { projectId: string }) {
  const pipeline = useCallQuery("getCiPipeline", { projectId });

  if (pipeline.isPending) return <SkeletonRows rows={3} />;

  if (pipeline.isError) return <ErrorState error={pipeline.error} onRetry={() => void pipeline.refetch()} />;

  return (
    <PipelineForm
      key={pipeline.data.revision}
      pipeline={pipeline.data}
      onReload={() => void pipeline.refetch()}
    />
  );
}

function PipelineForm({ pipeline, onReload }: { pipeline: CiPipeline; onReload: () => void }) {
  const [source, setSource] = useState(pipeline.source);
  const [problem, setProblem] = useState<{ text: string; stale: boolean } | null>(null);

  const save = useCallMutation("updateCiPipeline", {
    toast: false,
    invalidates: ["getCiPipeline"],
    onSuccess: () => setProblem(null),
    onError: (error) => {
      if (error instanceof TempoError && error.code === "CI_PIPELINE_INVALID")
        setProblem({ text: error.detail ?? error.message, stale: false });
      else if (error instanceof TempoError && error.code === "CI_PIPELINE_CHANGED")
        setProblem({ text: error.message, stale: true });
      else setProblem({ text: error.message, stale: false });
    },
  });

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Pipeline">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="ci-pipeline" className="text-base font-semibold">
          Pipeline
        </Label>
        <Badge variant={pipeline.enabled ? "success" : "muted"}>{pipeline.enabled ? "Enabled" : "Off"}</Badge>
        <span className="text-xs text-muted-foreground">
          {pipeline.revision === 0 ? "Not saved yet" : `Revision ${pipeline.revision}`}
          {pipeline.required.length ? ` · merges need ${pipeline.required.join(", ")}` : ""}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        YAML with <code>version: 1</code> and <code>jobs</code>. Jobs run with read-only repository access and
        no secrets. Leave it empty to turn CI off.
      </p>
      <Textarea
        id="ci-pipeline"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        rows={12}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={"version: 1\njobs:\n  test:\n    run: bun install && bun test"}
      />
      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {problem.text}
          {problem.stale && (
            <Button size="sm" variant="outline" onClick={onReload}>
              Reload
            </Button>
          )}
        </div>
      )}
      <Button
        size="sm"
        className="self-start"
        disabled={save.isPending || source === pipeline.source}
        onClick={() => save.mutate({ projectId: pipeline.projectId, source, revision: pipeline.revision })}
      >
        {save.isPending ? "Saving…" : "Save pipeline"}
      </Button>
    </section>
  );
}
