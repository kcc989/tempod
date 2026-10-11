import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";

export interface WorkspaceBannersProps {
  readonly workspaceId: string;
}

/** REGION B placeholder: workspace banners above the center tabs (04, Empty, loading and error states). */
export function WorkspaceBanners({ workspaceId }: WorkspaceBannersProps) {
  const state = useWorkspaceSelector(workspaceId, (s) => s.workspace?.state);
  if (state !== "sleeping") return null;
  return (
    <div role="status" className="shrink-0 border-b bg-muted px-3 py-1.5 text-sm text-muted-foreground">
      Sleeping. Sending a message wakes it.
    </div>
  );
}
