import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project, RepositoryPullRequest } from "@tempo/protocol";
import { ArrowLeftIcon, GitPullRequestIcon } from "lucide-react";
import { useState } from "react";
import { MessageMarkdown } from "~/ui/components/chat/Markdown";
import { BranchPicker } from "~/ui/components/dialogs/BranchPicker";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Checkbox } from "~/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import { Textarea } from "~/ui/components/ui/textarea";
import { invalidateCalls, useApiCall, useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative } from "~/ui/lib/format";
import { toastError } from "~/ui/lib/toast";
import { getHubStore } from "~/ui/stores/hub-store";
import { setPhonePane } from "~/ui/state/workspace-ui";
import type { RepositoryHubProps } from "./RepositoryHub";
import { ciState, isSubmitShortcut, shortSha } from "./model";
import { PullRequestGuide } from "./PullRequestGuide";

type Props = RepositoryHubProps & { project: Project; canWrite?: boolean };

const PR_TONE = {
  merged: "text-merged",
  closed: "text-destructive",
  draft: "text-muted-foreground",
  open: "text-success",
};

const FILTER_LABELS = { open: "Open", closed: "Closed", all: "All" };

const tone = (state: RepositoryPullRequest["state"]) => PR_TONE[state];

export function RepositoryPullRequests(props: Props) {
  const { project, search, onNavigate, canWrite = true } = props;
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [creating, setCreating] = useState(false);
  const pulls = useCallQuery("listRepositoryPullRequests", { projectId: project.id, state });

  if (search.pull) return <PullRequestDetail {...props} number={search.pull} />;

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" aria-label="Pull request filter">
          {(["open", "closed", "all"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={state === value ? "secondary" : "ghost"}
              onClick={() => setState(value)}
            >
              {FILTER_LABELS[value]}
            </Button>
          ))}
        </div>
        <Button size="sm" disabled={!canWrite} onClick={() => setCreating(true)}>
          New pull request
        </Button>
      </div>
      {pulls.isPending ? (
        <SkeletonRows rows={5} />
      ) : pulls.isError ? (
        <ErrorState error={pulls.error} onRetry={() => void pulls.refetch()} />
      ) : pulls.data.length === 0 ? (
        <EmptyState
          icon={GitPullRequestIcon}
          title="No pull requests here."
          description="Push a branch, then propose your changes."
        />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Pull requests">
          {pulls.data.map((pull) => (
            <li key={pull.id}>
              <button
                type="button"
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/30"
                onClick={() => onNavigate({ project: project.id, tab: "pulls", pull: pull.number })}
              >
                <GitPullRequestIcon className={`mt-0.5 size-4 ${tone(pull.state)}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{pull.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    #{pull.number} · {pull.headBranch} → {pull.baseBranch} · {formatRelative(pull.updatedAt)}
                  </p>
                </div>
                <Badge variant="muted" className={tone(pull.state)}>
                  {pull.state}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New pull request</DialogTitle>
            <DialogDescription>Propose changes between two branches.</DialogDescription>
          </DialogHeader>
          {creating && (
            <PullRequestForm
              project={project}
              onSuccess={(pull) => {
                setCreating(false);
                onNavigate({ project: project.id, tab: "pulls", pull: pull.number });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function PullRequestForm({
  project,
  onSuccess,
}: {
  project: Project;
  onSuccess: (pull: RepositoryPullRequest) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [head, setHead] = useState<string | null>(null);
  const [base, setBase] = useState(project.defaultBranch);
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallMutation("createRepositoryPullRequest", {
    invalidates: ["listRepositoryPullRequests", "listOpenPullRequests"],
    onSuccess,
  });

  const submit = () => {
    if (!title.trim() || !head || !base || head === base) {
      setError("Add a title and choose two different branches.");

      return;
    }

    setError(null);

    if (!create.isPending)
      create.mutate({
        projectId: project.id,
        title: title.trim(),
        body,
        headBranch: head,
        baseBranch: base,
        draft,
      });
  };

  return (
    <form
      className="grid gap-4"
      onKeyDown={(event) => {
        if (isSubmitShortcut(event)) {
          event.preventDefault();
          submit();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <BranchPicker
          id="pr-base"
          label="Base branch"
          placeholder="Pick base branch"
          projectId={project.id}
          value={base}
          onChange={(value) => value && setBase(value)}
        />
        <span className="text-muted-foreground">←</span>
        <BranchPicker
          id="pr-head"
          label="Head branch"
          placeholder="Pick head branch"
          projectId={project.id}
          value={head}
          onChange={setHead}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pr-title">Title</Label>
        <Input id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pr-body">Description</Label>
        <Textarea
          id="pr-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Describe the changes"
          rows={5}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={draft} onCheckedChange={(value) => setDraft(value === true)} />
        Create as draft
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create pull request"}
      </Button>
    </form>
  );
}

function PullRequestDetail({
  project,
  search,
  onNavigate,
  number,
  canWrite = true,
}: Props & { number: number }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invoke = useApiCall();
  const pull = useCallQuery("getRepositoryPullRequest", { projectId: project.id, number });

  const update = useCallMutation("updateRepositoryPullRequest", {
    invalidates: [
      "getRepositoryPullRequest",
      "listRepositoryPullRequests",
      "listOpenPullRequests",
      "listWorkspaces",
    ],
  });

  const workspace = useMutation({
    mutationKey: ["repositoryPR.review", project.id, number],
    mutationFn: async () => {
      const summaries = await invoke("listWorkspaces", {});

      const existing = summaries.find(
        (summary) =>
          summary.projectId === project.id &&
          summary.state !== "archived" &&
          summary.state !== "archiving" &&
          (summary.prNumber === number || summary.branch === pull.data?.headBranch),
      );

      if (existing) {
        if (existing.prNumber !== number && pull.data)
          await invoke("createPullRequest", {
            workspaceId: existing.id,
            title: pull.data.title,
            body: pull.data.body,
            draft: pull.data.state === "draft",
          });

        return existing;
      }

      return invoke("createWorkspace", { projectId: project.id, source: { kind: "pr", number } });
    },
    onSuccess: async (summary) => {
      await invalidateCalls(queryClient, "listWorkspaces");
      getHubStore().merge(summary);
      setPhonePane("chat");
      void navigate({ to: "/w/$workspaceId", params: { workspaceId: summary.id } });
    },
    onError: toastError,
  });

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  if (pull.isPending) return <SkeletonRows rows={5} />;

  if (pull.isError) return <ErrorState error={pull.error} onRetry={() => void pull.refetch()} />;
  const p = pull.data;
  const open = p.state === "open" || p.state === "draft";

  return (
    <div className="flex flex-col gap-4 p-5">
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => onNavigate({ ...search, pull: undefined })}
      >
        <ArrowLeftIcon />
        Pull requests
      </Button>
      <div>
        <h2 className="text-xl font-semibold">
          {p.title} <span className="text-muted-foreground">#{p.number}</span>
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="muted" className={tone(p.state)}>
            {p.state}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {p.headBranch} → {p.baseBranch}
          </span>
          <span className="text-xs text-muted-foreground">Updated {formatRelative(p.updatedAt)}</span>
        </div>
      </div>
      <PullRequestChecks project={project} branch={p.headBranch} onNavigate={onNavigate} />
      <div className="flex flex-wrap gap-2">
        {open && (
          <Button size="sm" disabled={workspace.isPending || !canWrite} onClick={() => workspace.mutate()}>
            {workspace.isPending ? "Opening…" : "Review and merge in workspace"}
          </Button>
        )}
        {p.state !== "merged" && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => {
                setTitle(p.title);
                setBody(p.body);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({ projectId: project.id, number, state: open ? "closed" : "open" })
              }
            >
              {open ? "Close pull request" : "Reopen pull request"}
            </Button>
            {open && (
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending}
                onClick={() => update.mutate({ projectId: project.id, number, draft: p.state !== "draft" })}
              >
                {p.state === "draft" ? "Ready for review" : "Convert to draft"}
              </Button>
            )}
          </>
        )}
      </div>
      {editing ? (
        <form
          className="grid gap-3 rounded-lg border p-4"
          onSubmit={(e) => {
            e.preventDefault();

            if (title.trim() && !update.isPending)
              update.mutate(
                { projectId: project.id, number, title: title.trim(), body },
                { onSuccess: () => setEditing(false) },
              );
          }}
        >
          <Label htmlFor="edit-pr-title">Title</Label>
          <Input id="edit-pr-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <Label htmlFor="edit-pr-body">Description</Label>
          <Textarea id="edit-pr-body" value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={update.isPending}>
              Save changes
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="rounded-lg border p-4">
          {p.body ? (
            <MessageMarkdown workspaceId="" text={p.body} streaming={false} />
          ) : (
            <p className="text-sm text-muted-foreground">No description provided.</p>
          )}
        </div>
      )}
      {p.state === "merged" && (
        <p className="text-sm text-muted-foreground">
          Merged{p.mergeSha ? ` as ${p.mergeSha.slice(0, 7)}` : ""}.
        </p>
      )}
      <PullRequestGuide project={project} pull={p} onNavigate={onNavigate} />
    </div>
  );
}

/** 10, Clients: the newest check run of the PR head branch. */
function PullRequestChecks({
  project,
  branch,
  onNavigate,
}: {
  project: Project;
  branch: string;
  onNavigate: RepositoryHubProps["onNavigate"];
}) {
  const runs = useCallQuery("listCiRuns", { projectId: project.id, branch, offset: 0 });
  const run = runs.data?.[0];

  if (runs.isPending || runs.isError) return null;

  if (!run) return <p className="text-sm text-muted-foreground">No checks have run for {branch}.</p>;
  const state = ciState(run);

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border px-4 py-2.5 text-sm"
      aria-label="Checks"
    >
      <span className="font-medium">Checks</span>
      <Badge variant={state.tone}>{state.label}</Badge>
      <span className="text-muted-foreground">
        Run #{run.number} on {shortSha(run.sha)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto"
        onClick={() => onNavigate({ project: project.id, tab: "checks", run: run.id })}
      >
        View run
      </Button>
    </div>
  );
}
