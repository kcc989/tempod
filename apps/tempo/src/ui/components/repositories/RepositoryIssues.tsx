import type { FnInput, Project, RepositoryIssue } from "@tempo/protocol";
import { ArrowLeftIcon, CircleCheckIcon, CircleDotIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";
import { MessageMarkdown } from "~/ui/components/chat/Markdown";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Input } from "~/ui/components/ui/input";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative } from "~/ui/lib/format";
import { RepositoryIssueComments } from "./RepositoryIssueComments";
import { RepositoryLabelBadge, RepositoryLabelManager, RepositoryLabelSelector } from "./RepositoryLabels";
import type { RepositoryHubProps } from "./RepositoryHub";
import { isSubmitShortcut } from "./model";

type Props = RepositoryHubProps & { project: Project };

const FILTERS = { open: "Open", closed: "Closed", all: "All" };

export function RepositoryIssues(props: Props) {
  const { project, search, onNavigate } = props;
  const [state, setState] = useState<NonNullable<FnInput<"listRepositoryIssues">["state"]>>("open");
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [labelId, setLabelId] = useState("");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [managingLabels, setManagingLabels] = useState(false);
  let input: FnInput<"listRepositoryIssues"> = { projectId: project.id, state, offset };

  if (query) input = { ...input, query };

  if (labelId) input = { ...input, labelId };

  const issues = useCallQuery("listRepositoryIssues", input, { enabled: search.issue === undefined });
  const labels = useCallQuery("listRepositoryLabels", { projectId: project.id });

  if (search.issue !== undefined) return <IssueDetail key={search.issue} {...props} number={search.issue} />;

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" aria-label="Issue state filter">
          {(["open", "closed", "all"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={state === value ? "secondary" : "ghost"}
              onClick={() => {
                setState(value);
                setOffset(0);
              }}
            >
              {FILTERS[value]}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setManagingLabels(true)}>
            Manage labels
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            New issue
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(searchText.trim());
            setOffset(0);
          }}
        >
          <Input
            aria-label="Search issues"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search issue titles and descriptions"
          />
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
        </form>
        <Select
          value={labelId || "all-labels"}
          onValueChange={(value) => {
            setLabelId(value === "all-labels" ? "" : value);
            setOffset(0);
          }}
        >
          <SelectTrigger aria-label="Filter issues by label" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all-labels">All labels</SelectItem>
            {(labels.data ?? []).map((label) => (
              <SelectItem key={label.id} value={label.id}>
                {label.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {labels.isError && <ErrorState error={labels.error} onRetry={() => void labels.refetch()} />}
      {issues.isPending ? (
        <SkeletonRows rows={5} />
      ) : issues.isError ? (
        <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />
      ) : issues.data.length === 0 ? (
        <EmptyState
          icon={CircleDotIcon}
          title="No issues here."
          description="Track ideas, bugs and work for this repository."
        />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Issues">
          {issues.data.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/30"
                onClick={() => onNavigate({ project: project.id, tab: "issues", issue: issue.number })}
              >
                {issue.state === "open" ? (
                  <CircleDotIcon className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{issue.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      #{issue.number} · {formatRelative(issue.createdAt)}
                    </span>
                    {issue.labels.map((label) => (
                      <RepositoryLabelBadge key={label.id} label={label} />
                    ))}
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <MessageSquareIcon aria-hidden className="size-3" />
                  {issue.commentCount}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={offset === 0 || issues.isPending}
          onClick={() => setOffset((value) => Math.max(0, value - 50))}
        >
          Newer issues
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={issues.isPending || (issues.data?.length ?? 0) < 50}
          onClick={() => setOffset((value) => value + 50)}
        >
          Older issues
        </Button>
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
            <DialogDescription>Describe work, a bug or an idea for this repository.</DialogDescription>
          </DialogHeader>
          {creating && (
            <IssueForm
              projectId={project.id}
              onSuccess={(issue) => {
                setCreating(false);
                onNavigate({ project: project.id, tab: "issues", issue: issue.number });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {managingLabels && (
        <RepositoryLabelManager
          projectId={project.id}
          open={managingLabels}
          onOpenChange={setManagingLabels}
          onDeleted={(id) => {
            if (labelId === id) {
              setLabelId("");
              setOffset(0);
            }
          }}
        />
      )}
    </div>
  );
}

export function IssueForm({
  projectId,
  issue,
  onSuccess,
  onCancel,
}: {
  projectId: string;
  issue?: RepositoryIssue;
  onSuccess: (issue: RepositoryIssue) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(issue?.title ?? "");
  const [body, setBody] = useState(issue?.body ?? "");
  const [selected, setSelected] = useState<string[]>(issue?.labels.map((label) => label.id) ?? []);
  const labels = useCallQuery("listRepositoryLabels", { projectId });
  const options = { invalidates: ["listRepositoryIssues", "getRepositoryIssue"] as const, onSuccess };
  const create = useCallMutation("createRepositoryIssue", options);
  const update = useCallMutation("updateRepositoryIssue", options);
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!title.trim() || pending || !labels.data) return;

    const available = new Set(labels.data.map((label) => label.id));
    const labelIds = selected.filter((id) => available.has(id));
    const input = { projectId, title: title.trim(), body, labelIds };

    if (issue) update.mutate({ ...input, number: issue.number });
    else create.mutate(input);
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (isSubmitShortcut(event)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="issue-title">Title</Label>
        <Input
          id="issue-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={256}
          required
          autoFocus
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="issue-body">Description</Label>
        <Textarea
          id="issue-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={65536}
          rows={6}
          placeholder="Describe the issue…"
        />
      </div>
      {labels.isPending ? (
        <SkeletonRows rows={2} />
      ) : labels.isError ? (
        <ErrorState error={labels.error} onRetry={() => void labels.refetch()} />
      ) : (
        <RepositoryLabelSelector labels={labels.data} selected={selected} onChange={setSelected} />
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || !title.trim() || !labels.data}>
          {pending ? "Saving…" : issue ? "Save issue" : "Create issue"}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function IssueDetail({ project, search, onNavigate, number }: Props & { number: number }) {
  const issue = useCallQuery("getRepositoryIssue", { projectId: project.id, number });

  const update = useCallMutation("updateRepositoryIssue", {
    invalidates: ["getRepositoryIssue", "listRepositoryIssues"],
  });

  const [editing, setEditing] = useState(false);

  if (issue.isPending) return <SkeletonRows rows={5} />;

  if (issue.isError) return <ErrorState error={issue.error} onRetry={() => void issue.refetch()} />;

  const current = issue.data;
  const open = current.state === "open";

  return (
    <div className="flex flex-col gap-4 p-5">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => {
          const next = { ...search };
          delete next.issue;
          onNavigate(next);
        }}
      >
        <ArrowLeftIcon />
        Issues
      </Button>
      <div>
        <h2 className="text-xl font-semibold">
          {current.title} <span className="text-muted-foreground">#{number}</span>
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant={open ? "success" : "muted"}>{open ? "Open" : "Closed"}</Badge>
          <span className="text-xs text-muted-foreground">Opened {formatRelative(current.createdAt)}</span>
          {current.labels.map((label) => (
            <RepositoryLabelBadge key={label.id} label={label} />
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => setEditing(true)}
        >
          Edit issue
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => update.mutate({ projectId: project.id, number, state: open ? "closed" : "open" })}
        >
          {open ? "Close issue" : "Reopen issue"}
        </Button>
      </div>
      {editing ? (
        <div className="rounded-lg border p-4">
          <IssueForm
            projectId={project.id}
            issue={current}
            onSuccess={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="rounded-lg border p-4">
          {current.body ? (
            <MessageMarkdown workspaceId="" text={current.body} streaming={false} />
          ) : (
            <p className="text-sm text-muted-foreground">No description provided.</p>
          )}
        </div>
      )}
      <RepositoryIssueComments key={current.id} projectId={project.id} number={number} />
    </div>
  );
}
