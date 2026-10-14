import { Schema } from "effect";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { sessionQueryOptions } from "~/ui/auth";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SettingsPage } from "~/ui/components/settings/SettingsPage";
import { DialogHost } from "~/ui/components/shell/DialogHost";
import { GlobalChrome } from "~/ui/components/shell/GlobalChrome";
import { PhoneNav } from "~/ui/components/shell/PhoneNav";
import { ReconnectingBar } from "~/ui/components/shell/ReconnectingBar";
import { AppHeader } from "~/ui/components/shell/AppHeader";
import { Sidebar } from "~/ui/components/sidebar/Sidebar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "~/ui/components/ui/resizable";
import { useAction } from "~/ui/hooks/useActions";
import { useGlobalShortcuts } from "~/ui/hooks/useGlobalShortcuts";
import { useHubConnection } from "~/ui/hooks/useHub";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { useReconnectRules } from "~/ui/hooks/useReconnectRules";
import { useLayout, useSettings } from "~/ui/hooks/useWorkspaceUi";
import { readJson, writeJson } from "~/ui/lib/storage";
import { errorCode, onUnauthenticated, toastError } from "~/ui/lib/toast";
import {
  closeDialog,
  dialogStore,
  openDialog,
  toggleBottom,
  toggleRight,
  toggleSidebar,
} from "~/ui/state/workspace-ui";

/** 04, Sidebar: 280 px by default, resizable from 220 to 400 px. */
export const SIDEBAR_WIDTH = { default: 280, min: 220, max: 400 } as const;

const SIDEBAR_KEY = "layout:sidebar-width";

const clampWidth = (n: number) => Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(n)));

const readSidebarWidth = (): number =>
  clampWidth(
    readJson<number>(
      SIDEBAR_KEY,
      SIDEBAR_WIDTH.default,
      (u): u is number => Schema.is(Schema.Number)(u) && Number.isFinite(u),
    ),
  );

/**
 * The signed-in frame: sidebar | main on wide screens, one pane plus bottom navigation on phones.
 * It owns the hub socket, reconnect rules, global shortcuts and the dialog host.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const isPhone = useIsPhone();
  const settings = useSettings();
  const navigate = useNavigate();
  useHubConnection();
  useReconnectRules();
  useGlobalShortcuts();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onUnauthenticated(() => {
        queryClient.removeQueries({ queryKey: sessionQueryOptions.queryKey });
        void navigate({
          to: "/login",
          search: { redirect: `${window.location.pathname}${window.location.search}` },
        });
      }),
    [navigate, queryClient],
  );
  // Queries do not toast, but a lost session on any of them must still lead to sign-in.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error") return;

        if (errorCode(event.action.error) === "UNAUTHENTICATED") toastError(event.action.error);
      }),
    [queryClient],
  );

  const desktop = { enabled: !isPhone, fallback: true };
  useAction("toggleSidebar", toggleSidebar, desktop);
  useAction("toggleRight", toggleRight, desktop);
  useAction("toggleBottom", toggleBottom, desktop);
  useAction(
    "palette",
    () => {
      if (dialogStore.getSnapshot().dialog?.kind === "palette") closeDialog("palette");
      else openDialog({ kind: "palette" });
    },
    { fallback: true },
  );
  useAction("newWorkspace", () => openDialog({ kind: "newWorkspace" }), { fallback: true });
  useAction("settings", () => openDialog({ kind: "settings" }), { fallback: true });

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <ReconnectingBar />
      <div className={settings ? "hidden" : "flex min-h-0 flex-1 flex-col"} inert={settings !== null}>
        {isPhone ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
            <PhoneNav />
          </div>
        ) : (
          <DesktopFrame>{children}</DesktopFrame>
        )}
      </div>
      {settings && <SettingsPage />}
      <GlobalChrome />
      <DialogHost />
    </div>
  );
}

function DesktopFrame({ children }: { children: ReactNode }) {
  const { sidebarOpen } = useLayout();

  // Read again each time the sidebar opens, so it comes back at the width it was closed at.
  const initialWidth = useMemo(
    () => (sidebarOpen ? readSidebarWidth() : SIDEBAR_WIDTH.default),
    [sidebarOpen],
  );

  const width = useRef(initialWidth);
  const [headerSidebarWidth, setHeaderSidebarWidth] = useState(initialWidth);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const onSidebarResize = (size: { inPixels: number }) => {
    if (size.inPixels <= 0) return;
    const next = clampWidth(size.inPixels);

    if (next === width.current) return;
    width.current = next;
    setHeaderSidebarWidth(next);

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => writeJson(SIDEBAR_KEY, next), 250);
  };

  return (
    <div className="min-h-0 flex-1">
      <AppHeader sidebarWidth={sidebarOpen ? headerSidebarWidth : 40}>
        <ResizablePanelGroup id="shell" orientation="horizontal">
          {sidebarOpen && (
            <>
              <ResizablePanel
                id="sidebar"
                defaultSize={initialWidth}
                minSize={SIDEBAR_WIDTH.min}
                maxSize={SIDEBAR_WIDTH.max}
                groupResizeBehavior="preserve-pixel-size"
                onResize={onSidebarResize}
                className="bg-sidebar text-sidebar-foreground"
              >
                <aside aria-label="Workspaces" className="flex h-full min-h-0 flex-col">
                  <Sidebar variant="panel" />
                </aside>
              </ResizablePanel>
              <ResizableHandle aria-label="Resize sidebar" />
            </>
          )}
          <ResizablePanel id="main" minSize={360}>
            <main className="flex h-full min-h-0 min-w-0 flex-col">{children}</main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </AppHeader>
    </div>
  );
}
