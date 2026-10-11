import type { SetupStatus, WorkspaceDetail } from "@tempo/protocol";
import { AlertCircleIcon, AlertTriangleIcon, CheckCircle2Icon, CircleIcon, RotateCwIcon } from "lucide-react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Spinner } from "~/ui/components/ui/spinner";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { cn } from "~/ui/lib/utils";
import { openDialog } from "~/ui/state/workspace-ui";
import { ScriptOutput } from "./ScriptOutput";
import { newestRun, runSummary, SETUP_STATUS_TEXT } from "./script-runs";
import { useScriptMutations, useScriptRuns } from "./useScripts";

/** 04, Bottom panel: setup status and output, Rerun setup, Continue anyway, settings issues. */
export function SetupTab({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const { runs, isPending, error, refetch } = useScriptRuns(workspaceId);
  const { rerunSetup, continueAnyway } = useScriptMutations(workspaceId);

  if (!workspace) return <SkeletonRows rows={4} />;
  const run = newestRun(runs, "setup");
  const status = workspace.setupStatus;
  const hasScript = workspace.settings.scripts.setup.trim() !== "";
  const archived = workspace.state === "archived" || workspace.state === "archiving";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <SetupStatusIcon status={status} />
        <span className="text-sm font-medium">{SETUP_STATUS_TEXT[status]}</span>
        {run && status !== "running" && (
          <span className="text-xs text-muted-foreground">{runSummary(run)}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {status === "failed" && (
            <Button
              size="sm"
              variant="outline"
              disabled={continueAnyway.isPending || archived}
              onClick={() => continueAnyway.mutate({ workspaceId })}
            >
              Continue anyway
            </Button>
          )}
          {(hasScript || status !== "none") && (
            <Button
              size="sm"
              variant={status === "failed" ? "default" : "outline"}
              disabled={rerunSetup.isPending || status === "running" || archived}
              onClick={() => rerunSetup.mutate({ workspaceId })}
            >
              <RotateCwIcon aria-hidden />
              Rerun setup
            </Button>
          )}
        </div>
      </div>
      <SettingsIssues workspace={workspace} />
      {hasScript && (
        <p className="truncate border-b px-3 py-1 font-mono text-xs text-muted-foreground" title={workspace.settings.scripts.setup}>
          {workspace.settings.scripts.setup}
        </p>
      )}
      {run ? (
        <ScriptOutput
          workspaceId={workspaceId}
          runId={run.id}
          label="Setup output"
          empty={status === "running" ? "Waiting for output…" : "No output."}
        />
      ) : isPending ? (
        <SkeletonRows rows={4} />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : hasScript ? (
        <EmptyState title="Setup has not run yet." description="It runs after the repo is cloned." />
      ) : (
        <EmptyState
          title="No setup script."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDialog({ kind: "settings", tab: "project", projectId: workspace.projectId })}
            >
              Open project settings
            </Button>
          }
        />
      )}
    </div>
  );
}

function SetupStatusIcon({ status }: { status: SetupStatus }) {
  switch (status) {
    case "running":
      return <Spinner className="text-primary" />;
    case "succeeded":
      return <CheckCircle2Icon aria-hidden className="size-3.5 text-success" />;
    case "failed":
      return <AlertCircleIcon aria-hidden className="size-3.5 text-destructive" />;
    case "skipped":
      return <AlertTriangleIcon aria-hidden className="size-3.5 text-warning" />;
    case "none":
      return <CircleIcon aria-hidden className="size-3.5 text-muted-foreground" />;
  }
}

/** Errors and warnings from all three settings files (01, Project settings file). */
function SettingsIssues({ workspace }: { workspace: WorkspaceDetail }) {
  const errors = workspace.settingsErrors ?? [];
  const warnings = workspace.settingsWarnings ?? [];
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <ul aria-label="Settings issues" className="flex flex-col gap-1 border-b px-3 py-1.5 text-xs">
      {errors.map((e, i) => (
        <Issue key={`e${i}`} tone="error" text={e} />
      ))}
      {warnings.map((w, i) => (
        <Issue key={`w${i}`} tone="warning" text={w} />
      ))}
    </ul>
  );
}

function Issue({ tone, text }: { tone: "error" | "warning"; text: string }) {
  const Icon = tone === "error" ? AlertCircleIcon : AlertTriangleIcon;
  return (
    <li className="flex items-start gap-1.5">
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-3 shrink-0", tone === "error" ? "text-destructive" : "text-warning")}
      />
      <span className="sr-only">{tone === "error" ? "Error:" : "Warning:"}</span>
      <span className="break-words">{text}</span>
    </li>
  );
}
