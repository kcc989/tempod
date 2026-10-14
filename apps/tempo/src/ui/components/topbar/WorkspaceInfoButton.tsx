import { InfoIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { showWorkspaceInfo, setPhonePane } from "~/ui/state/workspace-ui";
import type { WorkspaceView } from "./topbar-logic";

export function WorkspaceInfoButton({ view, phone = false }: { view: WorkspaceView; phone?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Workspace info"
      onClick={() => {
        showWorkspaceInfo(view.w.id);

        if (phone) setPhonePane("tools");
      }}
    >
      <InfoIcon />
    </Button>
  );
}
