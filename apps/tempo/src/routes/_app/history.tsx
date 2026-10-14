import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { WorkspaceSummary } from "@tempo/protocol";
import { ArchiveIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ProjectConversations } from "~/ui/components/history/ProjectConversations";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { ScrollArea } from "~/ui/components/ui/scroll-area";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useHub } from "~/ui/hooks/useHub";
import { useProjects } from "~/ui/hooks/useProjects";
import { formatRelative } from "~/ui/lib/format";
import { CONFIRM_TEXT, confirm } from "~/ui/state/workspace-ui";

export const Route = createFileRoute("/_app/history")({
  validateSearch: (search: Record<string, unknown>): { view?: "saved" } => ({
    view: search.view === "saved" ? "saved" : undefined,
  }),
  component: HistoryPage,
});

/** 04, Sidebar → History: archived workspaces with Restore and Delete. */
function HistoryPage() {
  const [saved, setSaved] = useState(Route.useSearch().view === "saved");
  const list = useCallQuery("listWorkspaces", { includeArchived: true });
  const hub = useHub();
  const projects = useProjects();

  const archived = useMemo(
    () =>
      (list.data ?? [])
        .map((w) => {
          const live = hub.workspaces[w.id];

          return live && live.rev > w.rev ? live : w;
        })
        .filter((w) => w.state === "archived")
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [list.data, hub.workspaces],
  );

  const projectName = (id: string) => {
    const p = projects.data?.find((x) => x.id === id);

    return p ? `${p.owner}/${p.name}` : "";
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center border-b px-3">
        <h1 className="mr-3 text-sm font-semibold">History</h1>
        <Button
          size="sm"
          variant={saved ? "ghost" : "secondary"}
          aria-pressed={!saved}
          onClick={() => setSaved(false)}
        >
          Archived workspaces
        </Button>
        <Button
          size="sm"
          variant={saved ? "secondary" : "ghost"}
          aria-pressed={saved}
          onClick={() => setSaved(true)}
        >
          Saved chats
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {saved ? (
          projects.isPending ? (
            <SkeletonRows rows={5} />
          ) : projects.isError ? (
            <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
          ) : (
            <>
              <p className="p-3 text-xs text-muted-foreground">
                Conversations remain available after a workspace is deleted.
              </p>
              {projects.data.map((project) => (
                <ProjectConversations key={project.id} project={project} />
              ))}
            </>
          )
        ) : list.isPending ? (
          <SkeletonRows rows={8} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : archived.length === 0 ? (
          <EmptyState icon={ArchiveIcon} title="No archived workspaces." />
        ) : (
          <ul className="flex flex-col divide-y">
            {archived.map((w) => (
              <HistoryRow key={w.id} workspace={w} project={projectName(w.projectId)} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function HistoryRow({ workspace: w, project }: { workspace: WorkspaceSummary; project: string }) {
  const navigate = useNavigate();

  const restore = useCallMutation("restoreWorkspace", {
    invalidates: ["listWorkspaces"],
    onSuccess: () => navigate({ to: "/w/$workspaceId", params: { workspaceId: w.id } }),
  });

  const remove = useCallMutation("deleteWorkspace", {
    invalidates: ["listWorkspaces", "listProjectConversations"],
  });

  const onDelete = async () => {
    if (await confirm(CONFIRM_TEXT.deleteWorkspace(w.slug))) remove.mutate({ workspaceId: w.id });
  };

  const busy = restore.isPending || remove.isPending;

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{w.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {[
            project,
            `${w.branch} · ${w.slug}`,
            w.archivedAt ? `archived ${formatRelative(w.archivedAt)}` : null,
          ]
            .filter(Boolean)
            .join(" — ")}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => restore.mutate({ workspaceId: w.id })}
      >
        Restore
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        disabled={busy}
        onClick={() => void onDelete()}
      >
        Delete
      </Button>
    </li>
  );
}
