import { MoonIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { terminalAvailability, type TerminalId } from "./terminal-model";
import { TerminalView } from "./TerminalView";

/**
 * 04, Right tool area: one outer tab per terminal, showing only xterm. The terminal stays connected
 * while its tab is open and another tab is shown.
 */
export function TerminalTab({
  workspaceId,
  terminalId,
  visible,
}: {
  workspaceId: string;
  terminalId: TerminalId;
  visible: boolean;
}) {
  const state = useWorkspaceSelector(workspaceId, (s) => s.workspace?.state ?? null);
  const availability = terminalAvailability(state);
  const wake = useCallMutation("wakeWorkspace");
  const [shown, setShown] = useState(false);
  const [focusSeq, setFocusSeq] = useState(0);

  if (visible !== shown) {
    setShown(visible);

    if (visible) setFocusSeq((n) => n + 1);
  }

  if (availability === "sleeping") {
    return (
      <EmptyState
        icon={MoonIcon}
        title="Sleeping."
        description="Wake the workspace to open a terminal."
        action={
          <Button size="sm" disabled={wake.isPending} onClick={() => wake.mutate({ workspaceId })}>
            Wake
          </Button>
        }
      />
    );
  }

  if (availability === "archived") return <EmptyState title="Restore this workspace first." />;

  if (availability === "loading") return <SkeletonRows rows={3} />;

  return (
    <TerminalView workspaceId={workspaceId} terminalId={terminalId} active={visible} focusSeq={focusSeq} />
  );
}
