import { useState, useEffect } from "react";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { Button } from "~/ui/components/ui/button";

import { formatDuration } from "~/ui/lib/format";
import { readJson, writeJson } from "~/ui/lib/storage";
import { Schema } from "effect";
import { openTab } from "~/ui/state/workspace-ui";

export function RunCard({
  workspaceId,
  runId,
  canRevert = false,
  writable = true,
}: {
  workspaceId: string;
  runId: string;
  canRevert?: boolean;
  writable?: boolean;
}) {
  const live = useWorkspaceSelector(workspaceId, (s) => s.runs[runId]);
  const query = useCallQuery("listRuns", { workspaceId });
  const run = live ?? query.data?.find((r) => r.id === runId);
  const cancel = useCallMutation("cancelRun", { invalidates: ["listRuns"] });
  const send = useCallMutation("sendRunToChat", { invalidates: ["listRuns"] });
  const revert = useCallMutation("revertToCheckpoint");
  const key = `run-dismissed:${workspaceId}:${runId}`;
  const [dismissed, setDismissed] = useState(() => readJson(key, false, Schema.is(Schema.Boolean)));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);

  if (dismissed) return null;

  if (!run) return <p role="status">Loading run…</p>;
  const active = run.status === "running" || run.status === "queued";
  const result = run.result;

  return (
    <section aria-label={`Run ${run.name}`} className="my-2 space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{run.name}</strong>
        <span className="font-mono text-xs">@{run.handle}</span>
        <span>{run.status}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {run.hook?.event ?? "request"} ·{" "}
        {run.decisionP === null ? "always" : `${Math.round(run.decisionP * 100)}%`} · {run.agent ?? "waiting"}{" "}
        · {run.access} · {formatDuration((run.endedAt ?? now) - (run.startedAt ?? run.createdAt))} ·{" "}
        {run.tokens} tokens
      </p>
      {!!run.profileIssues?.length && (
        <p className="text-sm text-amber-600">Ignored settings: {run.profileIssues.join(", ")}</p>
      )}
      {run.warning === "files_changed" && (
        <div>
          <p>This read-only agent changed files.</p>
          <Button
            variant="outline"
            disabled={!writable || !canRevert || revert.isPending}
            onClick={() => {
              if (run.pinCheckpointId) revert.mutate({ workspaceId, checkpointId: run.pinCheckpointId });
            }}
          >
            Revert
          </Button>
        </div>
      )}
      {run.errorCode && <p role="alert">{run.errorDetail ?? run.errorCode}</p>}
      {result && (
        <div className="space-y-2">
          <p>
            {result.status}: {result.summary}
          </p>
          {run.outputKind === "plan" && (
            <>
              <ol className="list-decimal pl-5">
                {result.steps?.map((step, i) => (
                  <li key={i}>
                    {step.text}
                    {step.files?.length ? <span className="text-xs"> ({step.files.join(", ")})</span> : null}
                  </li>
                ))}
              </ol>
              {result.verify && <p>Verify: {result.verify}</p>}
            </>
          )}
          {run.outputKind === "review" && (
            <ul>
              {result.findings?.map((finding, i) => (
                <li key={i} className="text-sm">
                  <strong>{finding.blocking ? "Blocking" : "Finding"}</strong> · {finding.path}
                  {finding.line ? `:${finding.line}` : ""} · {finding.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {active && (
          <Button
            variant="outline"
            disabled={!writable || cancel.isPending}
            onClick={() => cancel.mutate({ workspaceId, runId })}
          >
            Cancel
          </Button>
        )}
        {run.status === "completed" && (
          <Button
            disabled={!writable || !!run.sentTurnId || !run.originSessionId || send.isPending}
            onClick={() => send.mutate({ workspaceId, runId })}
          >
            {run.sentTurnId ? "Sent to chat" : run.outputKind === "plan" ? "Approve" : "Send to chat"}
          </Button>
        )}
        {run.sessionId && (
          <Button
            variant="outline"
            onClick={() => {
              if (run.sessionId) openTab(workspaceId, { kind: "runTranscript", sessionId: run.sessionId });
            }}
          >
            Open transcript
          </Button>
        )}
        {!active && (
          <Button
            variant="ghost"
            onClick={() => {
              writeJson(key, true);
              setDismissed(true);
            }}
          >
            Dismiss
          </Button>
        )}
      </div>
    </section>
  );
}

export function RunActivity({ workspaceId }: { workspaceId: string }) {
  const query = useCallQuery("listRuns", { workspaceId });
  const live = useWorkspaceSelector(workspaceId, (s) => s.runs);
  const rows = new Map(query.data?.map((run) => [run.id, run]));

  for (const run of Object.values(live)) rows.set(run.id, run);

  return (
    <div className="space-y-2">
      {[...rows.values()]
        .filter((r) => !r.originSessionId)
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .map((run) => (
          <RunCard key={run.id} workspaceId={workspaceId} runId={run.id} />
        ))}
    </div>
  );
}
