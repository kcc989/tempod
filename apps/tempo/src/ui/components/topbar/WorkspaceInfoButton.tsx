import { InfoIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { selectTool, setPhonePane } from "~/ui/state/workspace-ui";
import type { WorkspaceView } from "./topbar-logic";

export function WorkspaceInfoButton({ view, phone = false }: { view: WorkspaceView; phone?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Workspace info"
      onClick={() => {
        selectTool(view.w.id, "info");

        if (phone) setPhonePane("tools");
      }}
    >
      <InfoIcon />
    </Button>
  );
}
