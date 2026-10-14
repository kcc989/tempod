import { Link } from "@tanstack/react-router";
import type { Project, WorkspaceSummary } from "@tempo/protocol";
import {
  ArchiveIcon,
  CopyIcon,
  ExternalLinkIcon,
  MoonIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PowerIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { InlineEdit } from "~/ui/components/topbar/InlineEdit";
import {
  canArchive,
  githubUrlFor,
  powerAction,
  topPrimary,
  workspaceView,
} from "~/ui/components/topbar/topbar-logic";
import { useWorkspaceActions } from "~/ui/components/topbar/useWorkspaceActions";
import { Button } from "~/ui/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/ui/components/ui/context-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/ui/components/ui/hover-card";
import { Skeleton } from "~/ui/components/ui/skeleton";
import { useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative } from "~/ui/lib/format";
import { pillText, statusIndicator } from "~/ui/lib/indicators";
import { projectChecksUrl } from "~/ui/lib/links";
import { cn } from "~/ui/lib/utils";
import { setPhonePane } from "~/ui/state/workspace-ui";
import { ChecksDot, PrBadge, StatusIcon } from "./indicators";
import { CHECKS_LABELS, PR_STATE_LABELS, isBold } from "./sidebar-logic";

/**
 * 04, Workspace row: one line with status icon, title (bold when unread or waiting), PR badge and
 * checks dot. Branch and state are in the hover card after 400 ms and in the accessible name.
 */
export function WorkspaceRow({
  workspace: w,
  project,
  phone,
}: {
  workspace: WorkspaceSummary;
  project: Project | undefined;
  phone: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameRequested = useRef(false);
  const status = statusIndicator(w)?.tooltip ?? pillText(w.state, { op: null }).text;
  const branch = w.branch.split("/").at(-1) === w.title ? "" : w.branch;
  const slug = w.slug !== w.title && w.branch.split("/").at(-1) !== w.slug ? w.slug : "";
  const detail = [branch, slug].filter(Boolean).join(" · ");

  const metadata = <span className="sr-only">{[detail, status].filter(Boolean).join(" · ")}</span>;

  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusIcon workspace={w} />
        <span className={cn("min-w-0 flex-1 truncate", isBold(w) && "font-semibold")}>{w.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <PrBadge workspace={w} />
          <ChecksDot workspace={w} />
        </span>
      </span>
      {metadata}
    </>
  );

  const rowClass = cn(
    "flex min-w-0 flex-col gap-0.5 rounded-md px-3 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:bg-sidebar-accent",
    "py-2",
  );

  if (renaming) {
    return (
      <div className={rowClass}>
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusIcon workspace={w} />
          <RenameField
            workspaceId={w.id}
            title={w.title}
            onDone={() => {
              renameRequested.current = false;
              setRenaming(false);
            }}
          />
        </span>
        {metadata}
      </div>
    );
  }

  return (
    <ContextMenu>
      <HoverCard>
        <ContextMenuTrigger asChild>
          <HoverCardTrigger asChild>
            <Link
              to="/w/$workspaceId"
              params={{ workspaceId: w.id }}
              onClick={() => phone && setPhonePane("chat")}
              className={rowClass}
            >
              {body}
            </Link>
          </HoverCardTrigger>
        </ContextMenuTrigger>
        {!phone && (
          <HoverCardContent side="right" align="start" className="w-72">
            <RowHoverCard workspace={w} project={project} />
          </HoverCardContent>
        )}
      </HoverCard>
      <ContextMenuContent
        className="w-52"
        onCloseAutoFocus={(e) => {
          if (renameRequested.current) {
            e.preventDefault();
            renameRequested.current = false;
          }
        }}
      >
        <RowMenu
          workspace={w}
          project={project}
          onRename={() => {
            renameRequested.current = true;
            setRenaming(true);
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameField({
  workspaceId,
  title,
  onDone,
}: {
  workspaceId: string;
  title: string;
  onDone: () => void;
}) {
  const actions = useWorkspaceActions(workspaceId);

  return <InlineEdit value={title} label="Workspace title" onSave={actions.rename} onDone={onDone} />;
}

/** 04, Right-click menu: Rename, Pin or Unpin, Copy branch name, Open on GitHub, Archive. */
function RowMenu({
  workspace: w,
  project,
  onRename,
}: {
  workspace: WorkspaceSummary;
  project: Project | undefined;
  onRename: () => void;
}) {
  const actions = useWorkspaceActions(w.id);

  return (
    <>
      <ContextMenuItem onSelect={onRename}>
        <PencilIcon />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.setPinned(!w.pinned)}>
        {w.pinned ? <PinOffIcon /> : <PinIcon />}
        {w.pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void actions.copyBranch(w.branch)}>
        <CopyIcon />
        Copy branch name
      </ContextMenuItem>
      {project && w.prNumber !== null && (
        <ContextMenuItem asChild>
          <a href={githubUrlFor(project, w, undefined)} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon />
            {project.provider === "artifacts" ? "Open pull request" : "Open PR on GitHub"}
          </a>
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!canArchive(w.state)} onSelect={() => actions.archive()}>
        <ArchiveIcon />
        Archive
      </ContextMenuItem>
    </>
  );
}

/** 04, Hover card: state, last activity, PR and checks; the next action, Wake or Sleep, Archive. */
function RowHoverCard({
  workspace: w,
  project,
}: {
  workspace: WorkspaceSummary;
  project: Project | undefined;
}) {
  const detail = useCallQuery("getWorkspace", { workspaceId: w.id }, { staleTime: 10_000 });
  const actions = useWorkspaceActions(w.id);
  const view = workspaceView(w, detail.data) ?? { w, d: null };

  const pill = pillText(view.w.state, {
    op: view.d?.op ?? null,
    instance: view.d?.settings.environment.instance,
  });

  const primary = detail.data ? topPrimary(view) : null;
  const power = powerAction(view.w.state);

  const checksUrl = project && w.prNumber !== null ? projectChecksUrl(project, w.prNumber) : undefined;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusIcon workspace={view.w} op={view.d?.op ?? null} />
        <span className="truncate text-sm font-medium">{view.w.title}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="truncate font-mono">{view.w.branch}</dd>
        <dt className="text-muted-foreground">State</dt>
        <dd className={cn("truncate", pill.tone === "error" && "text-destructive")}>{pill.text}</dd>
        <dt className="text-muted-foreground">Last activity</dt>
        <dd>{formatRelative(view.w.lastActivityAt)}</dd>
        <dt className="text-muted-foreground">PR</dt>
        <dd className="flex items-center gap-1.5">
          {view.w.prNumber === null ? "None" : <PrBadge workspace={view.w} />}
          {view.w.prNumber !== null && view.w.prState && (
            <span className="text-muted-foreground">{PR_STATE_LABELS[view.w.prState]}</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Checks</dt>
        <dd className="flex items-center gap-1.5">
          {view.w.checksState === null ? (
            "None"
          ) : (
            <>
              <ChecksDot workspace={view.w} />
              {CHECKS_LABELS[view.w.checksState]}
            </>
          )}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-1.5">
        {detail.isPending ? (
          <Skeleton className="h-6 w-24" />
        ) : (
          primary &&
          primary.kind !== "archive" && (
            <Button size="sm" onClick={() => void actions.runPrimaryElsewhere(primary.kind, checksUrl)}>
              {primary.label}
            </Button>
          )
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!power.enabled || actions.pending.power}
          onClick={() => (power.kind === "wake" ? actions.wake() : actions.sleep())}
        >
          {power.kind === "wake" ? <PowerIcon /> : <MoonIcon />}
          {power.label}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canArchive(view.w.state) || actions.pending.archive}
          onClick={() => actions.archive()}
        >
          <ArchiveIcon />
          Archive
        </Button>
      </div>
    </div>
  );
}
