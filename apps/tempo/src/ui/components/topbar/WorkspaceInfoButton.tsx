import { InfoIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { toggleWorkspaceInfo, showWorkspaceInfo, setPhonePane } from "~/ui/state/workspace-ui";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import type { WorkspaceView } from "./topbar-logic";

export function WorkspaceInfoButton({ view, phone = false }: { view: WorkspaceView; phone?: boolean }) {
  const infoOpen = useWorkspaceUiSelector(view.w.id, (ui) => ui.infoOpen);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Workspace info"
      aria-pressed={infoOpen}
      onClick={() => {
        if (phone) {
          showWorkspaceInfo(view.w.id);
          setPhonePane("info");
        } else {
          toggleWorkspaceInfo(view.w.id);
        }
      }}
    >
      <InfoIcon />
    </Button>
  );
}
