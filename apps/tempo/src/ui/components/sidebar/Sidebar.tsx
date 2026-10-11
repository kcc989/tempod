import { Link } from "@tanstack/react-router";
import { HistoryIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useMemo } from "react";
import { SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { ScrollArea } from "~/ui/components/ui/scroll-area";
import { useHub } from "~/ui/hooks/useHub";
import { useProjects } from "~/ui/hooks/useProjects";
import { sidebarSections } from "~/ui/stores/hub-state";
import { openDialog, setPhonePane } from "~/ui/state/workspace-ui";

export interface SidebarProps {
  /** `panel`: the resizable desktop sidebar. `phone`: the full-width Workspaces pane. */
  readonly variant?: "panel" | "phone";
}

/** REGION A placeholder: the workspace list grouped by project (04, Sidebar). */
export function Sidebar({ variant = "panel" }: SidebarProps) {
  const hub = useHub();
  const projects = useProjects();
  const sections = useMemo(
    () => sidebarSections(hub.workspaces, projects.data ?? [], "activity"),
    [hub.workspaces, projects.data],
  );
  const projectName = (id: string | null) => {
    const p = projects.data?.find((x) => x.id === id);
    return p ? `${p.owner}/${p.name}` : "Pinned";
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">Workspaces</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Add project"
          onClick={() => openDialog({ kind: "addProject" })}
        >
          <PlusIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {!hub.ready || projects.isPending ? (
          <SkeletonRows rows={8} />
        ) : (
          <nav aria-label="Workspaces" className="flex flex-col gap-3 p-2">
            {sections.map((section) => (
              <div key={section.key} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                  <span className="truncate">{projectName(section.projectId)}</span>
                  {section.projectId && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="New workspace"
                      onClick={() => openDialog({ kind: "newWorkspace", projectId: section.projectId! })}
                    >
                      <PlusIcon />
                    </Button>
                  )}
                </div>
                {section.workspaces.map((w) => (
                  <Link
                    key={w.id}
                    to="/w/$workspaceId"
                    params={{ workspaceId: w.id }}
                    onClick={() => variant === "phone" && setPhonePane("chat")}
                    className="flex flex-col rounded-md px-2 py-1 hover:bg-sidebar-accent data-[status=active]:bg-sidebar-accent"
                  >
                    <span
                      className={
                        w.attention === "unread" || w.attention === "needs_input"
                          ? "truncate font-semibold"
                          : "truncate"
                      }
                    >
                      {w.title}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {w.branch} · {w.slug}
                    </span>
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        )}
      </ScrollArea>
      <div className="flex shrink-0 items-center justify-between border-t px-2 py-1.5">
        <Button asChild size="sm" variant="ghost">
          <Link to="/history">
            <HistoryIcon />
            History
          </Link>
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Settings"
          onClick={() => openDialog({ kind: "settings" })}
        >
          <SettingsIcon />
        </Button>
      </div>
    </div>
  );
}
