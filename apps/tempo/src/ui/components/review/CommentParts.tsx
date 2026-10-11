import type { ReviewComment } from "@tempo/protocol";
import { Trash2Icon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Label } from "~/ui/components/ui/label";
import { Spinner } from "~/ui/components/ui/spinner";
import { Textarea } from "~/ui/components/ui/textarea";
import { isMacPlatform, matchesCombo } from "~/ui/lib/shortcuts";
import { cn } from "~/ui/lib/utils";
import { rangeLabel, type LineRange } from "./diff-model";
import { useAddComment, useDeleteComment } from "./use-review";

/** Inline cards stay in view while a wide diff scrolls sideways. */
const CARD = "sticky left-0 my-1 ml-2 w-[min(40rem,calc(100vw-5rem))] rounded-md border bg-card p-2 text-sm";

export function DraftCard({ workspaceId, comment }: { workspaceId: string; comment: ReviewComment }) {
  const remove = useDeleteComment();
  const where =
    comment.lineStart === null
      ? "Whole file"
      : rangeLabel({
          side: comment.side ?? "new",
          lineStart: comment.lineStart,
          lineEnd: comment.lineEnd ?? comment.lineStart,
        });
  return (
    <div className={cn(CARD, "font-sans")}>
      <div className="mb-1 flex items-center gap-2">
        <Badge variant="muted">Draft</Badge>
        <span className="text-xs text-muted-foreground">{where}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete comment"
          className="ml-auto"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ workspaceId, commentId: comment.id })}
        >
          {remove.isPending ? <Spinner /> : <Trash2Icon />}
        </Button>
      </div>
      <p className="break-words whitespace-pre-wrap">{comment.body}</p>
    </div>
  );
}

const SUBMIT = { code: "Enter", mod: true } as const;

/** A new comment on a line range (`range`) or the whole file (`range` null). ⌘Enter adds it, Esc cancels. */
export function CommentForm({
  workspaceId,
  path,
  range,
  onDone,
}: {
  workspaceId: string;
  path: string;
  range: LineRange | null;
  onDone: (added: boolean) => void;
}) {
  const id = useId();
  const [body, setBody] = useState("");
  const add = useAddComment(() => onDone(true));
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if (text === "" || add.isPending) return;
    add.mutate(
      range
        ? {
            workspaceId,
            path,
            lineStart: range.lineStart,
            lineEnd: range.lineEnd,
            side: range.side,
            body: text,
          }
        : { workspaceId, path, body: text },
    );
  };
  return (
    <form onSubmit={submit} className={cn(CARD, "flex flex-col gap-1.5 font-sans")}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {range ? rangeLabel(range) : "Whole file"}
      </Label>
      <Textarea
        id={id}
        autoFocus
        rows={3}
        value={body}
        placeholder="Add a comment"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (matchesCombo(e, SUBMIT, isMacPlatform())) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone(false);
          }
        }}
        className="max-h-48 min-h-0"
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={body.trim() === "" || add.isPending}>
          {add.isPending && <Spinner />}
          Add comment
        </Button>
      </div>
    </form>
  );
}
