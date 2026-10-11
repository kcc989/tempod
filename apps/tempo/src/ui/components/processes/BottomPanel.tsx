import { EmptyState } from "~/ui/components/shell/States";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { setBottomTab, type BottomTab } from "~/ui/state/workspace-ui";

export interface BottomPanelProps {
  readonly workspaceId: string;
}

/** REGION D placeholder: Setup, Run and Terminal tabs (04, Bottom panel tabs). */
export function BottomPanel({ workspaceId }: BottomPanelProps) {
  const tab = useWorkspaceUiSelector(workspaceId, (s) => s.bottomTab);
  return (
    <Tabs value={tab} onValueChange={(v) => setBottomTab(workspaceId, v as BottomTab)} className="h-full min-h-0 gap-0">
      <TabsList variant="line" className="w-full justify-start px-2">
        <TabsTrigger value="setup">Setup</TabsTrigger>
        <TabsTrigger value="run">Run</TabsTrigger>
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
      </TabsList>
      <TabsContent value="setup">
        <EmptyState title="Setup" />
      </TabsContent>
      <TabsContent value="run">
        <EmptyState title="Run" />
      </TabsContent>
      <TabsContent value="terminal">
        <EmptyState title="Terminal" />
      </TabsContent>
    </Tabs>
  );
}
