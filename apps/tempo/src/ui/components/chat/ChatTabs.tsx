import { ChevronDownIcon, HistoryIcon, PlusIcon, ShieldQuestionIcon, XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CENTER_TAB_KINDS, CenterTabPart } from "~/ui/components/chat/tab-kinds";
import { EmptyState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "~/ui/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/components/ui/dropdown-menu";
import { Spinner } from "~/ui/components/ui/spinner";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useAction } from "~/ui/hooks/useActions";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useWorkspaceSelector, useWorkspaceStore } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUi } from "~/ui/hooks/useWorkspaceUi";
import { call } from "~/ui/lib/api";
import { agentLabel } from "~/ui/lib/agents";
import { formatBinding } from "~/ui/lib/shortcuts";
import { errorCode, toastError } from "~/ui/lib/toast";
import { cn } from "~/ui/lib/utils";
import {
  activateTab,
  CONFIRM_TEXT,
  closeTab,
  confirm,
  getWorkspaceUi,
  openTab,
  syncChatTabs,
  type OpenTab,
} from "~/ui/state/workspace-ui";
import {
  chatTabIds,
  closedSessions,
  nextTabIndex,
  openSessionIds,
  runningTurnOf,
  sessionTitle,
  waitUntil,
} from "./chat-tabs-model";
import { NewChatComposer } from "./NewChatComposer";
import { toggleExpandAll } from "./expand-store";

export interface ChatTabsProps {
  readonly workspaceId: string;
  /** `phone`: one chat at a time with a menu at the top to switch (04, Phone width). */
  readonly variant?: "desktop" | "phone";
}

/** How long to wait for a cancelled turn to end before closing its chat. */
const CANCEL_WAIT_MS = 30_000;

/** The center tab host: chat, file, diff and browser tabs (04, Center: chat tabs and composer). */
export function ChatTabs({ workspaceId, variant = "desktop" }: ChatTabsProps) {
  const store = useWorkspaceStore(workspaceId);
  const ready = useWorkspaceSelector(workspaceId, (s) => s.ready);
  const sessions = useWorkspaceSelector(workspaceId, (s) => s.sessions);
  const state = useWorkspaceSelector(workspaceId, (s) => s.workspace?.state);
  const ui = useWorkspaceUi(workspaceId);
  const [viewingClosed, setViewingClosed] = useState<ReadonlyArray<string>>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const activateWhenShown = useRef<string | null>(null);
  const baseId = useId();
  const archived = state === "archived" || state === "archiving";

  const openIds = useMemo(() => openSessionIds(sessions), [sessions]);
  const tabIds = chatTabIds(openIds, viewingClosed, sessions).join("\n");
  useEffect(() => {
    if (!ready) return;
    const ids = tabIds === "" ? [] : tabIds.split("\n");
    syncChatTabs(workspaceId, ids);
    const pending = activateWhenShown.current;
    if (pending && ids.includes(pending)) {
      activateWhenShown.current = null;
      activateTab(workspaceId, `chat:${pending}`);
    }
  }, [ready, workspaceId, tabIds]);

  const renameSession = useCallMutation("renameSession");

  const closeChat = async (sessionId: string) => {
    const key = `chat:${sessionId}`;
    const session = store.getSnapshot().sessions[sessionId];
    if (!session || session.status === "closed") {
      setViewingClosed((v) => v.filter((id) => id !== sessionId));
      closeTab(workspaceId, key);
      return;
    }
    const running = runningTurnOf(store.getSnapshot().turns, sessionId);
    if (running) {
      if (!(await confirm(CONFIRM_TEXT.closeRunningChat()))) return;
      try {
        await call("cancelTurn", { workspaceId, turnId: running.id });
      } catch (e) {
        if (errorCode(e) !== "TURN_NOT_ACTIVE") {
          toastError(e);
          return;
        }
      }
      await waitUntil(
        store.subscribe,
        () => store.getSnapshot().turns[running.id]?.status !== "running",
        CANCEL_WAIT_MS,
      );
    }
    try {
      await call("closeSession", { workspaceId, sessionId });
    } catch (e) {
      toastError(e);
      return;
    }
    closeTab(workspaceId, key);
  };

  const close = (t: OpenTab) => {
    if (t.tab.kind === "chat") void closeChat(t.tab.sessionId);
    else closeTab(workspaceId, t.key);
  };

  const openClosed = (sessionId: string) => {
    setViewingClosed((v) => (v.includes(sessionId) ? v : [...v, sessionId]));
    openTab(workspaceId, { kind: "chat", sessionId });
  };

  const rename = (sessionId: string, title: string) => {
    setRenaming(null);
    const cur = store.getSnapshot().sessions[sessionId]?.title ?? "";
    if (title.trim() !== cur.trim()) renameSession.mutate({ workspaceId, sessionId, title: title.trim() });
  };

  const active = ui.tabs.find((t) => t.key === ui.activeKey);
  useAction("newChat", () => setMenuOpen(true), { enabled: ready && !archived });
  useAction(
    "closeTab",
    () => {
      const s = getWorkspaceUi(workspaceId);
      const t = s.tabs.find((x) => x.key === s.activeKey);
      if (t) close(t);
    },
    { enabled: active !== undefined },
  );
  useAction(
    "expandAll",
    () => {
      if (active?.tab.kind === "chat") toggleExpandAll(active.tab.sessionId);
    },
    { enabled: active?.tab.kind === "chat" },
  );

  const closed = useMemo(() => closedSessions(sessions), [sessions]);

  const newChatMenu = (
    <>
      <SimpleTooltip label={`New chat (${formatBinding("newChat")})`}>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="New chat"
          disabled={!ready || archived}
          onClick={() => setMenuOpen(true)}
        >
          <PlusIcon />
        </Button>
      </SimpleTooltip>
      {menuOpen && (
        <NewChatComposer
          workspaceId={workspaceId}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onCreated={(session) => {
            activateWhenShown.current = session.id;
            openTab(workspaceId, { kind: "chat", sessionId: session.id });
          }}
        />
      )}
    </>
  );
  const closedMenu =
    closed.length > 0 ? (
      <DropdownMenu>
        <SimpleTooltip label="Closed chats">
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Closed chats">
              <HistoryIcon />
            </Button>
          </DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent align="end" className="max-h-80 min-w-52">
          <DropdownMenuLabel>Closed chats</DropdownMenuLabel>
          {closed.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => openClosed(s.id)}>
              <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
              <span className="text-xs text-muted-foreground">{agentLabel(s.agent)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  const body = !ready ? (
    <SkeletonRows rows={5} className="mx-auto w-full max-w-3xl p-4" />
  ) : active ? (
    <CenterTabPart
      key={active.key}
      part="Body"
      workspaceId={workspaceId}
      tab={active.tab}
      active
      seq={active.seq}
    />
  ) : (
    <EmptyState
      className="h-full"
      title="No chats yet."
      action={
        <Button size="sm" onClick={() => setMenuOpen(true)} disabled={archived}>
          New chat
        </Button>
      }
    />
  );

  if (variant === "phone") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="min-w-0 flex-1 justify-start"
                aria-label="Switch tab"
              >
                <span className="truncate">
                  {active ? (
                    <CenterTabPart
                      part="Title"
                      workspaceId={workspaceId}
                      tab={active.tab}
                      active
                      seq={active.seq}
                    />
                  ) : (
                    "No chats"
                  )}
                </span>
                <ChevronDownIcon className="ml-auto" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 min-w-56">
              {ui.tabs.map((t) => (
                <DropdownMenuItem key={t.key} onSelect={() => activateTab(workspaceId, t.key)}>
                  <TabIcon workspaceId={workspaceId} tab={t} />
                  <span className="min-w-0 flex-1 truncate">
                    <CenterTabPart
                      part="Title"
                      workspaceId={workspaceId}
                      tab={t.tab}
                      active={false}
                      seq={t.seq}
                    />
                  </span>
                </DropdownMenuItem>
              ))}
              {active && ui.tabs.length > 0 && <DropdownMenuSeparator />}
              {active && <DropdownMenuItem onSelect={() => close(active)}>Close this tab</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
          {newChatMenu}
          {closedMenu}
        </div>
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    );
  }

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number, t: OpenTab) => {
    if (e.key === "F2" && t.tab.kind === "chat" && sessions[t.tab.sessionId]?.status !== "closed") {
      e.preventDefault();
      setRenaming(t.tab.sessionId);
      return;
    }
    const next = nextTabIndex(e.key, index, ui.tabs.length);
    if (next === null) return;
    e.preventDefault();
    const target = ui.tabs[next];
    if (!target) return;
    activateTab(workspaceId, target.key);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1">
        <div
          role="tablist"
          aria-label="Center tabs"
          className="flex h-full min-w-0 items-center gap-0.5 overflow-x-auto px-1"
        >
          {ui.tabs.map((t, i) => {
            const selected = t.key === ui.activeKey;
            const sessionId = t.tab.kind === "chat" ? t.tab.sessionId : null;
            const isClosed = sessionId !== null && sessions[sessionId]?.status === "closed";
            const canRename = sessionId !== null && !isClosed && !archived;
            return (
              <ContextMenu key={t.key}>
                <ContextMenuTrigger asChild>
                  <div
                    className={cn(
                      "group/tab flex h-7 shrink-0 items-center rounded-md",
                      selected
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50",
                    )}
                  >
                    {renaming !== null && renaming === sessionId ? (
                      <RenameInput
                        initial={sessions[sessionId]?.title ?? ""}
                        onDone={(title) => (title === null ? setRenaming(null) : rename(sessionId, title))}
                      />
                    ) : (
                      <button
                        type="button"
                        role="tab"
                        id={`${baseId}-tab-${i}`}
                        aria-selected={selected}
                        aria-controls={`${baseId}-panel`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => activateTab(workspaceId, t.key)}
                        onDoubleClick={() => canRename && setRenaming(sessionId)}
                        onAuxClick={(e) => {
                          if (e.button === 1) close(t);
                        }}
                        onKeyDown={(e) => onTabKey(e, i, t)}
                        className="flex h-7 max-w-52 items-center gap-1.5 rounded-md pr-1 pl-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <TabIcon workspaceId={workspaceId} tab={t} />
                        <span className={cn("truncate", isClosed && "italic")}>
                          <CenterTabPart
                            part="Title"
                            workspaceId={workspaceId}
                            tab={t.tab}
                            active={selected}
                            seq={t.seq}
                          />
                        </span>
                      </button>
                    )}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      tabIndex={selected ? 0 : -1}
                      aria-label="Close tab"
                      className={cn(
                        "mr-0.5 size-5",
                        !selected && "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
                      )}
                      onClick={() => close(t)}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {canRename && (
                    <ContextMenuItem onSelect={() => setRenaming(sessionId)}>Rename</ContextMenuItem>
                  )}
                  <ContextMenuItem onSelect={() => close(t)}>
                    Close
                    <span className="ml-auto pl-4 text-xs text-muted-foreground">
                      {formatBinding("closeTab")}
                    </span>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        {newChatMenu}
        <div className="ml-auto flex items-center">{closedMenu}</div>
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={active ? `${baseId}-tab-${ui.tabs.indexOf(active)}` : undefined}
        className="min-h-0 flex-1"
      >
        {body}
      </div>
    </div>
  );
}

/** The kind icon, or for a chat: a spinner while its turn runs, a question mark while it waits for you. */
function TabIcon({ workspaceId, tab }: { workspaceId: string; tab: OpenTab }) {
  const sessionId = tab.tab.kind === "chat" ? tab.tab.sessionId : null;
  const status = useWorkspaceSelector(workspaceId, (s) => {
    if (sessionId === null) return null;
    if (Object.values(s.permissions).some((p) => p.sessionId === sessionId)) return "needs_input";
    if (Object.values(s.turns).some((t) => t.sessionId === sessionId && t.status === "running"))
      return "running";
    return s.sessions[sessionId]?.status === "starting" ? "running" : null;
  });
  if (status === "needs_input")
    return <ShieldQuestionIcon aria-label="Waiting for you" className="size-3.5 shrink-0 text-warning" />;
  if (status === "running") return <Spinner aria-label="Working" className="text-primary" />;
  const Icon = CENTER_TAB_KINDS[tab.tab.kind].icon;
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      autoFocus
      aria-label="Chat name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      className="h-6 w-40 rounded-sm border border-input bg-background px-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    />
  );
}
