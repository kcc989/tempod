import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, ExternalLinkIcon, FolderGit2Icon, GitBranchIcon, PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { sessionQueryOptions } from "~/ui/auth";
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
import { RepositoryChecks } from "./RepositoryChecks";
import { RepositoryIssues } from "./RepositoryIssues";
import { projectLabel } from "~/ui/components/sidebar/sidebar-logic";
import { isRepositoryTab, repositoryInput, type RepositoryProject, type RepositorySearch } from "./model";
import { RepositoryAccessContext, canWrite as roleCanWrite, isMember, type RepositoryAccess } from "./access";

export interface RepositoryHubProps {
  readonly search: RepositorySearch;
  readonly onNavigate: (search: RepositorySearch) => void;
}

export function RepositoryHub({ search, onNavigate }: RepositoryHubProps) {
  const projects = useProjects();
  const session = useQuery(sessionQueryOptions);
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
    return (
      <RepositoryDetail
        key={project.id}
        project={project}
        access={{ role: project.role ?? "admin", userId: session.data?.user.id ?? null }}
        title={projectLabel(project)}
        search={search}
        onNavigate={onNavigate}
        onBack={() => onNavigate({})}
      />
    );
  const q = query.trim().toLowerCase();
  const shown = projects.data.filter((p) => projectLabel(p).toLowerCase().includes(q));

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
                    <span className="truncate">{projectLabel(p)}</span>
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

export interface RepositoryDetailProps extends RepositoryHubProps {
  readonly project: RepositoryProject;
  readonly access: RepositoryAccess;
  /** `namespace/slug`; defaults to `owner/name`. */
  readonly title?: string | undefined;
  /** Header items after the title, such as the visibility badge and the star button (04). */
  readonly badges?: ReactNode;
  readonly onBack: () => void;
  readonly backLabel?: string;
}

/** One repository: Code, Commits, Pull requests, Issues and, for members, Checks (09, 11). */
export function RepositoryDetail({
  project,
  access,
  title,
  badges,
  search,
  onNavigate,
  onBack,
  backLabel = "All repositories",
}: RepositoryDetailProps) {
  const member = isMember(access);
  const tab = search.tab === "checks" && !member ? "code" : (search.tab ?? "code");

  const metadata = useCallQuery(
    "getRepository",
    repositoryInput(
      project.id,
      tab === "code" ? search.ref : undefined,
      tab === "code" ? (search.path ?? "") : undefined,
    ),
    { enabled: project.provider === "artifacts" && tab !== "issues" && tab !== "checks" },
  );

  const writer = roleCanWrite(access);

  const canWrite =
    writer && (project.provider !== "artifacts" || (!!metadata.data && !metadata.data.readOnly));

  return (
    <RepositoryAccessContext.Provider value={access}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
          <Button variant="ghost" size="icon-sm" aria-label={backLabel} onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
          <FolderGit2Icon className="size-5 text-muted-foreground" />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
            {title ?? `${project.owner}/${project.name}`}
          </h1>
          {badges}
          <Badge variant="muted">{project.provider === "artifacts" ? "Artifacts" : "GitHub"}</Badge>
          {writer && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDialog({ kind: "newWorkspace", projectId: project.id })}
              disabled={!canWrite}
            >
              New workspace
            </Button>
          )}
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
            {metadata.isError && tab !== "code" && tab !== "issues" && tab !== "checks" && (
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
                  {member && <TabsTrigger value="checks">Checks</TabsTrigger>}
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
              {tab === "checks" && (
                <RepositoryChecks project={project} search={search} onNavigate={onNavigate} />
              )}
            </div>
          </>
        )}
      </div>
    </RepositoryAccessContext.Provider>
  );
}
