import type { Turn } from "@tempo/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { LoadingText } from "~/ui/components/ui/spinner";
import { useWorkspace } from "~/ui/hooks/useWorkspace";
import { cn } from "~/ui/lib/utils";
import { ItemView, TurnFooter, WorkingRow, type ItemContext } from "./TranscriptItems";
import {
  announceText,
  buildTranscriptRows,
  messagesToAnnounce,
  VIRTUALIZE_AFTER,
  type TranscriptRow,
} from "./transcript-model";

export interface TranscriptProps {
  readonly workspaceId: string;
  readonly sessionId: string;
}

const EMPTY: ReadonlyArray<string> = [];

/** Distance from the bottom, in px, that still counts as following new output. */
const STICK_PX = 48;

/** The session's items (04, Transcript), virtualized past 200 rows. */
export function Transcript({ workspaceId, sessionId }: TranscriptProps) {
  const ws = useWorkspace(workspaceId);
  const order = ws.order[sessionId] ?? EMPTY;
  const session = ws.sessions[sessionId];
  const rows = useMemo(() => buildTranscriptRows(order, ws.items, ws.turns), [order, ws.items, ws.turns]);
  const archived = ws.workspace?.state === "archived" || ws.workspace?.state === "archiving";
  const idle = ws.workspace ? ws.workspace.runningTurnId === null && ws.workspace.queue.length === 0 : false;
  const ctx = useMemo<ItemContext>(
    () => ({
      workspaceId,
      sessionId,
      agent: session?.agent,
      writable: !archived && session?.status !== "closed",
      canRevert: idle,
    }),
    [workspaceId, sessionId, session?.agent, session?.status, archived, idle],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const virtual = rows.length > VIRTUALIZE_AFTER;
  const empty = rows.length === 0;

  // The virtualizer's functions change identity; nothing memoized receives them.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
    enabled: virtual,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = atBottom;
    setAway(!atBottom);
  };

  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [rows, ws.items, toBottom]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [virtual, empty, toBottom]);

  const announcement = useAnnouncement(order, ws.items, ws.backlogDone);

  if (empty) {
    return (
      <div className="flex h-full items-center justify-center">
        {!ws.backlogDone ? (
          <SkeletonRows className="w-full max-w-2xl" rows={4} />
        ) : session?.status === "starting" ? (
          <LoadingText label="Starting the agent" />
        ) : (
          <EmptyState title="Send a message to start." />
        )}
        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </div>
    );
  }

  const renderRow = (row: TranscriptRow) => (
    <Row key={row.key} row={row} ctx={ctx} items={ws.items} turns={ws.turns} />
  );

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Transcript"
        className="h-full overflow-y-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <div className="mx-auto w-full max-w-3xl px-3 py-3">
          {virtual ? (
            <div ref={contentRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => {
                const row = rows[v.index];
                if (!row) return null;
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    {renderRow(row)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div ref={contentRef} className="flex flex-col">
              {rows.map(renderRow)}
            </div>
          )}
        </div>
      </div>
      {away && (
        <Button
          size="sm"
          variant="outline"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow-sm"
          onClick={() => {
            stick.current = true;
            setAway(false);
            if (virtual) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
            toBottom();
          }}
        >
          <ArrowDownIcon />
          Jump to latest
        </Button>
      )}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}

function Row({
  row,
  ctx,
  items,
  turns,
}: {
  row: TranscriptRow;
  ctx: ItemContext;
  items: TranscriptItemsMap;
  turns: Readonly<Record<string, Turn>>;
}) {
  if (row.kind === "working") {
    const turn = turns[row.turnId];
    return turn ? (
      <div className="py-1.5">
        <WorkingRow turn={turn} />
      </div>
    ) : null;
  }
  if (row.kind === "footer") {
    const turn = turns[row.turnId];
    return turn ? (
      <div className={cn("pb-3", row.dim && "opacity-50")}>
        <TurnFooter turn={turn} />
      </div>
    ) : null;
  }
  const item = items[row.itemId];
  if (!item) return null;
  return (
    <div className={cn("py-1.5", row.dim && "opacity-50")}>
      <ItemView ctx={ctx} item={item} turn={row.turnId ? turns[row.turnId] : undefined} />
    </div>
  );
}

type TranscriptItemsMap = ReturnType<typeof useWorkspace>["items"];

/**
 * 04, Accessibility: each new agent message is announced once, when it finishes, not per delta.
 * Messages already there when the transcript opens are not announced.
 */
function useAnnouncement(
  order: ReadonlyArray<string>,
  items: TranscriptItemsMap,
  backlogDone: boolean,
): string {
  const seen = useRef<Set<string> | null>(null);
  const initialized = useRef(false);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!backlogDone || !initialized.current) {
      seen.current ??= new Set();
      messagesToAnnounce(seen.current, order, items);
      initialized.current = backlogDone;
      return;
    }
    const ids = messagesToAnnounce(seen.current!, order, items);
    const last = ids[ids.length - 1];
    const item = last ? items[last] : undefined;
    if (item?.kind === "agent_message") setText(announceText(item.content.text));
  }, [order, items, backlogDone]);
  return text;
}
