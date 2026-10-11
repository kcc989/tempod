import { useDeferredValue, useLayoutEffect, useMemo, useRef } from "react";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { stripAnsi } from "~/ui/lib/format";
import { cn } from "~/ui/lib/utils";

/** Pixels from the bottom that still count as "following" the output. */
const FOLLOW_SLACK = 24;

/**
 * One run's output as plain monospace text. It follows new output while scrolled to the bottom,
 * and stays put once the user scrolls up.
 */
export function ScriptOutput({
  workspaceId,
  runId,
  label,
  empty,
  className,
}: {
  workspaceId: string;
  runId: string;
  label: string;
  empty: string;
  className?: string;
}) {
  const raw = useWorkspaceSelector(workspaceId, (s) => s.scriptOutput[runId] ?? "");
  const deferred = useDeferredValue(raw);
  const text = useMemo(() => stripAnsi(deferred), [deferred]);
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      role="log"
      aria-label={label}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
      }}
      className={cn(
        "min-h-0 flex-1 overflow-auto bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap focus-visible:outline-2 focus-visible:-outline-offset-2",
        className,
      )}
    >
      {text === "" ? <span className="text-muted-foreground">{empty}</span> : text}
    </pre>
  );
}
