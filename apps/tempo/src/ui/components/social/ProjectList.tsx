import type { ProjectSummary } from "@tempo/protocol";
import type { UseQueryResult } from "@tanstack/react-query";
import { FolderGit2Icon } from "lucide-react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { ProjectCard } from "./ProjectCard";

/** One page of server-paged project cards; pages hold at most 50 (11, Server functions). */
export const PAGE = 50;

export function ProjectList({
  query,
  label,
  empty,
  offset,
  onOffset,
}: {
  query: UseQueryResult<ReadonlyArray<ProjectSummary>, Error>;
  label: string;
  empty: string;
  offset: number;
  onOffset: (offset: number) => void;
}) {
  if (query.isPending) return <SkeletonRows rows={6} />;

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      {query.data.length === 0 ? (
        <EmptyState icon={FolderGit2Icon} title={offset > 0 ? "No more projects." : empty} />
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2" aria-label={label}>
          {query.data.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </ul>
      )}
      {(offset > 0 || query.data.length === PAGE) && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0}
            onClick={() => onOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={query.data.length < PAGE}
            onClick={() => onOffset(offset + PAGE)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
