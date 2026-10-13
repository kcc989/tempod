import { Match } from "effect";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { ChatTabs } from "~/ui/components/chat/ChatTabs";
import { WorkspaceBanners } from "~/ui/components/chat/WorkspaceBanners";
import { ToolPanel } from "~/ui/components/shell/ToolPanel";
import { SetupTab } from "~/ui/components/processes/SetupTab";
import { useToggleRunAction } from "~/ui/components/processes/useScripts";
import { ReviewDialogs } from "~/ui/components/review/ReviewDialogs";
import { RightPanel } from "~/ui/components/review/RightPanel";
import { CenteredLoading, NotFoundState } from "~/ui/components/shell/States";
import { TopBar } from "~/ui/components/topbar/TopBar";
import { Button } from "~/ui/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "~/ui/components/ui/resizable";
import { useAction } from "~/ui/hooks/useActions";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { useWorkspaceLifecycle, useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useLayout, useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { safeLayoutStorage } from "~/ui/lib/storage";
import {
  cycleTab,
  focusComposer,
  isRightOpen,
  openDiff,
  openDialog,
  setLayout,
  setPhonePane,
  setRightQuiet,
  toggleDiffScope,
} from "~/ui/state/workspace-ui";

export function WorkspaceLayout({ workspaceId }: { workspaceId: string }) {
  const isPhone = useIsPhone();
  const status = useWorkspaceSelector(workspaceId, (s) => s.status);
  const ready = useWorkspaceSelector(workspaceId, (s) => s.ready);
  const summary = useHubWorkspace(workspaceId);
  useWorkspaceLifecycle(workspaceId);
  useToggleRunAction(workspaceId, !isPhone);
  useWorkspaceActions(workspaceId, summary?.projectId);
  useEffect(() => setLayout({ lastWorkspaceId: workspaceId }), [workspaceId]);

  if (status === "not_found") {
    return (
      <NotFoundState
        className="h-full"
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/">Go to workspaces</Link>
          </Button>
        }
      />
    );
  }

  if (!ready && !summary) return <CenteredLoading label="Loading workspace" />;

  return (
    <>
      {isPhone ? (
        <PhoneWorkspace workspaceId={workspaceId} />
      ) : (
        <DesktopWorkspace workspaceId={workspaceId} />
      )}
      <ReviewDialogs workspaceId={workspaceId} />
    </>
  );
}

function useWorkspaceActions(workspaceId: string, projectId: string | undefined) {
  useAction("nextTab", () => cycleTab(workspaceId, 1, true));
  useAction("prevTab", () => cycleTab(workspaceId, -1, true));
  useAction("diffTab", () => openDiff(workspaceId));
  useAction("toggleScope", () => toggleDiffScope(workspaceId));
  useAction("focusComposer", () => focusComposer(workspaceId));
  useAction("openFile", () => openDialog({ kind: "openFile", workspaceId }));
  useAction("searchFiles", () => openDialog({ kind: "searchFiles", workspaceId }));
  useAction("newWorkspace", () =>
    openDialog(projectId ? { kind: "newWorkspace", projectId } : { kind: "newWorkspace" }),
  );
}

function DesktopWorkspace({ workspaceId }: { workspaceId: string }) {
  const layout = useLayout();

  const quiet = useWorkspaceSelector(workspaceId, (s) => {
    const w = s.workspace;

    if (!w) return false;

    return (
      w.state === "sleeping" || (((s.changes ?? w.changes)?.files.length ?? 0) === 0 && w.prNumber === null)
    );
  });

  useEffect(() => setRightQuiet(workspaceId, quiet), [workspaceId, quiet]);
  const pinned = useWorkspaceUiSelector(workspaceId, (ui) => ui.rightPinned);
  const rightOpen = isRightOpen(layout, { rightQuiet: quiet, rightPinned: pinned });

  const horizontal = useDefaultLayout({
    id: "workspace",
    panelIds: rightOpen ? ["center", "right"] : ["center"],
    storage: safeLayoutStorage,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar workspaceId={workspaceId} variant="desktop" />
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup
          id="workspace"
          orientation="horizontal"
          defaultLayout={horizontal.defaultLayout}
          onLayoutChanged={horizontal.onLayoutChanged}
        >
          <ResizablePanel id="center" minSize={320}>
            <section aria-label="Chat" className="flex h-full min-h-0 flex-col">
              <WorkspaceBanners workspaceId={workspaceId} />
              <div className="min-h-0 flex-1">
                <ChatTabs workspaceId={workspaceId} variant="desktop" />
              </div>
            </section>
          </ResizablePanel>
          {rightOpen && (
            <>
              <ResizableHandle aria-label="Resize right side" />
              <ResizablePanel id="right" defaultSize="50%" minSize={280}>
                <RightSide workspaceId={workspaceId} />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function RightSide({ workspaceId }: { workspaceId: string }) {
  return <ToolPanel workspaceId={workspaceId} />;
}

function PhoneWorkspace({ workspaceId }: { workspaceId: string }) {
  const { phonePane } = useLayout();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar workspaceId={workspaceId} variant="phone" />
      {Match.value(phonePane).pipe(
        Match.when("changes", () => (
          <section aria-label="Changes" className="flex min-h-0 flex-1 flex-col">
            <RightPanel workspaceId={workspaceId} variant="phone" />
          </section>
        )),
        Match.when("setup", () => (
          <section aria-label="Setup" className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center border-b px-2 py-1">
              <Button size="sm" variant="ghost" onClick={() => setPhonePane("chat")}>
                <ChevronLeftIcon aria-hidden />
                Back to chat
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <SetupTab workspaceId={workspaceId} />
            </div>
          </section>
        )),
        Match.orElse(() => (
          <section aria-label="Chat" className="flex min-h-0 flex-1 flex-col">
            <WorkspaceBanners workspaceId={workspaceId} />
            <div className="min-h-0 flex-1">
              <ChatTabs workspaceId={workspaceId} variant="phone" />
            </div>
          </section>
        )),
      )}
    </div>
  );
}
