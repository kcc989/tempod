import {
  Fragment,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { toSplitRows, type DiffLine, type ParsedDiff } from "~/ui/lib/diff";
import { cn } from "~/ui/lib/utils";
import { CommentForm, DraftCard } from "./CommentParts";
import {
  anchorKey,
  extendSelection,
  inRange,
  lineKeys,
  selectionRange,
  splitRefs,
  splitRowKeys,
  unifiedRef,
  type DiffView,
  type LineRange,
  type LineRef,
  type PlacedComments,
  type Selection,
} from "./diff-model";

const LINE_BG: Record<DiffLine["kind"], string> = {
  add: "bg-diff-add",
  del: "bg-diff-del",
  context: "",
};

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", context: " " };

export interface DiffLinesProps {
  readonly workspaceId: string;
  readonly path: string;
  readonly parsed: ParsedDiff;
  readonly view: DiffView;
  readonly placed: PlacedComments;
  /** The open line composer, if any (one per file). */
  readonly composer: LineRange | null;
  readonly setComposer: (range: LineRange | null) => void;
}

/**
 * The lines of one file. Click a line number to comment on it, drag across numbers (or Shift with
 * ↑ ↓) for a range. Line numbers are one tab stop per file; ↑ ↓ move between them, ← → switch sides
 * in split view.
 */
export function DiffLines({
  workspaceId,
  path,
  parsed,
  view,
  placed,
  composer,
  setComposer,
}: DiffLinesProps) {
  const [sel, setSel] = useState<Selection | null>(null);
  const [tabStop, setTabStop] = useState<string | null>(null);
  const dragging = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const onMouseUp = useEffectEvent(() => {
    if (!dragging.current) return;
    dragging.current = false;
    if (sel) setComposer(selectionRange(sel));
  });
  useEffect(() => {
    const up = () => onMouseUp();
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const range = sel ? selectionRange(sel) : composer;
  const keys = useMemo(() => gutterKeys(parsed, view), [parsed, view]);
  const stop = tabStop !== null && keys.has(tabStop) ? tabStop : (keys.values().next().value ?? null);

  const focusGutter = (key: string | null) => {
    if (!key) return;
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-key="${key}"]`)?.focus();
  };

  const closeComposer = (added: boolean) => {
    setComposer(null);
    setSel(null);
    if (!added) focusGutter(stop);
  };

  const gutterKey = (e: KeyboardEvent<HTMLButtonElement>, ref: LineRef) => {
    const el = e.currentTarget;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const all = [
        ...(rootRef.current?.querySelectorAll<HTMLButtonElement>(`[data-gutter="${ref.side}"]`) ?? []),
      ];
      const target = all[all.indexOf(el) + (e.key === "ArrowDown" ? 1 : -1)];
      e.preventDefault();
      if (!target) return;
      const next: LineRef = { side: ref.side, line: Number(target.dataset.line) };
      setSel(
        e.shiftKey
          ? extendSelection(sel ?? { side: ref.side, anchor: ref.line, focus: ref.line }, next)
          : null,
      );
      target.focus();
      return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && view === "split") {
      const other = el
        .closest("[data-row]")
        ?.querySelector<HTMLButtonElement>(`[data-gutter="${e.key === "ArrowLeft" ? "old" : "new"}"]`);
      if (other && other !== el) {
        e.preventDefault();
        other.focus();
      }
      return;
    }
    if (e.key === "Escape" && sel) {
      e.preventDefault();
      setSel(null);
    }
  };

  const gutter = (ref: LineRef | null, label: ReactNode, className?: string) => {
    if (!ref) return <span aria-hidden className={cn("shrink-0 select-none", className)} />;
    const key = anchorKey(ref.side, ref.line);
    const selected = inRange(range, ref);
    return (
      <button
        type="button"
        data-gutter={ref.side}
        data-line={ref.line}
        data-key={key}
        tabIndex={key === stop ? 0 : -1}
        aria-label={`Comment on ${ref.side === "old" ? "old" : "new"} line ${ref.line}`}
        aria-pressed={selected}
        onFocus={() => setTabStop(key)}
        onMouseDown={(e: MouseEvent<HTMLButtonElement>) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          dragging.current = true;
          setSel(
            e.shiftKey && sel
              ? extendSelection(sel, ref)
              : { side: ref.side, anchor: ref.line, focus: ref.line },
          );
        }}
        onMouseEnter={() => {
          if (dragging.current) setSel((s) => (s && s.side === ref.side ? { ...s, focus: ref.line } : s));
        }}
        onClick={(e) => {
          if (e.detail !== 0) return;
          const r = sel ? selectionRange(sel) : null;
          setComposer(r && inRange(r, ref) ? r : { side: ref.side, lineStart: ref.line, lineEnd: ref.line });
        }}
        onKeyDown={(e) => gutterKey(e, ref)}
        className={cn(
          "shrink-0 cursor-pointer px-1 text-right text-muted-foreground tabular-nums select-none hover:bg-primary/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-inset",
          selected && "bg-primary/20 text-foreground",
          className,
        )}
      >
        {label}
      </button>
    );
  };

  const extras = (keys: ReadonlyArray<string>) => {
    const cards: ReactNode[] = [];
    for (const k of keys) {
      for (const c of placed.byAnchor.get(k) ?? []) {
        cards.push(<DraftCard key={c.id} workspaceId={workspaceId} comment={c} />);
      }
    }
    if (composer && keys.includes(anchorKey(composer.side, composer.lineEnd))) {
      cards.push(
        <CommentForm
          key={`form:${composer.side}:${composer.lineStart}:${composer.lineEnd}`}
          workspaceId={workspaceId}
          path={path}
          range={composer}
          onDone={closeComposer}
        />,
      );
    }
    return cards.length > 0 ? <div className="py-0.5">{cards}</div> : null;
  };

  const hunkHeader = (header: string, i: number) => (
    <div key={`h:${i}`} className="sticky left-0 bg-muted/60 px-2 py-0.5 text-muted-foreground">
      {header}
    </div>
  );

  if (view === "split") {
    return (
      <div ref={rootRef} className="font-mono text-xs leading-5">
        {parsed.hunks.map((h, hi) => (
          <Fragment key={hi}>
            {hunkHeader(h.header, hi)}
            {toSplitRows(h).map((row, ri) => {
              const refs = splitRefs(row);
              const leftKind = row.left?.kind ?? null;
              const rightKind = row.right?.kind ?? null;
              return (
                <Fragment key={`${hi}:${ri}`}>
                  <div data-row className="grid grid-cols-2">
                    <div className={cn("flex min-w-0", leftKind ? LINE_BG[leftKind] : "bg-muted/30")}>
                      {gutter(refs.left, row.left?.oldLine, "w-12")}
                      <Code line={row.left} />
                    </div>
                    <div
                      className={cn("flex min-w-0 border-l", rightKind ? LINE_BG[rightKind] : "bg-muted/30")}
                    >
                      {gutter(refs.right, row.right?.newLine, "w-12")}
                      <Code line={row.right} />
                    </div>
                  </div>
                  {extras(splitRowKeys(row))}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="w-max min-w-full font-mono text-xs leading-5">
      {parsed.hunks.map((h, hi) => (
        <Fragment key={hi}>
          {hunkHeader(h.header, hi)}
          {h.lines.map((l, li) => (
            <Fragment key={`${hi}:${li}`}>
              <div data-row className={cn("flex", LINE_BG[l.kind])}>
                {gutter(
                  unifiedRef(l),
                  <span className="flex">
                    <span className="w-10">{l.oldLine ?? ""}</span>
                    <span className="w-10">{l.newLine ?? ""}</span>
                  </span>,
                  undefined,
                )}
                <span aria-hidden className="w-4 shrink-0 text-center text-muted-foreground select-none">
                  {SIGN[l.kind]}
                </span>
                <span className="pr-4 whitespace-pre">
                  {l.kind !== "context" && (
                    <span className="sr-only">{l.kind === "add" ? "Added: " : "Removed: "}</span>
                  )}
                  {l.text}
                </span>
              </div>
              {extras(lineKeys(l))}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function Code({ line }: { line: DiffLine | null }) {
  if (!line) return <span className="flex-1" />;
  return (
    <span className="min-w-0 flex-1 pr-2 break-all whitespace-pre-wrap">
      {line.kind !== "context" && (
        <span className="sr-only">{line.kind === "add" ? "Added: " : "Removed: "}</span>
      )}
      <span aria-hidden className="text-muted-foreground select-none">
        {SIGN[line.kind]}
      </span>
      {line.text}
    </span>
  );
}

/** Every line-number button of a file, in order. */
const gutterKeys = (parsed: ParsedDiff, view: DiffView): Set<string> => {
  const out = new Set<string>();
  for (const h of parsed.hunks) {
    if (view === "unified") {
      for (const l of h.lines) {
        const r = unifiedRef(l);
        if (r) out.add(anchorKey(r.side, r.line));
      }
    } else {
      for (const row of toSplitRows(h)) {
        const { left, right } = splitRefs(row);
        if (left) out.add(anchorKey(left.side, left.line));
        if (right) out.add(anchorKey(right.side, right.line));
      }
    }
  }
  return out;
};
