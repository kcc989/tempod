import { EmptyState } from "~/ui/components/shell/States";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useWorkspace } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { openDiff, setRightTab, type RightTab } from "~/ui/state/workspace-ui";

export interface RightPanelProps {
  readonly workspaceId: string;
  /** `phone`: the Changes pane only, with the primary git action at the top (04, Phone width). */
  readonly variant?: "desktop" | "phone";
}

/** REGION C placeholder: Changes, All files and Checks tabs (04, Right and bottom panels). */
export function RightPanel({ workspaceId }: RightPanelProps) {
  const tab = useWorkspaceUiSelector(workspaceId, (s) => s.rightTab);
  const ws = useWorkspace(workspaceId);
  const files = ws.changes?.files ?? ws.workspace?.changes?.files ?? [];
  return (
    <Tabs value={tab} onValueChange={(v) => setRightTab(workspaceId, v as RightTab)} className="h-full min-h-0 gap-0">
      <TabsList variant="line" className="w-full justify-start px-2">
        <TabsTrigger value="changes">Changes</TabsTrigger>
        <TabsTrigger value="files">All files</TabsTrigger>
        <TabsTrigger value="checks">Checks</TabsTrigger>
      </TabsList>
      <TabsContent value="changes" className="min-h-0 overflow-auto">
        {files.length === 0 ? (
          <EmptyState title="No changes yet." />
        ) : (
          <ul className="flex flex-col p-1">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => openDiff(workspaceId, f.path)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-0.5 text-left text-sm hover:bg-accent"
                >
                  <span className="w-3 font-mono text-xs text-muted-foreground">{f.status}</span>
                  <span className="truncate">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </TabsContent>
      <TabsContent value="files">
        <EmptyState title="All files" />
      </TabsContent>
      <TabsContent value="checks">
        <EmptyState title="Checks" />
      </TabsContent>
    </Tabs>
  );
}
