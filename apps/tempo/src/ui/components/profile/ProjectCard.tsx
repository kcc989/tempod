import type { ProjectSummary } from "@tempo/protocol";
import { Link } from "@tanstack/react-router";
import { FolderGit2Icon, GitBranchIcon } from "lucide-react";
import { Badge } from "~/ui/components/ui/badge";

/** 04, Public profile: project card. */
export function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <li className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <Link
          to="/$username/$slug"
          params={{ username: project.username, slug: project.slug }}
          className="flex min-w-0 items-center gap-2 font-medium text-primary hover:underline"
        >
          <FolderGit2Icon className="size-4 shrink-0" />
          <span className="truncate">
            {project.username}/{project.slug}
          </span>
        </Link>
        <div className="flex shrink-0 gap-1">
          {project.pinned && <Badge variant="outline">Pinned</Badge>}
          <Badge variant="muted">{project.provider === "artifacts" ? "Artifacts" : "GitHub"}</Badge>
        </div>
      </div>
      <span className="mt-4 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
        <GitBranchIcon className="size-3" />
        {project.defaultBranch}
      </span>
    </li>
  );
}
