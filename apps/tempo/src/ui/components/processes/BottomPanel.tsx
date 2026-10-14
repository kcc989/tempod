import { useState } from "react";
import { PhoneUnavailable } from "~/ui/components/shell/States";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { setBottomTab, type BottomTab } from "~/ui/state/workspace-ui";
import { RunTab } from "./RunTab";
import { SetupTab } from "./SetupTab";
import { TerminalTab } from "./TerminalTab";
import { useToggleRunAction } from "./useScripts";

export interface BottomPanelProps {
  readonly workspaceId: string;
}

const isBottomTab = (v: string): v is BottomTab => v === "setup" || v === "run" || v === "terminal";

/**
 * 04, Bottom panel tabs: Setup, Run and Terminal. Terminals stay connected while another tab
 * shows. Phone width has no terminal and no Run output.
 */
export function BottomPanel({ workspaceId }: BottomPanelProps) {
  const tab = useWorkspaceUiSelector(workspaceId, (s) => s.bottomTab);
  const isPhone = useIsPhone();
  const setupFailed = useWorkspaceSelector(workspaceId, (s) => s.workspace?.setupStatus === "failed");
  const [terminalOpened, setTerminalOpened] = useState(false);
  if (tab === "terminal" && !isPhone && !terminalOpened) setTerminalOpened(true);
  useToggleRunAction(workspaceId);

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => isBottomTab(v) && setBottomTab(workspaceId, v)}
      className="h-full min-h-0 gap-0"
    >
      <TabsList variant="line" aria-label="Processes" className="w-full shrink-0 justify-start px-2">
        <TabsTrigger value="setup">
          Setup
          {setupFailed && (
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
              <span className="sr-only">(failed)</span>
            </>
          )}
        </TabsTrigger>
        <TabsTrigger value="run">Run</TabsTrigger>
        {!isPhone && <TabsTrigger value="terminal">Terminal</TabsTrigger>}
      </TabsList>
      <TabsContent value="setup" className="min-h-0">
        <SetupTab workspaceId={workspaceId} />
      </TabsContent>
      {isPhone ? (
        <TabsContent value="run" className="min-h-0">
          <PhoneUnavailable className="h-full" />
        </TabsContent>
      ) : (
        <TabsContent value="run" forceMount className="min-h-0 data-[state=inactive]:hidden">
          <RunTab workspaceId={workspaceId} />
        </TabsContent>
      )}
      {isPhone ? (
        <TabsContent value="terminal" className="min-h-0">
          <PhoneUnavailable className="h-full" />
        </TabsContent>
      ) : (
        terminalOpened && (
          <TabsContent value="terminal" forceMount className="min-h-0 data-[state=inactive]:hidden">
            <TerminalTab key={workspaceId} workspaceId={workspaceId} visible={tab === "terminal"} />
          </TabsContent>
        )
      )}
    </Tabs>
  );
}
