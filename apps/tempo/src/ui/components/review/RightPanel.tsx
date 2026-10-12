import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { setRightTab, type RightTab } from "~/ui/state/workspace-ui";
import { ArtifactsView } from "~/ui/components/artifacts/ArtifactsView";
import { ChangesView } from "./ChangesView";
import { ChecksView } from "./ChecksView";
import { FilesView } from "./FilesView";

export interface RightPanelProps {
  readonly workspaceId: string;
  /** `phone`: the Changes pane only, with the primary git action at the top (04, Phone width). */
  readonly variant?: "desktop" | "phone";
}

const isRightTab = (v: string): v is RightTab =>
  v === "changes" || v === "files" || v === "checks" || v === "artifacts";

/** 04, Right and bottom panels: Changes, All files, Checks and Artifacts. */
export function RightPanel({ workspaceId, variant = "desktop" }: RightPanelProps) {
  const tab = useWorkspaceUiSelector(workspaceId, (s) => s.rightTab);
  if (variant === "phone") {
    return (
      <>
        <ChangesView workspaceId={workspaceId} variant="phone" />
      </>
    );
  }
  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (isRightTab(v)) setRightTab(workspaceId, v);
        }}
        className="h-full min-h-0 gap-0"
      >
        <TabsList variant="line" className="w-full shrink-0 justify-start px-2">
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="files">All files</TabsTrigger>
          <TabsTrigger value="checks">Checks</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>
        <TabsContent value="changes" className="flex min-h-0 flex-col">
          <ChangesView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="files" className="flex min-h-0 flex-col">
          <FilesView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="checks" className="flex min-h-0 flex-col">
          <ChecksView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="artifacts" className="flex min-h-0 flex-col">
          <ArtifactsView workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>
    </>
  );
}
