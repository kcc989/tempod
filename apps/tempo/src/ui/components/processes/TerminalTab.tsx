import { MoonIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import {
  isTerminalId,
  nextTerminalId,
  terminalAvailability,
  terminalTabs,
  type TerminalId,
} from "./terminal-model";
import { TerminalView } from "./TerminalView";

/**
 * 04, Bottom panel: tabs t1 to t9, a `+` button, and xterm. A terminal connects when its tab is
 * first shown and stays connected while the panel is open.
 */
export function TerminalTab({ workspaceId, visible }: { workspaceId: string; visible: boolean }) {
  const state = useWorkspaceSelector(workspaceId, (s) => s.workspace?.state ?? null);
  const availability = terminalAvailability(state);
  const listed = useCallQuery("listTerminals", { workspaceId }, { enabled: availability === "connect" });
  const wake = useCallMutation("wakeWorkspace");
  const [opened, setOpened] = useState<ReadonlyArray<TerminalId>>([]);
  const [picked, setPicked] = useState<TerminalId | null>(null);
  const [focusSeq, setFocusSeq] = useState(0);
  const [visited, setVisited] = useState<ReadonlySet<TerminalId>>(() => new Set());

  const known = terminalTabs(
    (listed.data ?? []).map((t) => t.terminalId),
    [...opened, ...visited],
  );

  const settled = listed.isSuccess || listed.isError;
  const tabs: ReadonlyArray<TerminalId> = known.length === 0 && settled ? ["t1"] : known;

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

  if (availability === "loading" || tabs.length === 0) return <SkeletonRows rows={3} />;

  const current = picked !== null && tabs.includes(picked) ? picked : tabs[0]!;

  if (!visited.has(current)) setVisited(new Set([...visited, current]));
  const next = nextTerminalId(tabs);

  const show = (id: TerminalId) => {
    setPicked(id);
    setFocusSeq((n) => n + 1);
  };

  return (
    <Tabs value={current} onValueChange={(v) => isTerminalId(v) && show(v)} className="h-full min-h-0 gap-0">
      <div className="flex shrink-0 items-center gap-1 border-b px-2">
        <TabsList variant="line" aria-label="Terminals" className="h-7 border-b-0">
          {tabs.map((id) => (
            <TabsTrigger key={id} value={id} className="font-mono text-xs">
              {id}
            </TabsTrigger>
          ))}
        </TabsList>
        <SimpleTooltip label={next ? "New terminal" : "Nine terminals are open"}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New terminal"
            disabled={next === null}
            onClick={() => {
              if (!next) return;
              setOpened((o) => [...new Set([...o, ...tabs, next])]);
              show(next);
            }}
          >
            <PlusIcon />
          </Button>
        </SimpleTooltip>
      </div>
      {tabs.map((id) => (
        <TabsContent key={id} value={id} forceMount className="relative min-h-0 data-[state=inactive]:hidden">
          {visited.has(id) && (
            <TerminalView
              workspaceId={workspaceId}
              terminalId={id}
              active={visible && id === current}
              focusSeq={focusSeq}
            />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}
