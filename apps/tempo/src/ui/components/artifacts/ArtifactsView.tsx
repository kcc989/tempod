import { ChevronDownIcon } from "lucide-react";
import * as Icons from "lucide-react";

const ArtifactsEmptyIcon = Icons.ShapesIcon;

import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { sessionTitle } from "~/ui/components/chat/chat-tabs-model";
import { Button } from "~/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/components/ui/dropdown-menu";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { formatRelative } from "~/ui/lib/format";
import { openArtifactTab } from "~/ui/state/workspace-ui";
import { ArtifactIcon } from "./ArtifactIcon";
import { artifactGroups } from "./artifact-model";
import { useArtifacts } from "./useArtifacts";

export const NO_ARTIFACTS = "No artifacts yet. Pages and files that agents publish appear here.";

/** 04 Artifacts tab: one row per artifact, newest version first; older versions in its menu. */
export function ArtifactsView({ workspaceId }: { workspaceId: string }) {
  const { artifacts, error, refetch } = useArtifacts(workspaceId);
  const sessions = useWorkspaceSelector(workspaceId, (s) => s.sessions);

  if (!artifacts) return error ? <ErrorState error={error} onRetry={refetch} /> : <SkeletonRows />;
  const groups = artifactGroups(artifacts);

  if (groups.length === 0) return <EmptyState icon={ArtifactsEmptyIcon} title={NO_ARTIFACTS} />;

  return (
    <ul className="min-h-0 flex-1 overflow-auto py-1">
      {groups.map(({ id, versions }) => {
        const newest = versions[0]!;

        return (
          <li key={id} className="group flex items-center gap-1 px-2">
            <button
              type="button"
              onClick={() => openArtifactTab(workspaceId, id, null)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent/60"
            >
              <ArtifactIcon kind={newest.kind} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{newest.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">v{newest.version}</span>
              <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                {sessionTitle(sessions[newest.sessionId])}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelative(newest.createdAt)}
              </span>
            </button>
            {versions.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`Versions of ${newest.title}`}>
                    <ChevronDownIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {versions.map((v) => (
                    <DropdownMenuItem
                      key={v.version}
                      onSelect={() => openArtifactTab(workspaceId, id, v.version)}
                    >
                      v{v.version} · {formatRelative(v.createdAt)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        );
      })}
    </ul>
  );
}
