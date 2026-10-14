import type { Turn } from "@tempo/protocol";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { LoadingText } from "~/ui/components/ui/spinner";
import { useWorkspace } from "~/ui/hooks/useWorkspace";
import { cn } from "~/ui/lib/utils";
import { useTranscriptDetail } from "~/ui/lib/transcript-detail";
import { ItemView, TurnFooter, WorkingRow, WorkRow, type ItemContext } from "./TranscriptItems";
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

const positions = new Map<string, { top: number; following: boolean; measurements: VirtualItem[] }>();

const rememberPosition = (key: string, position: NonNullable<ReturnType<typeof positions.get>>) => {
  positions.delete(key);
  positions.set(key, position);

  if (positions.size > 100) positions.delete(positions.keys().next().value!);
};

/** The session's items (04, Transcript), virtualized past 200 rows. */
export function Transcript({ workspaceId, sessionId }: TranscriptProps) {
  const ws = useWorkspace(workspaceId);
  const order = ws.order[sessionId] ?? EMPTY;
  const session = ws.sessions[sessionId];
  const detail = useTranscriptDetail();

  const rows = useMemo(
    () => buildTranscriptRows(order, ws.items, ws.turns, detail),
    [order, ws.items, ws.turns, detail],
  );

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
  const scrollIdle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => () => clearTimeout(scrollIdle.current), []);
  const contentRef = useRef<HTMLDivElement>(null);
  const positionKey = `${workspaceId}:${sessionId}`;
  const initialPosition = useRef(positions.get(positionKey));
  const restored = useRef(false);
  const stick = useRef(initialPosition.current?.following ?? true);
  const [away, setAway] = useState(!stick.current);
  const measurements = useRef<VirtualItem[]>([]);
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
    initialOffset: initialPosition.current?.top ?? 0,
    initialMeasurementsCache: initialPosition.current?.measurements ?? [],
  });

  const toBottom = useCallback(() => {
    const el = scrollRef.current;

    if (el) {
      el.scrollTop = el.scrollHeight;
      rememberPosition(positionKey, {
        top: el.scrollTop,
        following: true,
        measurements: measurements.current,
      });
    }
  }, [positionKey]);

  const onScroll = () => {
    const el = scrollRef.current;

    if (!el) return;
    setScrolling(true);
    clearTimeout(scrollIdle.current);
    scrollIdle.current = setTimeout(() => setScrolling(false), 1000);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = atBottom;
    setAway(!atBottom);
    rememberPosition(positionKey, {
      top: el.scrollTop,
      following: atBottom,
      measurements: virtual ? virtualizer.takeSnapshot() : [],
    });
  };

  useLayoutEffect(() => {
    measurements.current = virtual ? virtualizer.takeSnapshot() : [];

    if (!restored.current && scrollRef.current) {
      restored.current = true;

      if (initialPosition.current && !stick.current)
        scrollRef.current.scrollTop = initialPosition.current.top;
    }

    if (stick.current) toBottom();
  }, [rows, ws.items, toBottom, virtual, virtualizer]);
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
          <span key={announcement.key}>{announcement.text}</span>
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
        onWheel={(e) => {
          if (e.deltaY < 0) {
            stick.current = false;
            setAway(true);
          }
        }}
        tabIndex={0}
        aria-label="Transcript"
        data-scrolling={scrolling || undefined}
        className="chat-scrollbar h-full overflow-y-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <div className="mx-auto w-full min-w-0 max-w-[51.25rem] px-[var(--chat-gutter,12px)] py-3">
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
          className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-background shadow-md hover:bg-accent dark:bg-background dark:hover:bg-accent"
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
        <span key={announcement.key}>{announcement.text}</span>
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
        <TurnFooter turn={turn} worked={row.worked} />
      </div>
    ) : null;
  }

  if (row.kind === "work") {
    const turn = turns[row.turnId];
    const folded = row.itemIds.map((id) => items[id]).filter((i) => i !== undefined);

    return turn ? (
      <div className={cn("py-1.5", row.dim && "opacity-50")}>
        <WorkRow ctx={ctx} turn={turn} items={folded} />
      </div>
    ) : null;
  }

  const item = items[row.itemId];

  if (!item) return null;

  return (
    <div className={cn("py-1.5", row.dim && "opacity-50")}>
      <ItemView
        ctx={ctx}
        item={item}
        turn={row.turnId ? turns[row.turnId] : undefined}
        permission={row.permissionId ? items[row.permissionId] : undefined}
      />
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
): { key: string; text: string } {
  const seen = useRef<Set<string> | null>(null);
  const initialized = useRef(false);
  const [text, setText] = useState({ key: "", text: "" });
  useEffect(() => {
    if (!backlogDone || !initialized.current) {
      seen.current ??= new Set();
      messagesToAnnounce(seen.current, order, items);
      initialized.current = backlogDone;

      return;
    }

    const ids = messagesToAnnounce(seen.current!, order, items);

    if (ids.length > 0)
      setText({
        key: ids.join(":"),
        text: ids
          .map((id) => {
            const item = items[id];

            return item?.kind === "agent_message" ? announceText(item.content.text) : "";
          })
          .join(" "),
      });
  }, [order, items, backlogDone]);

  return text;
}
