import { useEffect } from "react";
import {
  BookOpenIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  InfoIcon,
  LinkIcon,
  MessageCircleIcon,
  SquareTerminalIcon,
  XIcon,
  SettingsIcon,
  ChevronRightIcon,
  BoxesIcon,
  RotateCcwIcon,
  ArchiveIcon,
} from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { BaseBranchPicker } from "~/ui/components/topbar/BaseBranchPicker";
import { powerAction, canArchive, workspaceView } from "~/ui/components/topbar/topbar-logic";
import { useWorkspaceActions } from "~/ui/components/topbar/useWorkspaceActions";
import { pillText } from "~/ui/lib/indicators";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useWorkspace } from "~/ui/hooks/useWorkspace";
import { useProject } from "~/ui/hooks/useProjects";
import { useLive } from "~/ui/components/review/use-review";
import { useCallQuery } from "~/ui/hooks/useCall";
import { macWorkspaceUrl } from "~/ui/lib/links";
import {
  openTab,
  openDialog,
  setPhonePane,
  openGuide,
  selectTool,
  closeWorkspaceInfo,
} from "~/ui/state/workspace-ui";

export function WorkspaceInfo({ workspaceId, phone = false }: { workspaceId: string; phone?: boolean }) {
  const state = useWorkspace(workspaceId);
  const summary = useHubWorkspace(workspaceId);
  const view = workspaceView(summary, state.workspace);
  const actions = useWorkspaceActions(workspaceId);
  const project = useProject(view?.w.projectId ?? "");
  const artifacts = useCallQuery("listArtifacts", { workspaceId });
  const live = useLive(workspaceId);
  const terminals = useCallQuery("listTerminals", { workspaceId }, { enabled: live, retry: false });

  const completed = Object.values(state.turns).filter(
    (t) => t.status !== "running" && t.status !== "queued",
  ).length;

  const { refetch } = artifacts;
  useEffect(() => {
    void refetch();
  }, [completed, state.changesSeq, refetch]);

  if (!view) return <p className="p-4 text-sm text-muted-foreground">Loading workspace…</p>;
  const { w, d } = view;
  const power = powerAction(w.state);

  const chats = Object.values(state.sessions)
    .filter((s) => s.status !== "closed" && !s.roleRunId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const runs = Object.values(state.scriptRuns).filter((r) => r.status === "running");
  const changes = state.changes ?? d?.changes;

  return (
    <div className="max-h-full overflow-y-auto rounded-2xl bg-muted p-4 text-sm" aria-label="Workspace info">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-medium">
          {project ? `${project.owner}/${project.name}` : w.title}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close Info" onClick={() => closeWorkspaceInfo(workspaceId)}>
          <XIcon />
        </Button>
      </div>
      <section className="space-y-3 pb-2">
        <div className="flex items-center justify-between gap-3">
          <span>
            {pillText(w.state, { op: d?.op ?? null, instance: d?.settings.environment.instance }).text}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!power.enabled || actions.pending.power}
            onClick={() => (power.kind === "wake" ? actions.wake() : actions.sleep())}
          >
            {power.label}
          </Button>
        </div>
      </section>
      <section className="py-2 space-y-1">
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => {
            selectTool(workspaceId, "changes");

            if (phone) setPhonePane("tools");
          }}
        >
          <FileDiffIcon />
          Changes
          <span className="ml-auto flex gap-1 text-xs tabular-nums">
            {changes ? (
              <>
                <span className="text-success">+{changes.additions}</span>
                <span className="text-destructive">−{changes.deletions}</span>
              </>
            ) : (
              "Open"
            )}
          </span>
        </Button>
        <Button variant="ghost" className="w-full justify-start" onClick={() => {
          openGuide(workspaceId);

          if (phone) setPhonePane("tools");
        }}>
          <BookOpenIcon />
          Guides
        </Button>
      </section>
      {chats.length > 0 && (
        <section className="border-t py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Open chats</h3>
          {chats.map((s) => (
            <Button
              key={s.id}
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                openTab(workspaceId, { kind: "chat", sessionId: s.id });
                setPhonePane("chat");
              }}
            >
              <MessageCircleIcon />
              <span className="min-w-0 flex-1 truncate text-left">{s.title || "New chat"}</span>
              <span className="text-xs text-muted-foreground">{s.status === "idle" ? "" : s.status}</span>
            </Button>
          ))}
        </section>
      )}
      {(runs.length > 0 || (live && !!terminals.data?.length)) && (
        <section className="border-t py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Running processes</h3>
          {runs.map((r) => (
            <Button
              key={r.id}
              variant="ghost"
              className="w-full justify-start"
              disabled={phone && r.kind !== "setup"}
              title={phone && r.kind !== "setup" ? "Open Tempo on a larger screen for this." : undefined}
              onClick={() => {
                selectTool(workspaceId, r.kind === "setup" ? "setup" : "run");

                if (phone) setPhonePane("tools");
              }}
            >
              <SquareTerminalIcon />
              <span className="min-w-0 flex-1 truncate text-left">{r.scriptId ?? "Setup"}</span>
              <span className="text-xs text-muted-foreground">Running</span>
            </Button>
          ))}
          {live && !!terminals.data?.length && (
            <Button
              variant="ghost"
              className="w-full justify-start"
              disabled={phone}
              title={phone ? "Open Tempo on a larger screen for this." : undefined}
              onClick={() => selectTool(workspaceId, "terminal")}
            >
              <SquareTerminalIcon />
              Terminals<span className="ml-auto text-xs text-muted-foreground">{terminals.data.length}</span>
            </Button>
          )}
        </section>
      )}
      <section className="border-t py-3">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Artifacts</h3>
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => {
            selectTool(workspaceId, "artifacts");

            if (phone) setPhonePane("tools");
          }}
        >
          <BoxesIcon />
          Open artifacts
          <span className="ml-auto text-xs text-muted-foreground">
            {artifacts.data?.length ?? (artifacts.isError ? "Unavailable" : "Loading…")}
          </span>
        </Button>
      </section>
      <details className="group border-t pt-2">
        <summary className="flex cursor-pointer items-center gap-2 rounded-md py-2 text-sm focus-visible:outline focus-visible:outline-ring">
          <SettingsIcon className="size-4" />
          Workspace controls
          <ChevronRightIcon className="ml-auto size-4 group-open:rotate-90" />
        </summary>
        <div className="space-y-2 pt-2">
          <p className="truncate font-mono text-xs" title={w.branch}>
            {w.branch}
          </p>
          <BaseBranchPicker
            workspaceId={w.id}
            projectId={w.projectId}
            branch={w.branch}
            baseBranch={w.baseBranch}
            locked={w.prNumber !== null || w.state === "archived" || w.state === "archiving"}
          />
          <Button variant="ghost" className="w-full justify-start" onClick={() => void actions.copyLink()}>
            <LinkIcon />
            Copy workspace link
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => openDialog({ kind: "environment", workspaceId })}
          >
            <SettingsIcon />
            Environment…
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => openDialog({ kind: "diagnostics", workspaceId })}
          >
            <InfoIcon />
            Diagnostics
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start"
            disabled={w.state === "archived" || w.state === "archiving"}
            onClick={() => void actions.resetPreviewAccess()}
          >
            <RotateCcwIcon />
            Reset preview access
          </Button>
          <Button variant="ghost" className="w-full justify-start" asChild>
            <a href={macWorkspaceUrl(workspaceId)}>
              <ExternalLinkIcon />
              Open in Tempo for Mac
            </a>
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start text-destructive"
            disabled={!canArchive(w.state) || actions.pending.archive}
            onClick={() => actions.archive()}
          >
            <ArchiveIcon />
            Archive workspace
          </Button>
        </div>
      </details>
    </div>
  );
}
