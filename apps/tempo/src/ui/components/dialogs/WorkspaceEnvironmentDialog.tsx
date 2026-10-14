import { toast } from "sonner";
import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useProject } from "~/ui/hooks/useProjects";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { findEnvironment, PROJECT_DEFAULT, projectDefaultLabel } from "./environments-model";

/** 04, Environment… dialog: the workspace's environment override, saved at once. */
export function WorkspaceEnvironmentDialog() {
  const { open, args, onOpenChange } = useDialog("environment");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Environment</DialogTitle>
          <DialogDescription>
            Changes apply to new requests within a minute. Scripts and agents started later get the new
            secrets.
          </DialogDescription>
        </DialogHeader>
        {args && <Body workspaceId={args.workspaceId} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const project = useProject(workspace?.projectId);
  const envs = useCallQuery("listEnvironments", {});

  const set = useCallMutation("setWorkspaceEnvironment", {
    onSuccess: () => toast.success("Environment changed"),
  });

  if (envs.isPending || !workspace) return <SkeletonRows rows={2} />;

  if (envs.isError) return <ErrorState error={envs.error} onRetry={() => void envs.refetch()} />;
  const projectEnv = findEnvironment(envs.data, project?.environmentId);
  const override = findEnvironment(envs.data, workspace.environmentId);
  // The last choice shows until the channel sends the new detail.
  const chosen = set.variables && !set.isError ? set.variables.environmentId : undefined;
  const value = (chosen === undefined ? override?.id : chosen) ?? PROJECT_DEFAULT;

  return (
    <div className="grid gap-1.5">
      <label htmlFor="ws-environment" className="text-sm font-medium">
        Environment
      </label>
      <Select
        value={value}
        disabled={set.isPending}
        onValueChange={(v) => set.mutate({ workspaceId, environmentId: v === PROJECT_DEFAULT ? null : v })}
      >
        <SelectTrigger id="ws-environment" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PROJECT_DEFAULT}>{projectDefaultLabel(projectEnv)}</SelectItem>
          {envs.data.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
