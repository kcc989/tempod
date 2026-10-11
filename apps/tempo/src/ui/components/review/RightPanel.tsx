import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { setRightTab, type RightTab } from "~/ui/state/workspace-ui";
import { ChangesView } from "./ChangesView";
import { ChecksView } from "./ChecksView";
import { FilesView } from "./FilesView";
import { ReviewDialogs } from "./ReviewDialogs";

export interface RightPanelProps {
  readonly workspaceId: string;
  /** `phone`: the Changes pane only, with the primary git action at the top (04, Phone width). */
  readonly variant?: "desktop" | "phone";
}

const isRightTab = (v: string): v is RightTab => v === "changes" || v === "files" || v === "checks";

/** 04, Right and bottom panels: Changes, All files and Checks. */
export function RightPanel({ workspaceId, variant = "desktop" }: RightPanelProps) {
  const tab = useWorkspaceUiSelector(workspaceId, (s) => s.rightTab);
  if (variant === "phone") {
    return (
      <>
        <ChangesView workspaceId={workspaceId} variant="phone" />
        <ReviewDialogs workspaceId={workspaceId} />
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
        </TabsList>
        <TabsContent value="changes" className="min-h-0">
          <ChangesView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="files" className="min-h-0">
          <FilesView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="checks" className="min-h-0">
          <ChecksView workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>
      <ReviewDialogs workspaceId={workspaceId} />
    </>
  );
}
