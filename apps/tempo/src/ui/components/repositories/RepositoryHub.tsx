import type { Project } from "@tempo/protocol";
import { ArrowLeftIcon, ExternalLinkIcon, FolderGit2Icon, GitBranchIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useProjects } from "~/ui/hooks/useProjects";
import { useCallQuery } from "~/ui/hooks/useCall";
import { githubRepoUrl } from "~/ui/lib/links";
import { openDialog } from "~/ui/state/workspace-ui";
import { RepositoryCode, RepositoryCommits } from "./RepositoryCode";
import { RepositoryPullRequests } from "./RepositoryPullRequests";
import { RepositoryIssues } from "./RepositoryIssues";
import { isRepositoryTab, repositoryInput, type RepositorySearch } from "./model";

export interface RepositoryHubProps {
  readonly search: RepositorySearch;
  readonly onNavigate: (search: RepositorySearch) => void;
}

export function RepositoryHub({ search, onNavigate }: RepositoryHubProps) {
  const projects = useProjects();
  const [query, setQuery] = useState("");

  if (projects.isPending) return <SkeletonRows rows={6} />;

  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  const project = projects.data.find((p) => p.id === search.project);

  if (search.project && !project)
    return (
      <EmptyState
        title="Repository not found."
        action={<Button onClick={() => onNavigate({})}>All repositories</Button>}
      />
    );

  if (project)
    return <RepositoryDetail key={project.id} project={project} search={search} onNavigate={onNavigate} />;
  const q = query.trim().toLowerCase();
  const shown = projects.data.filter((p) => `${p.owner}/${p.name}`.toLowerCase().includes(q));

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-5">
        <div>
          <h1 className="text-xl font-semibold">Repositories</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your code, issues, pull requests and agent workspaces.
          </p>
        </div>
        <Button onClick={() => openDialog({ kind: "addProject" })}>
          <PlusIcon />
          New repository
        </Button>
      </header>
      <div className="flex flex-1 flex-col gap-4 p-6">
        <Input
          aria-label="Search repositories"
          placeholder="Find a repository…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
        />
        {shown.length === 0 ? (
          <EmptyState
            icon={FolderGit2Icon}
            title={q ? "No matching repositories." : "Create your first repository."}
            description={
              q
                ? undefined
                : "Host your Git repositories on Cloudflare Artifacts, then build and review changes in Tempo."
            }
            action={
              q ? undefined : (
                <Button onClick={() => openDialog({ kind: "addProject" })}>Create repository</Button>
              )
            }
          />
        ) : (
          <ul className="grid gap-3 xl:grid-cols-2" aria-label="Repositories">
            {shown.map((p) => (
              <li key={p.id} className="rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 text-left font-medium text-primary hover:underline"
                    onClick={() => onNavigate({ project: p.id })}
                  >
                    <FolderGit2Icon className="size-4 shrink-0" />
                    <span className="truncate">
                      {p.owner}/{p.name}
                    </span>
                  </button>
                  <Badge variant="muted">{p.provider === "artifacts" ? "Artifacts" : "GitHub"}</Badge>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    <GitBranchIcon className="size-3" />
                    {p.defaultBranch}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      p.provider === "artifacts"
                        ? onNavigate({ project: p.id })
                        : openDialog({ kind: "newWorkspace", projectId: p.id })
                    }
                  >
                    {p.provider === "artifacts" ? "Open repository" : "New workspace"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RepositoryDetail({ project, search, onNavigate }: RepositoryHubProps & { project: Project }) {
  const tab = search.tab ?? "code";

  const metadata = useCallQuery(
    "getRepository",
    repositoryInput(
      project.id,
      tab === "code" ? search.ref : undefined,
      tab === "code" ? (search.path ?? "") : undefined,
    ),
    { enabled: project.provider === "artifacts" && tab !== "issues" },
  );

  const canWrite = project.provider !== "artifacts" || (!!metadata.data && !metadata.data.readOnly);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
        <Button variant="ghost" size="icon-sm" aria-label="All repositories" onClick={() => onNavigate({})}>
          <ArrowLeftIcon />
        </Button>
        <FolderGit2Icon className="size-5 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {project.owner}/{project.name}
        </h1>
        <Badge variant="muted">{project.provider === "artifacts" ? "Artifacts" : "GitHub"}</Badge>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openDialog({ kind: "newWorkspace", projectId: project.id })}
          disabled={!canWrite}
        >
          New workspace
        </Button>
      </header>
      {project.provider !== "artifacts" ? (
        <EmptyState
          title="GitHub repository"
          description="Browse this repository on GitHub, or open a Tempo workspace to work on it."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild>
                <a
                  href={githubRepoUrl(project.owner, project.name)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open on GitHub
                  <ExternalLinkIcon />
                </a>
              </Button>
              <Button asChild variant="outline">
                <a
                  href={`${githubRepoUrl(project.owner, project.name)}/issues`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Issues on GitHub
                  <ExternalLinkIcon />
                </a>
              </Button>
            </div>
          }
        />
      ) : (
        <>
          {metadata.data?.readOnly && (
            <p role="note" className="border-b px-5 py-3 text-sm text-muted-foreground">
              This repository is read-only.
            </p>
          )}
          {metadata.isError && tab !== "code" && tab !== "issues" && (
            <ErrorState error={metadata.error} onRetry={() => void metadata.refetch()} />
          )}
          <div className="border-b px-5 py-2">
            <Tabs
              value={tab}
              onValueChange={(value) => {
                if (!isRepositoryTab(value)) return;

                let next: RepositorySearch = { project: project.id, tab: value };

                if (search.ref) next = { ...next, ref: search.ref };

                onNavigate(next);
              }}
            >
              <TabsList aria-label="Repository sections">
                <TabsTrigger value="code">Code</TabsTrigger>
                <TabsTrigger value="commits">Commits</TabsTrigger>
                <TabsTrigger value="pulls">Pull requests</TabsTrigger>
                <TabsTrigger value="issues">Issues</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "pulls" && (
              <RepositoryPullRequests
                project={project}
                search={search}
                onNavigate={onNavigate}
                canWrite={canWrite}
              />
            )}
            {tab === "commits" && (
              <RepositoryCommits
                key={search.ref ?? project.defaultBranch}
                project={project}
                search={search}
                onNavigate={onNavigate}
              />
            )}
            {tab === "code" && <RepositoryCode project={project} search={search} onNavigate={onNavigate} />}
            {tab === "issues" && (
              <RepositoryIssues project={project} search={search} onNavigate={onNavigate} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
