import { RunActivity } from "../chat/RunCard";
import { useState } from "react";
import {
  FileIcon,
  InfoIcon,
  BookOpenIcon,
  FileDiffIcon,
  FolderIcon,
  GlobeIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
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
import { Button } from "~/ui/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useWorkspaceUi } from "~/ui/hooks/useWorkspaceUi";
import {
  activateTab,
  showWorkspaceInfo,
  setPhonePane,
  closeTab,
  closeTool,
  openLiveView,
  openGuide,
  selectTool,
  type UtilityTab,
} from "~/ui/state/workspace-ui";

const tools: ReadonlyArray<{ key: UtilityTab; label: string; icon: LucideIcon }> = [
  { key: "files", label: "Files", icon: FolderIcon },
  { key: "terminal", label: "Terminal", icon: SquareTerminalIcon },
  { key: "changes", label: "Changes", icon: FileDiffIcon },
  { key: "checks", label: "Checks", icon: FileIcon },
  { key: "artifacts", label: "Artifacts", icon: BoxesIcon },
  { key: "activity", label: "Activity", icon: PlayIcon },
  { key: "setup", label: "Setup", icon: SettingsIcon },
  { key: "run", label: "Run", icon: PlayIcon },
];

export function ToolPanel({ workspaceId, phone = false }: { workspaceId: string; phone?: boolean }) {
  const ui = useWorkspaceUi(workspaceId);
  const documents = ui.tabs.filter((t) => t.tab.kind !== "chat");
  const active = ui.activeToolKey;
  const [terminalOpened, setTerminalOpened] = useState(false);

  if (active === "terminal" && !terminalOpened) setTerminalOpened(true);
  const available = tools.filter((t) => !phone || !["files", "terminal", "run"].includes(t.key));
  const utilities = available.filter((t) => ui.toolTabs.includes(t.key));

  return (
    <section aria-label="Workspace tools" className="flex h-full min-h-0 flex-col bg-background">
      <Tabs
        value={active ?? "tools"}
        onValueChange={(key) => {
          const utility = tools.find((t) => t.key === key);

          if (utility) selectTool(workspaceId, utility.key);
          else if (key === "tools") selectTool(workspaceId, null);
          else activateTab(workspaceId, key);
        }}
        className="h-full min-h-0 gap-0"
      >
        <div className="flex h-9 shrink-0 items-center border-b pr-1">
          <TabsList
            variant="line"
            aria-label="Tool tabs"
            className="h-full min-w-0 flex-1 justify-start overflow-x-auto rounded-none px-1"
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
            <TabsTrigger value="tools" aria-label="New tool tab">
              <PlusIcon className="size-4" />
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="tools" className="min-h-0 overflow-y-auto p-6">
          <h2 className="mb-4 text-sm font-medium">Open a tool</h2>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="h-11 justify-start"
              onClick={() => openLiveView(workspaceId)}
            >
              <GlobeIcon aria-hidden />
              Browser
            </Button>
            <Button variant="outline" className="h-11 justify-start" onClick={() => openGuide(workspaceId)}>
              <BookOpenIcon aria-hidden />
              Guides
            </Button>
            <Button
              variant="outline"
              className="h-11 justify-start"
              onClick={() => {
                showWorkspaceInfo(workspaceId);

                if (phone) setPhonePane("info");
              }}
            >
              <InfoIcon aria-hidden />
              Workspace info
            </Button>
            {available.map(({ key, label, icon: Icon }) => (
              <Button
                key={key}
                variant="outline"
                className="h-11 justify-start"
                onClick={() => selectTool(workspaceId, key)}
              >
                <Icon aria-hidden />
                {label}
              </Button>
            ))}
          </div>
          <p className="mt-5 text-sm text-muted-foreground">
            Browser shows the workspace’s Cloudflare Browser Run live view.
          </p>
        </TabsContent>
        <TabsContent value="changes" className="flex min-h-0 flex-col">
          <ChangesView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="files" className="flex min-h-0 flex-col">
          <FilesView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="checks" className="flex min-h-0 flex-col">
          <ChecksView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="activity" className="min-h-0 overflow-auto p-2">
          <RunActivity workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="artifacts" className="flex min-h-0 flex-col">
          <ArtifactsView workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="setup" className="min-h-0">
          <SetupTab workspaceId={workspaceId} />
        </TabsContent>
        {ui.toolTabs.includes("run") && (
          <TabsContent value="run" forceMount className="min-h-0 data-[state=inactive]:hidden">
            <RunTab workspaceId={workspaceId} />
          </TabsContent>
        )}
        {terminalOpened && ui.toolTabs.includes("terminal") && (
          <TabsContent value="terminal" forceMount className="min-h-0 data-[state=inactive]:hidden">
            <TerminalTab workspaceId={workspaceId} visible={active === "terminal"} />
          </TabsContent>
        )}
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
