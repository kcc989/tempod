import type { IntentContent } from "@tempo/protocol";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { Textarea } from "~/ui/components/ui/textarea";
import { useCallMutation } from "~/ui/hooks/useCall";
import { intentReasonText, intentStatusText } from "./transcript-model";

/** 13, L-ADR-1: the agent's goal, approach and non-goals, confirmed or corrected with one action. */
export function IntentCard({
  workspaceId,
  intent,
  writable,
}: {
  workspaceId: string;
  intent: IntentContent;
  writable: boolean;
}) {
  const [correction, setCorrection] = useState("");
  const confirmIntent = useCallMutation("confirmIntent");

  const correctIntent = useCallMutation("correctIntent", { onSuccess: () => setCorrection("") });

  const open = intent.status === "proposed" && writable;
  const busy = confirmIntent.isPending || correctIntent.isPending;
  const confirm = () => confirmIntent.mutate({ workspaceId, intentId: intent.intentId });

  const correct = () =>
    correctIntent.mutate({ workspaceId, intentId: intent.intentId, text: correction.trim() });

  return (
    <section
      aria-label="Intent"
      className="mx-4 flex flex-col gap-2 rounded-lg border p-3 text-sm"
      onKeyDown={(e) => {
        if (open && !busy && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();

          if (correction.trim()) correct();
          else confirm();
        }
      }}
    >
      <p className="text-xs font-medium text-muted-foreground">{intentStatusText(intent)}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Goal</dt>
        <dd className="whitespace-pre-wrap break-words">{intent.goal}</dd>
        <dt className="text-muted-foreground">Approach</dt>
        <dd className="whitespace-pre-wrap break-words">{intent.approach}</dd>
        <dt className="text-muted-foreground">Not doing</dt>
        <dd className="whitespace-pre-wrap break-words">{intent.notDoing}</dd>
      </dl>
      {intent.status === "proposed" && intent.reasons.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Asking you because: {intentReasonText(intent.reasons)}
        </p>
      )}
      {open && (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Correction"
            placeholder="Correct the intent (optional)"
            rows={2}
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={confirm}>
              Confirm
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !correction.trim()} onClick={correct}>
              Send correction
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
