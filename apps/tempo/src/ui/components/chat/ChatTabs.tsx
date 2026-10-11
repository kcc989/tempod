import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
import { CenterTabPart, CENTER_TAB_KINDS } from "~/ui/components/chat/tab-kinds";
import { EmptyState } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { useAction } from "~/ui/hooks/useActions";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useWorkspace } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUi } from "~/ui/hooks/useWorkspaceUi";
import { cn } from "~/ui/lib/utils";
import { activateTab, closeTab, openTab, syncChatTabs } from "~/ui/state/workspace-ui";

export interface ChatTabsProps {
  readonly workspaceId: string;
  /** `phone`: one chat at a time with a menu at the top to switch (04, Phone width). */
  readonly variant?: "desktop" | "phone";
}

/** REGION B placeholder: the center tab host (chat, file, diff and browser tabs). */
export function ChatTabs({ workspaceId }: ChatTabsProps) {
  const ws = useWorkspace(workspaceId);
  const ui = useWorkspaceUi(workspaceId);
  const openSessionIds = useMemo(
    () =>
      Object.values(ws.sessions)
        .filter((s) => s.status !== "closed")
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((s) => s.id),
    [ws.sessions],
  );
  useEffect(() => {
    if (ws.ready) syncChatTabs(workspaceId, openSessionIds);
  }, [ws.ready, workspaceId, openSessionIds]);

  const createSession = useCallMutation("createSession", {
    onSuccess: (session) => openTab(workspaceId, { kind: "chat", sessionId: session.id }),
  });
  const agent = ws.workspace?.defaultAgent ?? "claude";
  const newChat = () => createSession.mutate({ workspaceId, agent });
  useAction("newChat", newChat, { enabled: ws.ready });
  useAction("closeTab", () => {
    if (ui.activeKey && !ui.activeKey.startsWith("chat:")) closeTab(workspaceId, ui.activeKey);
  });

  const active = ui.tabs.find((t) => t.key === ui.activeKey);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Center tabs" className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1">
        {ui.tabs.map((t) => {
          const Icon = CENTER_TAB_KINDS[t.tab.kind].icon;
          const selected = t.key === ui.activeKey;
          return (
            <div key={t.key} className={cn("flex items-center rounded-md", selected && "bg-accent")}>
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => activateTab(workspaceId, t.key)}
                className="flex h-7 max-w-48 items-center gap-1.5 truncate px-2 text-sm"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  <CenterTabPart part="Title" workspaceId={workspaceId} tab={t.tab} active={selected} seq={t.seq} />
                </span>
              </button>
              {t.tab.kind !== "chat" && (
                <Button size="icon-sm" variant="ghost" aria-label="Close tab" onClick={() => closeTab(workspaceId, t.key)}>
                  <XIcon />
                </Button>
              )}
            </div>
          );
        })}
        <Button size="icon-sm" variant="ghost" aria-label="New chat" onClick={newChat} disabled={!ws.ready}>
          <PlusIcon />
        </Button>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {active ? (
          <CenterTabPart part="Body" workspaceId={workspaceId} tab={active.tab} active seq={active.seq} />
        ) : (
          <EmptyState
            className="h-full"
            title="No chats yet."
            action={
              <Button size="sm" onClick={newChat} disabled={!ws.ready}>
                New chat
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
