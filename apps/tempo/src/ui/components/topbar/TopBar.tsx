import { SharedHeaderRegion, useAppHeader } from "~/ui/components/shell/AppHeader";
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
import { useLayout, useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { isRightOpen, toggleRight } from "~/ui/state/workspace-ui";
import { requestCommit } from "./commit-request";
import { EditableBranch } from "./EditableBranch";
import { InlineEdit } from "./InlineEdit";
import { WorkspaceInfoButton } from "./WorkspaceInfoButton";
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
 * 04, Top bar, one row. Left: branch with copy on hover or focus, and the PR link. Middle: preview
 * ports, then `Live` during a Browser Run session. Right: Wake while sleeping, the primary git action, the
 * Info button and the right-side toggle.
 */
export function TopBar({ workspaceId, variant = "desktop" }: TopBarProps) {
  const summary = useHubWorkspace(workspaceId);
  const detail = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const view = workspaceView(summary, detail);
  const actions = useWorkspaceActions(workspaceId);
  useGitShortcuts(workspaceId, view, actions, variant === "desktop");

  if (!view) {
    const loading = (
      <header aria-busy="true" className="flex h-10 shrink-0 items-center gap-2 border-b bg-card px-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="ml-auto h-5 w-24 rounded-full" />
      </header>
    );

    return variant === "phone" ? loading : <SharedHeaderRegion region="center">{loading}</SharedHeaderRegion>;
  }

  return variant === "phone" ? (
    <PhoneTopBar view={view} actions={actions} />
  ) : (
    <SharedHeaderRegion region="center">
      <DesktopTopBar view={view} actions={actions} />
    </SharedHeaderRegion>
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
  const sharedHeader = useAppHeader();
  const layout = useLayout();
  const rightOpen = useWorkspaceUiSelector(w.id, (ui) => isRightOpen(layout, ui));

  return (
    <header
      className={cn(
        "flex h-10 min-w-0 shrink-0 items-center gap-3 py-1 pr-3 pl-2",
        sharedHeader ? "bg-transparent" : "border-b bg-card",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="group/branch flex min-w-0 flex-1 items-center gap-0.5 font-mono text-xs text-muted-foreground">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <EditableBranch view={view} onSave={actions.renameBranch} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy branch name"
            className="size-6 opacity-0 group-hover/branch:opacity-100 group-focus-within/branch:opacity-100 focus-visible:opacity-100"
            onClick={() => void actions.copyBranch(w.branch)}
          >
            <CopyIcon className="size-3" />
          </Button>
        </span>
        <PrLinkAnchor workspace={w} />
      </div>
      <PortLinks
        workspaceId={w.id}
        ports={d?.ports ?? []}
        browserActive={d?.browserActive ?? false}
        className="flex-1 justify-center"
      />
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {w.state === "sleeping" && <ContainerPill pill={pillFor(view)} onWake={actions.wake} />}
        <PrimaryActionButton workspaceId={w.id} />
        <WorkspaceInfoButton view={view} />
        <SimpleTooltip label="Toggle right side (⌘⌥B)">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Toggle right side"
            aria-pressed={rightOpen}
            onClick={toggleRight}
          >
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
        {w.title !== w.slug && w.branch.split("/").at(-1) !== w.title && (
          <EditableTitle title={w.title} onSave={actions.rename} />
        )}
        <div className="flex min-w-0 items-center font-mono text-xs text-muted-foreground">
          <EditableBranch view={view} onSave={actions.renameBranch} />
        </div>
      </div>
      <ContainerPill
        pill={pillFor(view)}
        className="max-w-32"
        onWake={w.state === "sleeping" ? actions.wake : undefined}
      />
      <WorkspaceInfoButton view={view} phone />
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
