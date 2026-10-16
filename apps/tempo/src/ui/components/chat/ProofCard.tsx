import type { ChecklistItem, ItemOf, ProofContent } from "@tempo/protocol";
import { useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { artifactSrc } from "~/ui/components/artifacts/artifact-model";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { openArtifactTab } from "~/ui/state/workspace-ui";
import { proofCheckText, proofStatusText } from "./transcript-model";

const EMPTY: ReadonlyArray<ChecklistItem> = [];

/** 13, L-ADR-2: a proof with its screens, Tempo's check results and what is missing. */
export function ProofCard({
  workspaceId,
  proof,
  writable,
}: {
  workspaceId: string;
  proof: ProofContent;
  writable: boolean;
}) {
  const checklist = useWorkspaceSelector(workspaceId, (s) => s.workspace?.checklist ?? EMPTY);
  const reopen = useCallMutation("reopenChecklistItem");
  const textOf = (id: string) => checklist.find((c) => c.id === id)?.text ?? id;

  return (
    <section aria-label="Proof" className="mx-4 flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">{proofStatusText(proof.status)}</p>
      <p className="whitespace-pre-wrap break-words">{proof.summary}</p>
      {proof.screens.length > 0 && (
        <ul aria-label="Screens" className="flex flex-wrap gap-2">
          {proof.screens.map((s) => (
            <li key={`${s.artifactId}:${s.version}`}>
              <button
                type="button"
                className="flex flex-col items-start gap-1 rounded border p-1 text-xs hover:bg-accent"
                onClick={() => openArtifactTab(workspaceId, s.artifactId, s.version)}
              >
                <img
                  alt={`${s.route}, ${s.viewport}, ${s.theme}`}
                  src={artifactSrc(workspaceId, s.artifactId, s.version)}
                  className="h-24 w-auto max-w-40 rounded-sm object-cover"
                />
                <span>
                  {s.route} · {s.viewport} · {s.theme}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {proof.checks.length > 0 && (
        <ul aria-label="Checks" className="flex flex-col gap-0.5 text-xs">
          {proof.checks.map((c) => (
            <li key={c.name}>{proofCheckText(c)}</li>
          ))}
        </ul>
      )}
      {proof.missingRoutes.length > 0 && (
        <p className="text-xs text-destructive">No screen for: {proof.missingRoutes.join(", ")}</p>
      )}
      {proof.missingChecklist.length > 0 && (
        <div className="text-xs text-destructive">
          <p>Open checklist items not resolved:</p>
          <ul className="list-disc pl-4">
            {proof.missingChecklist.map((id) => (
              <li key={id}>{textOf(id)}</li>
            ))}
          </ul>
        </div>
      )}
      {proof.resolved.length > 0 && (
        <ul aria-label="Checklist" className="flex flex-col gap-1 text-xs">
          {proof.resolved.map((r) => {
            const item = checklist.find((c) => c.id === r.checklistId);

            return (
              <li key={r.checklistId} className="flex items-start justify-between gap-2">
                <span>
                  {textOf(r.checklistId)}
                  {r.note && <span className="text-muted-foreground"> — {r.note}</span>}
                </span>
                {writable && item?.status === "resolved" && item.resolvedBy === proof.proofId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1.5"
                    disabled={reopen.isPending}
                    onClick={() => reopen.mutate({ workspaceId, checklistId: r.checklistId })}
                  >
                    Reopen
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 13, L-ADR-2: Add to checklist on a user message. */
export function AddToChecklist({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const added = useWorkspaceSelector(workspaceId, (s) =>
    (s.workspace?.checklist ?? EMPTY).some((c) => c.sourceItemId === itemId),
  );

  const add = useCallMutation("addChecklistItem");

  if (added) return <span>On checklist</span>;

  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-5 px-1.5"
      disabled={add.isPending}
      onClick={() => add.mutate({ workspaceId, itemId })}
    >
      Add to checklist
    </Button>
  );
}

/** The newest proof of the workspace, or null. */
const latestProof = (items: Readonly<Record<string, { kind: string; createdAt: number }>>) => {
  let latest: ItemOf<"proof"> | null = null;

  for (const item of Object.values(items)) {
    if (item.kind === "proof" && (!latest || item.createdAt > latest.createdAt))
      // SAFETY: the kind check above selects proof items.
      latest = item as ItemOf<"proof">;
  }

  return latest;
};

/** 13, L-ADR-2: the newest proof above the preview, with what is missing. */
export function PreviewProof({ workspaceId }: { workspaceId: string }) {
  const proof = useWorkspaceSelector(workspaceId, (s) => latestProof(s.items));
  const [open, setOpen] = useState(false);

  if (!proof) return null;
  const p = proof.content;

  const missing =
    p.missingRoutes.length + p.missingChecklist.length + p.checks.filter((c) => c.status === "failed").length;

  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-2 px-2 py-1 text-xs">
        <span className="font-medium">{proofStatusText(p.status)}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.summary.split("\n")[0]}</span>
        {p.status === "incomplete" && <span className="text-destructive">{missing} missing</span>}
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide proof" : "Show proof"}
        </Button>
      </div>
      {open && (
        <div className="max-h-80 overflow-auto pb-2">
          <ProofCard workspaceId={workspaceId} proof={p} writable />
        </div>
      )}
    </div>
  );
}
