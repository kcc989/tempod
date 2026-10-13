import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useCallMutation } from "~/ui/hooks/useCall";
import { Button } from "~/ui/components/ui/button";

export function AgentProposalCard({
  workspaceId,
  proposalId,
  writable,
}: {
  workspaceId: string;
  proposalId: string;
  writable: boolean;
}) {
  const record = useWorkspaceSelector(workspaceId, (s) =>
    s.workspace?.agentProposals?.find((p) => p.id === proposalId),
  );

  const resolve = useCallMutation("resolveAgentProposal", {
    invalidates: ["listAgents", "listProjectAgents"],
  });

  if (!record) return <div role="status">Loading agent proposal…</div>;

  return (
    <section aria-label="Agent proposal" className="mx-4 space-y-2 rounded border p-3 text-sm">
      <h3 className="font-medium">Agent changes · {record.status}</h3>
      <p className="whitespace-pre-wrap">{record.proposal.note}</p>
      <pre
        tabIndex={0}
        aria-label="Proposed changes"
        className="max-h-96 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap"
      >
        {JSON.stringify(record.proposal, null, 2)}
      </pre>
      {record.status === "pending" && (
        <div className="flex gap-2">
          <Button
            disabled={!writable || resolve.isPending}
            onClick={() => resolve.mutate({ workspaceId, proposalId, apply: true })}
          >
            Apply
          </Button>
          <Button
            variant="ghost"
            disabled={!writable || resolve.isPending}
            onClick={() => resolve.mutate({ workspaceId, proposalId, apply: false })}
          >
            Reject
          </Button>
        </div>
      )}
    </section>
  );
}
