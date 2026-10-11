import { PlayIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { ShortcutKbd } from "~/ui/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Spinner } from "~/ui/components/ui/spinner";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { formatTime } from "~/ui/lib/format";
import { cn } from "~/ui/lib/utils";
import { openDialog } from "~/ui/state/workspace-ui";
import { ScriptOutput } from "./ScriptOutput";
import {
  runScriptEntries,
  runsOf,
  runSummary,
  runTone,
  runToggle,
  selectedRunScriptId,
  type RunTone,
} from "./script-runs";
import { useScriptMutations, useScriptRuns } from "./useScripts";

const TONE_CLASS: Record<RunTone, string> = {
  running: "text-primary",
  ok: "text-success",
  failed: "text-destructive",
  muted: "text-muted-foreground",
};

/** 04, Bottom panel: a menu of run scripts, Start and Stop, the live output and past runs. */
export function RunTab({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const { runs, isPending, error, refetch } = useScriptRuns(workspaceId);
  const { start, stop } = useScriptMutations(workspaceId);
  const [picked, setPicked] = useState<string | null>(null);
  const [shownRunId, setShownRunId] = useState<string | null>(null);

  if (!workspace) return <SkeletonRows rows={4} />;
  const entries = runScriptEntries(workspace.settings);
  const scriptId = selectedRunScriptId(workspace.settings, picked);
  const script = entries.find((e) => e.id === scriptId);
  if (!script) {
    return (
      <EmptyState
        title="No run scripts."
        description="Add one to .tempo/settings.toml or in project settings."
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
    );
  }

  const history = runsOf(runs, "run", script.id);
  const shown = history.find((r) => r.id === shownRunId) ?? history[0] ?? null;
  const toggle = runToggle(runs, script.id);
  const isShortcutTarget = selectedRunScriptId(workspace.settings, null) === script.id;
  const archived = workspace.state === "archived" || workspace.state === "archiving";
  const busy = start.isPending || stop.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <Select
          value={script.id}
          onValueChange={(v) => {
            setPicked(v);
            setShownRunId(null);
          }}
        >
          <SelectTrigger size="sm" aria-label="Run script" className="max-w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {entries.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.id}
                {e.default && <span className="text-xs text-muted-foreground">default</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {toggle?.kind === "stop" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => stop.mutate({ workspaceId, runId: toggle.runId })}
          >
            <SquareIcon aria-hidden />
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || archived}
            onClick={() => {
              setShownRunId(null);
              start.mutate({ workspaceId, scriptId: script.id });
            }}
          >
            <PlayIcon aria-hidden />
            Start
          </Button>
        )}
        {isShortcutTarget && <ShortcutKbd action="toggleRun" />}
        {history.length > 0 && shown && (
          <Select value={shown.id} onValueChange={setShownRunId}>
            <SelectTrigger size="sm" aria-label="Past runs" className="ml-auto max-w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {history.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  <span className={cn("inline-flex items-center gap-1.5", TONE_CLASS[runTone(r)])}>
                    {r.status === "running" && <Spinner className="size-3" />}
                    {formatTime(r.startedAt)}
                  </span>
                  <span className="text-xs text-muted-foreground">{runSummary(r)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <p
        className="truncate border-b px-3 py-1 font-mono text-xs text-muted-foreground"
        title={script.command}
      >
        {script.cwd ? `${script.cwd}$ ` : "$ "}
        {shown?.command ?? script.command}
      </p>
      {shown ? (
        <ScriptOutput
          key={shown.id}
          workspaceId={workspaceId}
          runId={shown.id}
          label={`Output of ${script.id}`}
          empty={shown.status === "running" ? "Waiting for output…" : "No output."}
        />
      ) : isPending ? (
        <SkeletonRows rows={4} />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <EmptyState title="Not started yet." description="Start the script to see its output." />
      )}
    </div>
  );
}
