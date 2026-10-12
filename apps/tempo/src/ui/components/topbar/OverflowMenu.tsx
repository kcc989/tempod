import {
  ArchiveIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LaptopIcon,
  LinkIcon,
  MoonIcon,
  NetworkIcon,
  PowerIcon,
  RotateCwIcon,
  StethoscopeIcon,
} from "lucide-react";
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
import { openDialog } from "~/ui/state/workspace-ui";
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
}: {
  view: WorkspaceView;
  actions: WorkspaceActions;
  phone?: boolean;
}) {
  const { w, d } = view;
  const project = useProject(w.projectId);
  const power = powerAction(w.state);
  const ports = phone ? (d?.ports ?? []) : [];
  const live = phone && (d?.browserActive ?? false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {(ports.length > 0 || live) && (
          <>
            <DropdownMenuLabel>Previews</DropdownMenuLabel>
            {ports.map((p) => (
              <DropdownMenuItem key={p.port} onSelect={() => void openPreviewTab(w.id, p.port)}>
                <ExternalLinkIcon />
                <span className="font-mono tabular-nums">{p.port} ↗</span>
              </DropdownMenuItem>
            ))}
            {live && (
              <DropdownMenuItem onSelect={() => void openLiveViewTab(w.id)}>
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
