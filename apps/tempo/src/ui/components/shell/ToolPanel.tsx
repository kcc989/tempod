import { RunActivity } from "../chat/RunCard";
import { SharedHeaderRegion, useAppHeader } from "~/ui/components/shell/AppHeader";
import { useState } from "react";
import {
  BookOpenIcon,
  FileDiffIcon,
  GlobeIcon,
  PlayIcon,
  PlusIcon,
  BoxesIcon,
  SquareTerminalIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { CenterTabPart } from "~/ui/components/chat/tab-kinds";
import { ArtifactsView } from "~/ui/components/artifacts/ArtifactsView";
import { ChangesView } from "~/ui/components/review/ChangesView";
import { ChecksView } from "~/ui/components/review/ChecksView";
import { FilesView } from "~/ui/components/review/FilesView";
import { RunTab } from "~/ui/components/processes/RunTab";
import { SetupTab } from "~/ui/components/processes/SetupTab";
import { TerminalTab } from "~/ui/components/processes/TerminalTab";
import { isTerminalId, nextTerminalId } from "~/ui/components/processes/terminal-model";
import { Button } from "~/ui/components/ui/button";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { formatBinding } from "~/ui/lib/shortcuts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useWorkspaceUi } from "~/ui/hooks/useWorkspaceUi";
import {
  activateTab,
  toolGroup,
  closeTab,
  closeTool,
  newTerminal,
  openLiveView,
  openGuide,
  openTerminals,
  selectTool,
  type UtilityTab,
} from "~/ui/state/workspace-ui";

const tools: ReadonlyArray<{ key: UtilityTab; label: string; icon: LucideIcon }> = [
  { key: "changes", label: "Changes", icon: FileDiffIcon },
  { key: "artifacts", label: "Artifacts", icon: BoxesIcon },
  { key: "activity", label: "Activity", icon: PlayIcon },
  { key: "run", label: "Run", icon: PlayIcon },
];

export function ToolPanel({ workspaceId, phone = false }: { workspaceId: string; phone?: boolean }) {
  const ui = useWorkspaceUi(workspaceId);
  const sharedHeader = useAppHeader();
  const documents = ui.tabs.filter((t) => t.tab.kind !== "chat");
  const active = ui.activeToolKey;
  const activeGroup = toolGroup(active);
  const [runOpened, setRunOpened] = useState(false);

  if (active === "run" && !runOpened) setRunOpened(true);
  const terminals = phone ? [] : openTerminals(ui);

  // Outer tabs keep the order they were opened in (04).
  const utilities = ui.toolTabs.flatMap((key) =>
    isTerminalId(key)
      ? terminals.includes(key)
        ? [{ key, label: `Terminal ${key.slice(1)}`, icon: SquareTerminalIcon }]
        : []
      : tools.filter((t) => t.key === toolGroup(key)),
  );

  const launcherOrder = ["terminal", "run", "browser", "guides", "artifacts", "activity"];

  const launchers = [
    ...(phone
      ? []
      : [
          {
            key: "terminal",
            label: "Terminal",
            icon: SquareTerminalIcon,
            open: () => newTerminal(workspaceId),
          },
        ]),
    ...tools.flatMap((tool) =>
      tool.key === "changes"
        ? []
        : [
            {
              ...tool,
              open: () => selectTool(workspaceId, phone && tool.key === "run" ? "setup" : tool.key),
            },
          ],
    ),
    { key: "browser", label: "Browser", icon: GlobeIcon, open: () => openLiveView(workspaceId) },
    { key: "guides", label: "Guides", icon: BookOpenIcon, open: () => openGuide(workspaceId) },
  ].sort((a, b) => launcherOrder.indexOf(a.key) - launcherOrder.indexOf(b.key));

  const terminalsFull = nextTerminalId(terminals) === null;

  return (
    <section aria-label="Workspace tools" className="flex h-full min-h-0 flex-col bg-background">
      <Tabs
        value={activeGroup ?? "tools"}
        onValueChange={(key) => {
          const utility = tools.find((t) => t.key === key);

          if (isTerminalId(key)) selectTool(workspaceId, key);
          else if (utility) {
            let key = utility.key;

            if (key === "changes") key = ui.changesSection;
            else if (key === "run") key = phone ? "setup" : ui.runSection;

            selectTool(workspaceId, key);
          } else if (key === "tools") selectTool(workspaceId, null);
          else activateTab(workspaceId, key);
        }}
        className="h-full min-h-0 gap-0"
      >
        <SharedHeaderRegion region="tools">
          <div
            className={"flex h-10 shrink-0 items-center bg-muted pr-1" + (sharedHeader ? "" : " border-b")}
          >
            <TabsList
              variant="line"
              aria-label="Tool tabs"
              className="h-full min-w-0 flex-1 justify-start overflow-x-auto rounded-none pr-1 pl-3"
            >
              {utilities.map(({ key, label, icon: Icon }) => (
                <div key={key} className="flex shrink-0 items-center">
                  <TabsTrigger value={key}>
                    <Icon aria-hidden className="size-3.5" />
                    {label}
                  </TabsTrigger>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    aria-label={`Close ${label}`}
                    onClick={() => closeTool(workspaceId, key)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
              ))}
              {documents.map((t) => (
                <div key={t.key} className="flex shrink-0 items-center">
                  <TabsTrigger value={t.key} className="max-w-48 truncate">
                    <CenterTabPart
                      part="Title"
                      workspaceId={workspaceId}
                      tab={t.tab}
                      seq={t.seq}
                      active={active === t.key}
                    />
                  </TabsTrigger>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    aria-label="Close tool tab"
                    onClick={() => closeTab(workspaceId, t.key)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
              ))}
            </TabsList>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New tool tab"
              title="Open a tool"
              onClick={() => selectTool(workspaceId, null)}
            >
              <PlusIcon className="size-4" />
            </Button>
          </div>
        </SharedHeaderRegion>
        <TabsContent value="tools" className="min-h-0 overflow-y-auto p-6">
          <h2 className="mb-4 text-base font-medium">Tools</h2>
          <div className="grid grid-cols-2 gap-2">
            {launchers.map(({ key, label, icon: Icon, open }) => {
              const disabled = key === "terminal" && terminalsFull;

              const row = (
                <Button
                  key={key}
                  aria-label={label}
                  variant="ghost"
                  disabled={disabled}
                  className="h-9 w-full justify-start rounded-md bg-muted px-3 text-sm font-normal"
                  onClick={open}
                >
                  <Icon aria-hidden />
                  {label}
                  {key === "terminal" && (
                    <kbd className="ml-auto rounded-full bg-accent px-2 text-xs text-muted-foreground">
                      {formatBinding("toggleBottom")}
                    </kbd>
                  )}
                </Button>
              );

              return disabled ? (
                <SimpleTooltip key={key} label="Nine terminals are open">
                  <span tabIndex={0} className="flex rounded-md">
                    {row}
                  </span>
                </SimpleTooltip>
              ) : (
                row
              );
            })}
          </div>
        </TabsContent>
        <TabsContent value="changes" className="flex min-h-0 flex-col">
          <Tabs
            value={active ?? "changes"}
            onValueChange={(key) => {
              if (key === "changes" || key === "files" || key === "checks") selectTool(workspaceId, key);
            }}
            className="h-full min-h-0 gap-0"
          >
            <TabsList
              variant="line"
              aria-label="Changes sections"
              className="h-9 shrink-0 justify-start rounded-none border-b px-3"
            >
              <TabsTrigger value="changes">Changes</TabsTrigger>
              {!phone && <TabsTrigger value="files">Files</TabsTrigger>}
              <TabsTrigger value="checks">Checks</TabsTrigger>
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
          </Tabs>
        </TabsContent>
        <TabsContent value="activity" className="min-h-0 overflow-auto p-2">
          <RunActivity workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="artifacts" className="flex min-h-0 flex-col">
          <ArtifactsView workspaceId={workspaceId} />
        </TabsContent>
        {ui.toolTabs.some((key) => toolGroup(key) === "run") && (
          <TabsContent value="run" forceMount className="min-h-0 data-[state=inactive]:hidden">
            <Tabs
              value={active === "setup" ? "setup" : "run"}
              onValueChange={(key) => {
                if (key === "setup" || key === "run") selectTool(workspaceId, key);
              }}
              className="h-full min-h-0 gap-0"
            >
              <TabsList
                variant="line"
                aria-label="Run sections"
                className="h-9 shrink-0 justify-start rounded-none border-b px-3"
              >
                <TabsTrigger value="setup">Setup</TabsTrigger>
                {!phone && <TabsTrigger value="run">Run</TabsTrigger>}
              </TabsList>
              <TabsContent value="setup" className="min-h-0">
                <SetupTab workspaceId={workspaceId} />
              </TabsContent>
              {runOpened && (
                <TabsContent value="run" forceMount className="min-h-0 data-[state=inactive]:hidden">
                  <RunTab workspaceId={workspaceId} />
                </TabsContent>
              )}
            </Tabs>
          </TabsContent>
        )}
        {terminals.map((id) => (
          <TabsContent
            key={id}
            value={id}
            forceMount
            className="relative min-h-0 data-[state=inactive]:hidden"
          >
            <TerminalTab workspaceId={workspaceId} terminalId={id} visible={active === id} />
          </TabsContent>
        ))}
        {documents.map((t) => (
          <TabsContent key={t.key} value={t.key} forceMount className="min-h-0 data-[state=inactive]:hidden">
            <CenterTabPart
              part="Body"
              workspaceId={workspaceId}
              tab={t.tab}
              seq={t.seq}
              active={active === t.key}
            />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
