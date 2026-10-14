import type { RepositoryIssue, RepositoryIssueComment } from "@tempo/protocol";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageMarkdown } from "~/ui/components/chat/Markdown";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Label } from "~/ui/components/ui/label";
import { Textarea } from "~/ui/components/ui/textarea";
import { callKey, useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { formatRelative } from "~/ui/lib/format";
import { isSubmitShortcut } from "./model";

export function RepositoryIssueComments({ projectId, number }: { projectId: string; number: number }) {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const comments = useCallQuery("listRepositoryIssueComments", { projectId, number, offset });
  const [body, setBody] = useState("");

  const create = useCallMutation("createRepositoryIssueComment", {
    invalidates: ["listRepositoryIssueComments", "getRepositoryIssue", "listRepositoryIssues"],
    onSuccess: () => {
      setBody("");

      const issue = queryClient.getQueryData<RepositoryIssue>(
        callKey("getRepositoryIssue", { projectId, number }),
      );

      setOffset(Math.floor(Math.max(0, (issue?.commentCount ?? 1) - 1) / 50) * 50);
    },
  });

  const submit = () => {
    if (body.trim() && !create.isPending) create.mutate({ projectId, number, body });
  };

  const revealRemainingComments = () => {
    const issue = queryClient.getQueryData<RepositoryIssue>(
      callKey("getRepositoryIssue", { projectId, number }),
    );

    if (issue)
      setOffset((value) => Math.min(value, Math.floor(Math.max(0, issue.commentCount - 1) / 50) * 50));
  };

  return (
    <section aria-label="Issue comments" className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold">Comments</h3>
      {comments.isPending ? (
        <SkeletonRows rows={4} />
      ) : comments.isError ? (
        <ErrorState error={comments.error} onRetry={() => void comments.refetch()} />
      ) : comments.data.length === 0 ? (
        <EmptyState title="No comments yet." />
      ) : (
        <div className="flex flex-col gap-3">
          {comments.data.map((comment) => (
            <IssueComment
              key={comment.id}
              projectId={projectId}
              number={number}
              comment={comment}
              onRemoved={revealRemainingComments}
            />
          ))}
        </div>
      )}
      {(offset > 0 || (comments.data?.length ?? 0) === 50) && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={offset === 0 || comments.isPending}
            onClick={() => setOffset((value) => Math.max(0, value - 50))}
          >
            Older comments
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={comments.isPending || (comments.data?.length ?? 0) < 50}
            onClick={() => setOffset((value) => value + 50)}
          >
            Newer comments
          </Button>
        </div>
      )}
      <form
        className="grid gap-2 rounded-lg border p-4"
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
        <Label htmlFor="issue-comment">Add a comment</Label>
        <Textarea
          id="issue-comment"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={65536}
          rows={4}
          placeholder="Write a comment…"
          required
        />
        <Button
          type="submit"
          size="sm"
          className="justify-self-start"
          disabled={!body.trim() || create.isPending}
        >
          {create.isPending ? "Posting…" : "Comment"}
        </Button>
      </form>
    </section>
  );
}

function IssueComment({
  projectId,
  number,
  comment,
  onRemoved,
}: {
  projectId: string;
  number: number;
  comment: RepositoryIssueComment;
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);

  const options = {
    invalidates: ["listRepositoryIssueComments", "getRepositoryIssue", "listRepositoryIssues"] as const,
  };

  const update = useCallMutation("updateRepositoryIssueComment", {
    ...options,
    onSuccess: () => setEditing(false),
  });

  const remove = useCallMutation("deleteRepositoryIssueComment", { ...options, onSuccess: onRemoved });
  const pending = update.isPending || remove.isPending;

  const submit = () => {
    if (body.trim() && !pending) update.mutate({ projectId, number, commentId: comment.id, body });
  };

  return (
    <article className="rounded-lg border" data-comment-id={comment.id}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {formatRelative(comment.createdAt)}
          {comment.updatedAt !== comment.createdAt ? " · edited" : ""}
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setBody(comment.body);
              setEditing(true);
            }}
          >
            Edit comment
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => remove.mutate({ projectId, number, commentId: comment.id })}
          >
            Delete comment
          </Button>
        </div>
      </div>
      {editing ? (
        <form
          className="grid gap-2 p-4"
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
          <Label htmlFor={`edit-comment-${comment.id}`}>Edit comment</Label>
          <Textarea
            id={`edit-comment-${comment.id}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={65536}
            rows={4}
            required
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!body.trim() || pending}>
              Save comment
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="p-4">
          <MessageMarkdown workspaceId="" text={comment.body} streaming={false} />
        </div>
      )}
    </article>
  );
}
