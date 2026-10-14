import type { ProjectSummary } from "@tempo/protocol";
import { Link } from "@tanstack/react-router";
import { FolderGit2Icon, GitBranchIcon, StarIcon } from "lucide-react";
import { Badge } from "~/ui/components/ui/badge";

/** 04, Project card. */
export function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <li className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <Link
          to="/$namespace/$slug"
          params={{ namespace: project.namespace, slug: project.slug }}
          className="flex min-w-0 items-center gap-2 font-medium text-primary hover:underline"
        >
          <FolderGit2Icon className="size-4 shrink-0" />
          <span className="truncate">
            {project.namespace}/{project.slug}
          </span>
        </Link>
        <div className="flex shrink-0 gap-1">
          {project.visibility === "private" && <Badge variant="outline">Private</Badge>}
          <Badge variant="muted">{project.provider === "artifacts" ? "Artifacts" : "GitHub"}</Badge>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-mono">
          <GitBranchIcon className="size-3" />
          {project.defaultBranch}
        </span>
        <span className="inline-flex items-center gap-1" aria-label={`${project.stars} stars`}>
          <StarIcon className="size-3" />
          {project.stars}
        </span>
      </div>
    </li>
  );
}
