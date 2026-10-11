import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "~/ui/lib/utils";

/** 04, Design: file lists use TanStack Virtual once they pass 200 rows. */
export const VIRTUALIZE_AFTER = 200;

export interface ListBoxProps<T> {
  readonly items: ReadonlyArray<T>;
  readonly getKey: (item: T) => string;
  readonly renderItem: (item: T, active: boolean) => ReactNode;
  /** Enter, or a click. */
  readonly onActivate: (item: T, index: number) => void;
  /** Extra keys for a row (tree folders use ← and →). Return true when handled. */
  readonly onItemKey?: (
    e: KeyboardEvent<HTMLDivElement>,
    item: T,
    index: number,
    moveTo: (index: number) => void,
  ) => boolean;
  readonly label: string;
  readonly role?: "listbox" | "tree";
  readonly rowHeight: number;
  /** Rows this item's ARIA needs (aria-level, aria-expanded). */
  readonly itemAria?: (item: T) => Record<string, string | number | boolean | undefined>;
  /** Moves the active row here when it changes (for example the file just opened). */
  readonly activeKey?: string | null;
  readonly className?: string;
}

/**
 * One tab stop with ↑ ↓ Home End PageUp PageDown and Enter, using aria-activedescendant so
 * virtualized rows never take DOM focus. The active row shows a ring while the list has keyboard focus.
 */
export function ListBox<T>({
  items,
  getKey,
  renderItem,
  onActivate,
  onItemKey,
  label,
  role = "listbox",
  rowHeight,
  itemAria,
  activeKey,
  className,
}: ListBoxProps<T>) {
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const found = activeItem === null ? -1 : keys.indexOf(activeItem);
  const index = found >= 0 ? found : 0;
  const setActive = (i: number) => setActiveItem(keys[i] ?? null);
  const virtual = items.length > VIRTUALIZE_AFTER;

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    enabled: virtual,
    getItemKey: (i) => keys[i] ?? i,
  });

  useEffect(() => {
    if (activeKey != null) setActiveItem(activeKey);
  }, [activeKey]);

  const reveal = (i: number) => {
    if (virtual) virtualizer.scrollToIndex(i, { align: "auto" });
    else document.getElementById(`${id}-${i}`)?.scrollIntoView({ block: "nearest" });
  };

  const move = (i: number) => {
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(items.length - 1, i));
    setActive(next);
    reveal(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey || items.length === 0) return;
    const item = items[index];
    if (item !== undefined && onItemKey?.(e, item, index, move)) {
      e.preventDefault();
      return;
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight * 10) / rowHeight) - 1);
    switch (e.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(items.length - 1);
        break;
      case "PageDown":
        move(index + page);
        break;
      case "PageUp":
        move(index - page);
        break;
      case "Enter":
        if (item !== undefined) onActivate(item, index);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const row = (item: T, i: number, style?: CSSProperties) => {
    const isActive = i === index;
    return (
      <div
        key={keys[i]}
        id={`${id}-${i}`}
        role={role === "tree" ? "treeitem" : "option"}
        aria-selected={isActive}
        {...itemAria?.(item)}
        style={style ?? { height: rowHeight }}
        onClick={() => {
          setActive(i);
          onActivate(item, i);
        }}
        className={cn(
          "flex cursor-default items-center rounded-sm px-2 text-sm select-none hover:bg-accent/60",
          isActive &&
            "group-focus-visible/list:bg-accent group-focus-visible/list:ring-2 group-focus-visible/list:ring-ring/50 group-focus-visible/list:ring-inset",
        )}
      >
        {renderItem(item, isActive)}
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      role={role}
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={items.length > 0 ? `${id}-${index}` : undefined}
      onKeyDown={onKeyDown}
      className={cn("group/list min-h-0 overflow-auto p-1 outline-none", className)}
    >
      {virtual ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = items[v.index];
            if (item === undefined) return null;
            return row(item, v.index, {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: rowHeight,
              transform: `translateY(${v.start}px)`,
            });
          })}
        </div>
      ) : (
        items.map((item, i) => row(item, i))
      )}
    </div>
  );
}
