import { useQuery } from "@tanstack/react-query";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/ui/components/ui/dialog";
import { setupStatusQueryOptions } from "~/ui/auth";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";

/** REGION D placeholder: Add project (listInstallations, listInstallationRepos, linkProject). */
export function AddProjectDialog() {
  const { open, onOpenChange } = useDialog("addProject");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
        </DialogHeader>
        {open && <Installations />}
      </DialogContent>
    </Dialog>
  );
}

function Installations() {
  const installations = useCallQuery("listInstallations", {});
  const setup = useQuery(setupStatusQueryOptions);
  if (installations.isPending) return <SkeletonRows rows={4} />;
  if (installations.isError)
    return <ErrorState error={installations.error} onRetry={() => void installations.refetch()} />;
  if (installations.data.length === 0) {
    return setup.data?.installUrl ? (
      <Button asChild>
        <a href={setup.data.installUrl} target="_blank" rel="noopener noreferrer">
          Install the GitHub App
        </a>
      </Button>
    ) : (
      <p className="text-sm text-muted-foreground">Install the GitHub App</p>
    );
  }
  return (
    <div className="flex max-h-96 flex-col gap-3 overflow-y-auto">
      {installations.data.map((i) => (
        <Repos key={i.installationId} installationId={i.installationId} account={i.accountLogin} />
      ))}
    </div>
  );
}

function Repos({ installationId, account }: { installationId: number; account: string }) {
  const repos = useCallQuery("listInstallationRepos", { installationId });
  const link = useCallMutation("linkProject", { invalidates: ["listProjects"] });
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{account}</h3>
      {repos.isPending && <SkeletonRows rows={3} />}
      {repos.isError && <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />}
      {repos.data?.map((r) => (
        <div key={r.repoId} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">
            {r.owner}/{r.name}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={link.isPending}
            onClick={() => link.mutate({ installationId, repoId: r.repoId })}
          >
            Link
          </Button>
        </div>
      ))}
    </div>
  );
}
