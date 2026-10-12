import type { PendingEnvironmentProposal } from "@tempo/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { NetworkIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  applyEnvironmentProposal,
  effectiveEnvironment,
  INJECTOR_WARNING,
  policyLabel,
  proposalSecrets,
  proposalTargetText,
} from "~/ui/components/dialogs/environments-model";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Input } from "~/ui/components/ui/input";
import { invalidateCalls, useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useProject } from "~/ui/hooks/useProjects";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { call } from "~/ui/lib/api";
import { toastError } from "~/ui/lib/toast";

/** 04, Pending environment proposals: a banner above the composer with Review. */
export function EnvironmentProposalBanner({ workspaceId }: { workspaceId: string }) {
  const proposals = useWorkspaceSelector(workspaceId, (s) => s.workspace?.environmentProposals);
  const [open, setOpen] = useState(false);
  const oldest = proposals?.[0];
  if (!oldest) return null;
  return (
    <>
      <div role="status" className="flex items-center gap-2 border-t bg-primary/5 px-3 py-1.5 text-sm">
        <NetworkIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">The agent suggests environment changes</span>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Review
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Environment changes</DialogTitle>
            <DialogDescription>
              {proposals.length > 1
                ? `The oldest of ${proposals.length} suggestions from the agent.`
                : "A suggestion from the agent."}
            </DialogDescription>
          </DialogHeader>
          <ProposalReview
            key={oldest.id}
            workspaceId={workspaceId}
            pending={oldest}
            onDone={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProposalReview({
  workspaceId,
  pending,
  onDone,
}: {
  workspaceId: string;
  pending: PendingEnvironmentProposal;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const workspace = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const project = useProject(workspace?.projectId);
  const envs = useCallQuery("listEnvironments", {});
  const [values, setValues] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const dismiss = useCallMutation("resolveEnvironmentProposal", {
    onSuccess: () => {
      toast.success("Suggestion dismissed");
      onDone();
    },
  });

  if (envs.isPending) return <SkeletonRows rows={4} />;
  if (envs.isError) return <ErrorState error={envs.error} onRetry={() => void envs.refetch()} />;

  const p = pending.proposal;
  const target = effectiveEnvironment(envs.data, workspace?.environmentId, project);
  const secrets = proposalSecrets(p, target);
  const hosts = p.allowlistAdd ?? [];
  const injectors = p.injectors ?? [];
  const busy = applying || dismiss.isPending;

  const apply = async () => {
    if (!project) return;
    setApplying(true);
    try {
      await applyEnvironmentProposal(call, {
        workspaceId,
        proposalId: pending.id,
        proposal: p,
        project,
        target,
        environments: envs.data,
        values,
      });
      toast.success("Environment changes applied");
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setApplying(false);
      await invalidateCalls(queryClient, "listEnvironments", "listProjects");
    }
  };

  return (
    <form
      className="grid min-w-0 gap-4"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
    >
      {p.note.trim() !== "" && <p className="text-sm break-words whitespace-pre-wrap">{p.note}</p>}
      <ul aria-label="Changes" className="grid gap-3 text-sm">
        {p.egressPolicy && (
          <li>
            <span className="font-medium">Egress policy:</span> {policyLabel(p.egressPolicy)}
          </li>
        )}
        {hosts.length > 0 && (
          <li className="grid gap-1">
            <span className="font-medium">Hosts to add</span>
            <ul className="grid gap-0.5 font-mono text-xs">
              {hosts.map((h) => (
                <li key={h} className="break-all">
                  {h}
                </li>
              ))}
            </ul>
          </li>
        )}
        {secrets.length > 0 && (
          <li className="grid gap-1">
            <span className="font-medium">Secrets</span>
            <ul className="grid gap-2">
              {secrets.map((s) => (
                <li key={s.name} className="grid gap-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="font-mono">{s.name}</span>
                    {s.hosts.length > 0 ? (
                      <span className="font-mono break-all text-muted-foreground">{s.hosts.join(", ")}</span>
                    ) : (
                      <span className="text-warning">Visible to the agent</span>
                    )}
                  </div>
                  {s.needsValue && (
                    <Input
                      aria-label={`${s.name} value`}
                      type="password"
                      placeholder="Value"
                      value={values[s.name] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [s.name]: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </li>
              ))}
            </ul>
          </li>
        )}
        {injectors.length > 0 && (
          <li className="grid gap-1">
            <span className="font-medium">Injectors</span>
            <ul className="grid gap-2">
              {injectors.map((i) => (
                <li key={i.name} className="grid min-w-0 gap-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="font-mono">{i.name}</span>
                    <span className="font-mono break-all text-muted-foreground">{i.hosts.join(", ")}</span>
                  </div>
                  <pre
                    aria-label={`${i.name} code`}
                    tabIndex={0}
                    className="max-h-72 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {i.code}
                  </pre>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
      {injectors.length > 0 && (
        <p role="note" className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {INJECTOR_WARNING}
        </p>
      )}
      <p className="text-sm font-medium">{proposalTargetText(target, project?.name ?? "")}</p>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => dismiss.mutate({ workspaceId, proposalId: pending.id, status: "dismissed" })}
        >
          Dismiss
        </Button>
        <Button type="submit" disabled={busy || !project}>
          {applying ? "Applying…" : "Apply"}
        </Button>
      </DialogFooter>
    </form>
  );
}
