import { useRef, useState } from "react";
import { DEFAULT_SETTINGS, type Session } from "@tempo/protocol";
import { CornerDownLeftIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/ui/components/ui/dialog";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { needsModel } from "~/ui/lib/agents";
import { LaunchModelPicker, useLaunchModels } from "./LaunchModelPicker";

export function NewChatComposer({
  workspaceId,
  open,
  onOpenChange,
  onCreated,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: Session) => void;
}) {
  const settings = useWorkspaceSelector(workspaceId, (s) => s.workspace?.settings ?? DEFAULT_SETTINGS);
  const selection = useLaunchModels(settings);
  const agent = selection.pickedCustom?.baseAgent ?? selection.selected?.agent ?? selection.fallbackAgent;

  const model = selection.pickedCustom
    ? undefined
    : (selection.selected?.model ?? (agent ? settings.agent.models[agent] || undefined : undefined));

  const customAgentId = selection.pickedCustom?.id;

  const canCreate =
    agent !== null && (customAgentId !== undefined || model !== undefined || !needsModel(agent, settings));

  const [prompt, setPrompt] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [created, setCreated] = useState<Session | null>(null);
  const submitting = useRef(false);
  const create = useCallMutation("createSession");
  const send = useCallMutation("sendPrompt");
  const busy = create.isPending || send.isPending;

  const submit = async () => {
    if (submitting.current || !agent || !canCreate) return;
    submitting.current = true;

    try {
      const session =
        created ??
        (await create.mutateAsync({
          workspaceId,
          agent,
          ...(model ? { model } : {}),
          ...(customAgentId ? { customAgentId } : {}),
        }));

      setCreated(session);

      if (prompt.trim())
        await send.mutateAsync({
          workspaceId,
          sessionId: session.id,
          text: prompt.trim(),
          mentions: [],
          attachmentIds: [],
          reviewCommentIds: [],
        });
      onCreated(session);
      onOpenChange(false);
      setPrompt("");
      setCreated(null);
    } catch {
      // The mutations show the error; keep the draft and session for retry.
    } finally {
      submitting.current = false;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent
        className="gap-0 rounded-2xl bg-muted p-0"
        style={{ width: "min(48rem, calc(100vw - 2rem))", maxWidth: "calc(100vw - 2rem)" }}
        overlayClassName="backdrop-blur-sm"
        onSubmitShortcut={() => void submit()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textarea.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">New chat</DialogTitle>
        <DialogDescription className="sr-only">
          Choose a model and start a chat. Enter opens an empty chat too.
        </DialogDescription>
        <Textarea
          ref={textarea}
          aria-label="Prompt"
          placeholder="What do you want to work on?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
          className="max-h-[min(24rem,50dvh)] min-h-48 resize-none rounded-none border-0 bg-transparent p-4 focus-visible:ring-0 dark:bg-transparent"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void submit();
          }}
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-3">
          <LaunchModelPicker
            selection={selection}
            disabled={busy || created !== null}
            onClosed={() => textarea.current?.focus()}
          />
          <Button size="sm" disabled={busy || !canCreate} onClick={() => void submit()}>
            {busy ? "Starting…" : "Create chat"}
            <CornerDownLeftIcon className="size-3.5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
