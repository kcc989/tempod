import { Link } from "@tanstack/react-router";
import type { Project } from "@tempo/protocol";
import {
  ArrowUpDownIcon,
  Building2Icon,
  ChevronRightIcon,
  CompassIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  HistoryIcon,
  PlusIcon,
  PinIcon,
  SearchIcon,
  SettingsIcon,
  StarIcon,
} from "lucide-react";
import { useMemo } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/ui/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/ui/components/ui/dropdown-menu";
import { ScrollArea } from "~/ui/components/ui/scroll-area";
import { useHub } from "~/ui/hooks/useHub";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";
import { useProjects } from "~/ui/hooks/useProjects";
import { sidebarSections, type SidebarSection, type SortMode } from "~/ui/stores/hub-state";
import { openDialog } from "~/ui/state/workspace-ui";
import {
  COLLAPSED_KEY,
  DEFAULT_SORT,
  NO_COLLAPSED,
  SORT_KEY,
  SORT_LABELS,
  isSortMode,
  isStringList,
  projectLabel,
  toggleCollapsed,
} from "./sidebar-logic";
import { WorkspaceRow } from "./WorkspaceRow";

export interface SidebarProps {
  /** `panel`: the resizable desktop sidebar. `phone`: the full-width Workspaces pane. */
  readonly variant?: "panel" | "phone";
}

/**
 * 04, Sidebar: every non-archived workspace grouped by project, live from the hub channel. Pinned
 * first (only if any), then one section per project in sort_order, then History.
 */
export function Sidebar({ variant = "panel" }: SidebarProps) {
  const phone = variant === "phone";
  const hub = useHub();
  const projects = useProjects();
  const [sort, setSort] = useLocalStorage(SORT_KEY, DEFAULT_SORT, isSortMode);
  const [collapsed, setCollapsed] = useLocalStorage(COLLAPSED_KEY, NO_COLLAPSED, isStringList);

  const sections = useMemo(
    () => sidebarSections(hub.workspaces, projects.data ?? [], sort),
    [hub.workspaces, projects.data, sort],
  );

  const byId = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);

  let content;

  if (projects.isError) {
    content = <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  } else if (!hub.ready || projects.isPending) {
    content = <SkeletonRows rows={8} />;
  } else if (projects.data.length === 0) {
    content = (
      <EmptyState
        icon={FolderGit2Icon}
        title="Link a repo to start."
        action={
          <Button size="sm" onClick={() => openDialog({ kind: "addProject" })}>
            Add project
          </Button>
        }
      />
    );
  } else {
    content = (
      <nav aria-label="Workspaces" className="flex flex-col gap-4 px-2 pt-1 pb-3">
        {sections.map((section) => (
          <Section
            key={section.key}
            section={section}
            label={section.projectId ? projectName(byId.get(section.projectId)) : "Pinned"}
            byId={byId}
            open={!collapsed.includes(section.key)}
            onToggle={() => setCollapsed((c) => toggleCollapsed(c, section.key))}
            phone={phone}
          />
        ))}
      </nav>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <nav aria-label="Workspace actions" className="flex shrink-0 flex-col gap-1 border-b px-3 py-3">
        <Button
          size="sm"
          variant="ghost"
          className="h-9 justify-start gap-3 text-sm font-normal"
          onClick={() => openDialog({ kind: "newWorkspace" })}
        >
          <PlusIcon />
          New workspace
          {!phone && (
            <span aria-hidden className="ml-auto text-xs text-muted-foreground">
              ⌥N
            </span>
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9 justify-start gap-3 text-sm font-normal"
          onClick={() => openDialog({ kind: "palette" })}
        >
          <SearchIcon />
          Search workspaces
          {!phone && (
            <span aria-hidden className="ml-auto text-xs text-muted-foreground">
              ⌘K
            </span>
          )}
        </Button>
      </nav>
      <div className="flex h-9 shrink-0 items-center gap-1 px-3">
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">Projects</span>
        <SortMenu sort={sort} onSort={setSort} />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Add project"
          onClick={() => openDialog({ kind: "addProject" })}
        >
          <FolderPlusIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">{content}</ScrollArea>
      <div className="flex shrink-0 flex-col gap-1 border-t px-3 py-3">
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-9 w-full justify-start gap-3 text-sm font-normal"
        >
          <Link to="/repositories">
            <FolderGit2Icon />
            Repositories
          </Link>
        </Button>
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-9 w-full justify-start gap-3 text-sm font-normal"
        >
          <Link to="/explore">
            <CompassIcon />
            Explore
          </Link>
        </Button>
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-9 w-full justify-start gap-3 text-sm font-normal"
        >
          <Link to="/stars">
            <StarIcon />
            Stars
          </Link>
        </Button>
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-9 w-full justify-start gap-3 text-sm font-normal"
        >
          <Link to="/organizations">
            <Building2Icon />
            Organizations
          </Link>
        </Button>
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-9 w-full justify-start gap-3 text-sm font-normal"
        >
          <Link to="/history">
            <HistoryIcon />
            Archived workspaces
          </Link>
        </Button>
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-9 w-full justify-start gap-3 text-sm font-normal"
        >
          <Link to="/history" search={{ view: "saved" }}>
            <HistoryIcon />
            Saved chats
          </Link>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Settings"
          className="h-9 w-full justify-start gap-3 text-sm font-normal"
          onClick={() => openDialog({ kind: "settings" })}
        >
          <SettingsIcon />
          Settings
          {!phone && <span className="ml-auto text-xs text-muted-foreground">⌥,</span>}
        </Button>
      </div>
    </div>
  );
}

const projectName = (p: Project | undefined): string => (p ? projectLabel(p) : "Project");

/** 04: newest last activity first; a header menu switches to created_at. */
function SortMenu({ sort, onSort }: { sort: SortMode; onSort: (s: SortMode) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Sort workspaces: ${SORT_LABELS[sort]}`}>
          <ArrowUpDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort} onValueChange={(v) => isSortMode(v) && onSort(v)}>
          <DropdownMenuRadioItem value="activity">{SORT_LABELS.activity}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">{SORT_LABELS.created}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Pinned or one project: `owner/name`, a collapse toggle and `+` (New workspace with that project). */
function Section({
  section,
  label,
  byId,
  open,
  onToggle,
  phone,
}: {
  section: SidebarSection;
  label: string;
  byId: ReadonlyMap<string, Project>;
  open: boolean;
  onToggle: () => void;
  phone: boolean;
}) {
  const projectId = section.projectId;

  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <div className="mb-1 flex h-9 items-center gap-0.5">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 h-9 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 [&[data-state=open]>svg]:rotate-90"
          >
            <ChevronRightIcon aria-hidden className="size-3 shrink-0 transition-transform" />
            {projectId ? (
              <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <PinIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="flex-1 truncate text-left">{label}</span>
            {section.workspaces.length > 0 && (
              <span className="pl-1 text-xs font-normal text-muted-foreground tabular-nums">
                {section.workspaces.length}
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        {projectId && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`New workspace in ${label}`}
            className="text-muted-foreground"
            onClick={() => openDialog({ kind: "newWorkspace", projectId })}
          >
            <PlusIcon />
          </Button>
        )}
      </div>
      <CollapsibleContent>
        {section.workspaces.length === 0 && projectId ? (
          <Button
            size="sm"
            variant="ghost"
            className="w-full justify-start pl-6 font-normal text-muted-foreground"
            onClick={() => openDialog({ kind: "newWorkspace", projectId })}
          >
            Start a workspace
          </Button>
        ) : (
          <ul className="flex flex-col gap-1">
            {section.workspaces.map((w) => (
              <li key={w.id}>
                <WorkspaceRow workspace={w} project={byId.get(w.projectId)} phone={phone} />
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
