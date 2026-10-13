import { useApiCall } from "~/ui/hooks/useCall";
import {
  ArchiveIcon,
  BookOpenIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LaptopIcon,
  LinkIcon,
  MoonIcon,
  NetworkIcon,
  PowerIcon,
  PencilIcon,
  RotateCwIcon,
  StethoscopeIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "~/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "~/ui/components/ui/dropdown-menu";
import { useProject } from "~/ui/hooks/useProjects";
import { macWorkspaceUrl } from "~/ui/lib/links";
import { formatBinding } from "~/ui/lib/shortcuts";
import { openDialog, openGuide, setPhonePane } from "~/ui/state/workspace-ui";
import { BaseBranchMenu } from "./BaseBranchPicker";
import { openLiveViewTab, openPreviewTab } from "./open-preview";
import { LiveDot } from "./PortLinks";
import { canArchive, githubUrlFor, powerAction, type WorkspaceView } from "./topbar-logic";
import type { WorkspaceActions } from "./useWorkspaceActions";

/**
 * 04, Overflow menu: Wake or Sleep, Reset preview access, Open on GitHub, Copy workspace link,
 * Environment…, Diagnostics, Open in Tempo for Mac (07), Archive. Phones also list the preview links and `Live` here.
 */
export function OverflowMenu({
  view,
  actions,
  phone = false,
  onRename,
}: {
  view: WorkspaceView;
  actions: WorkspaceActions;
  phone?: boolean;
  onRename?: () => void;
}) {
  const call = useApiCall();

  const { w, d } = view;
  const renameChosen = useRef(false);
  const [open, setOpen] = useState(false);
  const project = useProject(w.projectId);
  const power = powerAction(w.state);
  const ports = phone ? (d?.ports ?? []) : [];
  const live = phone && (d?.browserActive ?? false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-60"
        onCloseAutoFocus={(event) => {
          if (renameChosen.current) {
            event.preventDefault();
            renameChosen.current = false;
          }
        }}
      >
        <BaseBranchMenu
          workspaceId={w.id}
          projectId={w.projectId}
          branch={w.branch}
          baseBranch={w.baseBranch}
          locked={w.prNumber !== null || w.state === "archived" || w.state === "archiving"}
          onDone={() => setOpen(false)}
        />
        <DropdownMenuItem
          onSelect={() => {
            openGuide(w.id);
            if (phone) setPhonePane("chat");
          }}
        >
          <BookOpenIcon />
          Open guide
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {onRename && (
          <DropdownMenuItem
            onSelect={() => {
              renameChosen.current = true;
              onRename();
            }}
          >
            <PencilIcon />
            Rename workspace
          </DropdownMenuItem>
        )}
        {(ports.length > 0 || live) && (
          <>
            <DropdownMenuLabel>Previews</DropdownMenuLabel>
            {ports.map((p) => (
              <DropdownMenuItem key={p.port} onSelect={() => void openPreviewTab(w.id, p.port, call)}>
                <ExternalLinkIcon />
                <span className="font-mono tabular-nums">{p.port} ↗</span>
              </DropdownMenuItem>
            ))}
            {live && (
              <DropdownMenuItem onSelect={() => void openLiveViewTab(w.id, call)}>
                <span className="flex size-4 items-center justify-center">
                  <LiveDot />
                </span>
                Live
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          disabled={!power.enabled || actions.pending.power}
          onSelect={() => (power.kind === "wake" ? actions.wake() : actions.sleep())}
        >
          {power.kind === "wake" ? <PowerIcon /> : <MoonIcon />}
          {power.label}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={w.state === "archived" || w.state === "archiving"}
          onSelect={() => void actions.resetPreviewAccess()}
        >
          <RotateCwIcon />
          Reset preview access
        </DropdownMenuItem>
        {project ? (
          <DropdownMenuItem asChild>
            <a href={githubUrlFor(project, w, d?.pushed)} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon />
              Open on GitHub
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>
            <ExternalLinkIcon />
            Open on GitHub
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void actions.copyLink()}>
          <LinkIcon />
          Copy workspace link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: "environment", workspaceId: w.id })}>
          <NetworkIcon />
          Environment…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: "diagnostics", workspaceId: w.id })}>
          <StethoscopeIcon />
          Diagnostics
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={macWorkspaceUrl(w.id)}>
            <LaptopIcon />
            Open in Tempo for Mac
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!canArchive(w.state) || actions.pending.archive}
          onSelect={() => actions.archive()}
        >
          <ArchiveIcon />
          Archive
          {!phone && <DropdownMenuShortcut>{formatBinding("archive")}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
