import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, FolderGit2Icon } from "lucide-react";
import { RepositoryCode, RepositoryCommits } from "~/ui/components/repositories/RepositoryCode";
import type { RepositorySearch } from "~/ui/components/repositories/model";
import { EmptyState, ErrorState, NotFoundState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useCallQuery } from "~/ui/hooks/useCall";
import { githubRepoUrl } from "~/ui/lib/links";
import { errorCode } from "~/ui/lib/toast";

/** 04, `/:username/:slug`: a public project's code, read only. */
export function PublicProjectPage({
  username,
  slug,
  search,
  onNavigate,
  owner,
}: {
  username: string;
  slug: string;
  search: RepositorySearch;
  onNavigate: (search: RepositorySearch) => void;
  /** Only the owner signs in (11), so a session means the owner. */
  owner: boolean;
}) {
  const project = useCallQuery("getPublicProject", { username, slug });

  if (project.isPending) return <SkeletonRows rows={6} />;

  if (project.isError)
    return errorCode(project.error) === "NOT_FOUND" ? (
      <NotFoundState
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/$username" params={{ username }}>
              {username}
            </Link>
          </Button>
        }
      />
    ) : (
      <ErrorState error={project.error} onRetry={() => void project.refetch()} />
    );
  const p = project.data;
  const tab = search.tab === "commits" ? "commits" : "code";

  // The repository components link with `project`; the public route names it in the path instead.
  const navigate = ({ project: _project, ...rest }: RepositorySearch) => onNavigate(rest);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
        <FolderGit2Icon className="size-5 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
          <Link to="/$username" params={{ username: p.username }} className="hover:underline">
            {p.username}
          </Link>
          /{p.slug}
        </h1>
        <Badge variant="outline">Public</Badge>
        <Badge variant="muted">{p.provider === "artifacts" ? "Artifacts" : "GitHub"}</Badge>
        {owner && (
          <Button asChild size="sm" variant="outline">
            <Link to="/repositories" search={{ project: p.id }}>
              Open in Tempo
            </Link>
          </Button>
        )}
      </header>
      {p.provider !== "artifacts" ? (
        <EmptyState
          title="GitHub repository"
          action={
            <Button asChild>
              <a href={githubRepoUrl(p.owner, p.name)} target="_blank" rel="noopener noreferrer">
                Open on GitHub
                <ExternalLinkIcon />
              </a>
            </Button>
          }
        />
      ) : (
        <>
          <div className="border-b px-5 py-2">
            <Tabs
              value={tab}
              onValueChange={(value) => {
                const next: RepositorySearch = value === "commits" ? { tab: "commits" } : {};

                onNavigate(search.ref ? { ...next, ref: search.ref } : next);
              }}
            >
              <TabsList aria-label="Repository sections">
                <TabsTrigger value="code">Code</TabsTrigger>
                <TabsTrigger value="commits">Commits</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "commits" ? (
              <RepositoryCommits
                key={search.ref ?? p.defaultBranch}
                project={{ id: p.id, name: p.slug, defaultBranch: p.defaultBranch }}
                search={{ ...search, project: p.id }}
                onNavigate={navigate}
              />
            ) : (
              <RepositoryCode
                project={{ id: p.id, name: p.slug, defaultBranch: p.defaultBranch }}
                search={{ ...search, project: p.id }}
                onNavigate={navigate}
                publicView
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
