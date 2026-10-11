import { useEffect, useRef, useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { takeInsertions, workspaceUiStore } from "~/ui/state/workspace-ui";

export interface ComposerProps {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** REGION B placeholder: a text box that sends prompts (04, Composer). */
export function Composer({ workspaceId, sessionId }: ComposerProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const focusSeq = useWorkspaceUiSelector(workspaceId, (s) => s.composerFocusSeq);
  const send = useCallMutation("sendPrompt", { onSuccess: () => setText("") });

  useEffect(() => {
    if (focusSeq > 0) ref.current?.focus();
  }, [focusSeq]);

  useEffect(() => {
    const drain = () => {
      if (workspaceUiStore(workspaceId).getSnapshot().insertions.length === 0) return;
      const added = takeInsertions(workspaceId, sessionId)
        .map((p) =>
          p.insertion.kind === "mention"
            ? `@${p.insertion.path}`
            : p.insertion.kind === "text"
              ? p.insertion.text
              : "",
        )
        .filter(Boolean)
        .join(" ");
      if (added) setText((t) => (t ? `${t} ${added}` : added));
    };
    queueMicrotask(drain);
    return workspaceUiStore(workspaceId).subscribe(drain);
  }, [workspaceId, sessionId]);

  const submit = () => {
    if (!text.trim()) return;
    send.mutate({ workspaceId, sessionId, text, mentions: [], attachmentIds: [], reviewCommentIds: [] });
  };

  return (
    <div className="flex shrink-0 items-end gap-2 border-t p-2">
      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Message the agent"
        aria-label="Message"
        className="max-h-48 min-h-9"
      />
      <Button onClick={submit} disabled={send.isPending || !text.trim()}>
        Send
      </Button>
    </div>
  );
}
