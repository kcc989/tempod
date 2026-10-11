import { ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/ui/components/ui/dialog";
import { useCallQuery } from "~/ui/hooks/useCall";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";

/** REGION D placeholder: Diagnostics (05, Diagnostics). Args: workspaceId. */
export function DiagnosticsDialog() {
  const { open, args, onOpenChange } = useDialog("diagnostics");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Diagnostics</DialogTitle>
        </DialogHeader>
        {args && <Body workspaceId={args.workspaceId} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ workspaceId }: { workspaceId: string }) {
  const d = useCallQuery("getDiagnostics", { workspaceId });
  if (d.isPending) return <SkeletonRows />;
  if (d.isError) return <ErrorState error={d.error} onRetry={() => void d.refetch()} />;
  return (
    <pre className="max-h-[60dvh] overflow-auto font-mono text-xs">{JSON.stringify(d.data, null, 2)}</pre>
  );
}
