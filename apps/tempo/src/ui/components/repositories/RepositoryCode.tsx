import type { Project } from "@tempo/protocol";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon, FileIcon, FolderIcon, GitCommitHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BranchPicker } from "~/ui/components/dialogs/BranchPicker";
import { CodeView } from "~/ui/components/review/FileTab";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { formatBytes, formatRelative } from "~/ui/lib/format";
import { getHubStore } from "~/ui/stores/hub-store";
import { setPhonePane } from "~/ui/state/workspace-ui";
import {
  commitTitle,
  parentPath,
  repositoryCommitsInput,
  repositoryInput,
  shortSha,
  type RepositorySearch,
} from "./model";
import type { RepositoryHubProps } from "./RepositoryHub";

type Props = RepositoryHubProps & {
  project: Pick<Project, "id" | "name" | "defaultBranch">;
  /** 11: a visitor's read-only view, without workspace or clone actions. */
  publicView?: boolean;
};

export function RepositoryCode({ project, search, onNavigate, publicView = false }: Props) {
  const navigate = useNavigate();
  const ref = search.ref || project.defaultBranch;
  const path = search.path || "";
  const repo = useCallQuery("getRepository", repositoryInput(project.id, search.ref, path));

  const bootstrap = useCallMutation("createWorkspace", {
    invalidates: ["listWorkspaces", "getRepository"],
    onSuccess: (summary) => {
      getHubStore().merge(summary);
      setPhonePane("chat");
      void navigate({ to: "/w/$workspaceId", params: { workspaceId: summary.id } });
    },
  });

  const reset = (next: Partial<RepositorySearch>) => onNavigate({ project: project.id, ref, ...next });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="w-52 shrink-0">
          <BranchPicker
            id="repository-ref"
            label="Branch"
            placeholder="Pick a branch"
            projectId={project.id}
            value={ref}
            allowRef
            onChange={(branch) => branch && reset({ ref: branch })}
          />
        </div>
        <nav aria-label="Repository path" className="flex min-w-0 flex-1 items-center gap-1 truncate text-sm">
          <button type="button" className="text-primary hover:underline" onClick={() => reset({})}>
            {project.name}
          </button>
          {path
            .split("/")
            .filter(Boolean)
            .map((part, i, parts) => (
              <span key={i} className="contents">
                <span className="text-muted-foreground">/</span>
                <button
                  type="button"
                  className="truncate hover:underline"
                  onClick={() => reset({ path: parts.slice(0, i + 1).join("/") })}
                >
                  {part}
                </button>
              </span>
            ))}
          {search.file && <span className="truncate">/ {search.file.split("/").at(-1)}</span>}
        </nav>
        {repo.data && !publicView && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(repo.data.remote)
                .then(() => toast.success("Copied clone URL"))
                .catch(() => toast.error("Could not copy clone URL"))
            }
          >
            <CopyIcon />
            Clone URL
          </Button>
        )}
      </div>
      {repo.isPending ? (
        <SkeletonRows rows={8} />
      ) : repo.isError ? (
        <ErrorState error={repo.error} onRetry={() => void repo.refetch()} />
      ) : repo.data.empty ? (
        <EmptyState
          icon={GitCommitHorizontalIcon}
          title="This repository is empty."
          description={
            publicView
              ? undefined
              : "Start a workspace to create the first commit, or push existing code to the clone URL."
          }
          action={
            !publicView && (
              <Button
                disabled={repo.data.readOnly || bootstrap.isPending}
                onClick={() =>
                  bootstrap.mutate({
                    projectId: project.id,
                    source: { kind: "new", baseBranch: project.defaultBranch },
                  })
                }
              >
                {bootstrap.isPending ? "Starting…" : "Start a workspace"}
              </Button>
            )
          }
        />
      ) : search.file ? (
        <RepositoryFile projectId={project.id} refName={ref} path={search.file} />
      ) : (
        <div className="px-5 pb-5">
          {repo.data.description && (
            <p className="mb-3 text-sm text-muted-foreground">{repo.data.description}</p>
          )}
          {repo.data.commit && (
            <div className="flex flex-wrap items-center gap-2 rounded-t-lg border bg-muted/40 px-3 py-2 text-sm">
              <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{commitTitle(repo.data.commit.message)}</span>
              <button
                type="button"
                className="font-mono text-xs text-primary hover:underline"
                onClick={() => reset({ tab: "commits" })}
              >
                {shortSha(repo.data.commit.hash)}
              </button>
              <span className="text-xs text-muted-foreground">
                {formatRelative(repo.data.commit.committedAt * 1000)}
              </span>
            </div>
          )}
          <ul
            className="divide-y overflow-hidden rounded-b-lg border border-t-0"
            aria-label="Repository files"
          >
            {path && (
              <li>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
                  onClick={() => reset({ path: parentPath(path) })}
                >
                  <FolderIcon className="size-4 text-muted-foreground" />
                  ..
                </button>
              </li>
            )}
            {[...repo.data.entries]
              .sort(
                (a, b) =>
                  Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name),
              )
              .map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40 focus-visible:outline-primary"
                    onClick={() =>
                      entry.type === "tree"
                        ? reset({ path: entry.path })
                        : entry.type !== "gitlink" && reset({ path, file: entry.path })
                    }
                    disabled={entry.type === "gitlink"}
                  >
                    {entry.type === "tree" ? (
                      <FolderIcon className="size-4 text-primary" />
                    ) : (
                      <FileIcon className="size-4 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {entry.type === "symlink" || entry.type === "gitlink" ? (
                      <span className="text-xs text-muted-foreground">
                        {entry.type === "gitlink" ? "Submodule" : "Symlink"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
          </ul>
          {repo.data.entries.length === 0 && <EmptyState title="This directory is empty." />}
        </div>
      )}
    </div>
  );
}

function RepositoryFile({ projectId, refName, path }: { projectId: string; refName: string; path: string }) {
  const file = useCallQuery("getRepositoryFile", { projectId, ref: refName, path });

  if (file.isPending) return <SkeletonRows rows={8} />;

  if (file.isError) return <ErrorState error={file.error} onRetry={() => void file.refetch()} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t">
      <div className="flex shrink-0 items-center gap-2 border-b px-5 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
        <span className="text-muted-foreground">{formatBytes(file.data.size)} · Read only</span>
      </div>
      <div className="min-h-0 flex-1">
        {file.data.encoding === "utf8" ? (
          <CodeView path={path} content={file.data.content} line={null} seq={0} />
        ) : (
          <EmptyState icon={FileIcon} title="Binary file." description={formatBytes(file.data.size)} />
        )}
      </div>
    </div>
  );
}

export function RepositoryCommits({ project, search, onNavigate }: Props) {
  const [offset, setOffset] = useState(0);
  const ref = search.ref || project.defaultBranch;

  const commits = useCallQuery(
    "listRepositoryCommits",
    repositoryCommitsInput(project.id, search.ref, offset),
  );

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="w-52">
        <BranchPicker
          id="commits-ref"
          label="Branch"
          placeholder="Pick a branch"
          projectId={project.id}
          value={ref}
          allowRef
          onChange={(branch) => {
            setOffset(0);

            if (branch) onNavigate({ project: project.id, tab: "commits", ref: branch });
          }}
        />
      </div>
      {commits.isPending ? (
        <SkeletonRows rows={6} />
      ) : commits.isError ? (
        <ErrorState error={commits.error} onRetry={() => void commits.refetch()} />
      ) : commits.data.length === 0 ? (
        <EmptyState title="No commits here." />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Commits">
          {commits.data.map((commit) => (
            <li key={commit.hash} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{commitTitle(commit.message)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {commit.author.name} · {formatRelative(commit.committedAt * 1000)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="font-mono"
                onClick={() => onNavigate({ project: project.id, ref: commit.hash, tab: "code" })}
              >
                {shortSha(commit.hash)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={offset === 0 || commits.isPending}
          onClick={() => setOffset((value) => Math.max(0, value - 50))}
        >
          Newer
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={commits.isPending || (commits.data?.length ?? 0) < 50}
          onClick={() => setOffset((value) => value + 50)}
        >
          Older
        </Button>
      </div>
    </div>
  );
}
