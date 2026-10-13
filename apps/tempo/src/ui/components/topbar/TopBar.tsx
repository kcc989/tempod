import type { WorkspaceSummary } from "@tempo/protocol";
import { CopyIcon, GitBranchIcon, PanelRightIcon } from "lucide-react";
import { useState } from "react";
import { ContainerPill, StatusIcon } from "~/ui/components/sidebar/indicators";
import { Button } from "~/ui/components/ui/button";
import { Skeleton } from "~/ui/components/ui/skeleton";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useAction } from "~/ui/hooks/useActions";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useProject } from "~/ui/hooks/useProjects";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { pillText } from "~/ui/lib/indicators";
import { cn } from "~/ui/lib/utils";
import { toggleRight } from "~/ui/state/workspace-ui";
import { BaseBranchPicker } from "./BaseBranchPicker";
import { requestCommit } from "./commit-request";
import { EditableBranch } from "./EditableBranch";
import { InlineEdit } from "./InlineEdit";
import { OverflowMenu } from "./OverflowMenu";
import { PortLinks } from "./PortLinks";
import { PrimaryActionButton } from "./PrimaryAction";
import { prLink, shortcutAvailability, workspaceView, type WorkspaceView } from "./topbar-logic";
import { useWorkspaceActions, type WorkspaceActions } from "./useWorkspaceActions";

export interface TopBarProps {
  readonly workspaceId: string;
  /** `phone`: a compact bar above the chat or changes pane. */
  readonly variant?: "desktop" | "phone";
}

/**
 * 04, Top bar. Left: title (click to edit), branch with copy, `→ <base>`, the PR link. Middle: preview
 * ports, then `Live` during a Browser Run session. Right: container pill, the primary git action, the
 * overflow menu and the right-side toggle.
 */
export function TopBar({ workspaceId, variant = "desktop" }: TopBarProps) {
  const summary = useHubWorkspace(workspaceId);
  const detail = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const view = workspaceView(summary, detail);
  const actions = useWorkspaceActions(workspaceId);
  useGitShortcuts(workspaceId, view, actions, variant === "desktop");

  if (!view) {
    return (
      <header aria-busy="true" className="flex h-10 shrink-0 items-center gap-2 border-b bg-card px-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="ml-auto h-5 w-24 rounded-full" />
      </header>
    );
  }

  return variant === "phone" ? (
    <PhoneTopBar view={view} actions={actions} />
  ) : (
    <DesktopTopBar view={view} actions={actions} />
  );
}

/** ⌥Y, ⌥P, ⌥M, ⌥A. */
function useGitShortcuts(
  workspaceId: string,
  view: WorkspaceView | null,
  actions: WorkspaceActions,
  desktop: boolean,
) {
  const a = view ? shortcutAvailability(view) : null;
  useAction("commitPush", () => requestCommit(workspaceId), { enabled: desktop && !!a?.commitPush });
  useAction("createPr", () => !actions.pending.createPr && actions.createPr(), { enabled: !!a?.createPr });
  useAction("merge", () => !actions.pending.merge && actions.merge(), { enabled: !!a?.merge });
  useAction("archive", () => !actions.pending.archive && actions.archive(), { enabled: !!a?.archive });
}

function pillFor({ w, d }: WorkspaceView) {
  return pillText(w.state, { op: d?.op ?? null, instance: d?.settings.environment.instance });
}

function DesktopTopBar({ view, actions }: { view: WorkspaceView; actions: WorkspaceActions }) {
  const { w, d } = view;

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b bg-card px-2">
      <div className="flex min-w-0 shrink items-center gap-1.5">
        <EditableTitle title={w.title} onSave={actions.rename} />
        <span className="flex min-w-0 items-center gap-0.5 font-mono text-xs text-muted-foreground">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <EditableBranch view={view} onSave={actions.renameBranch} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy branch name"
            className="size-5"
            onClick={() => void actions.copyBranch(w.branch)}
          >
            <CopyIcon className="size-3" />
          </Button>
        </span>
        <BaseBranchPicker
          workspaceId={w.id}
          projectId={w.projectId}
          branch={w.branch}
          baseBranch={w.baseBranch}
          locked={w.prNumber !== null || w.state === "archived" || w.state === "archiving"}
        />
        <PrLinkAnchor workspace={w} />
      </div>
      <PortLinks
        workspaceId={w.id}
        ports={d?.ports ?? []}
        browserActive={d?.browserActive ?? false}
        className="flex-1 justify-center"
      />
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <ContainerPill pill={pillFor(view)} onWake={w.state === "sleeping" ? actions.wake : undefined} />
        <PrimaryActionButton workspaceId={w.id} />
        <OverflowMenu view={view} actions={actions} />
        <SimpleTooltip label="Toggle right side (⌘⌥B)">
          <Button size="icon-sm" variant="ghost" aria-label="Toggle right side" onClick={toggleRight}>
            <PanelRightIcon />
          </Button>
        </SimpleTooltip>
      </div>
    </header>
  );
}

function PrLinkAnchor({ workspace: w }: { workspace: WorkspaceSummary }) {
  const link = prLink(useProject(w.projectId), w);

  if (!link) return null;

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={link.ariaLabel}
      className={cn(
        "shrink-0 rounded-md px-1 font-mono text-xs tabular-nums outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
        link.className,
      )}
    >
      {link.label}
    </a>
  );
}

function PhoneTopBar({ view, actions }: { view: WorkspaceView; actions: WorkspaceActions }) {
  const { w, d } = view;

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-card px-3">
      <StatusIcon workspace={w} op={d?.op ?? null} />
      <div className="flex min-w-0 flex-1 flex-col">
        <EditableTitle title={w.title} onSave={actions.rename} />
        <div className="flex min-w-0 items-center font-mono text-xs text-muted-foreground">
          <EditableBranch view={view} onSave={actions.renameBranch} />
          <span className="truncate"> → {w.baseBranch}</span>
        </div>
      </div>
      <ContainerPill
        pill={pillFor(view)}
        className="max-w-32"
        onWake={w.state === "sleeping" ? actions.wake : undefined}
      />
      <OverflowMenu view={view} actions={actions} phone />
    </header>
  );
}

function EditableTitle({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <InlineEdit
        value={title}
        label="Workspace title"
        onSave={onSave}
        onDone={() => setEditing(false)}
        className="w-56 max-w-full font-semibold"
      />
    );
  }

  return (
    <h1 className="flex min-w-0">
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename"
        className="min-w-0 truncate rounded-md px-1 text-left text-sm font-semibold outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {title}
      </button>
    </h1>
  );
}
