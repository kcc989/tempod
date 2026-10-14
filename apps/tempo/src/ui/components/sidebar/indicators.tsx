import type { OpProgress, WorkspaceSummary } from "@tempo/protocol";
import { CircleAlertIcon, CircleQuestionMarkIcon, LoaderCircleIcon, MoonIcon } from "lucide-react";
import { Badge } from "~/ui/components/ui/badge";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { statusIndicator, type Pill } from "~/ui/lib/indicators";
import { cn } from "~/ui/lib/utils";
import { CHECKS_DOT_CLASS, CHECKS_LABELS, PR_STATE_LABELS, prBadgeVariant } from "./sidebar-logic";

/** 04, Indicators: one icon per workspace; attention wins over state. */
export function StatusIcon({
  workspace,
  op,
  className,
}: {
  workspace: Pick<WorkspaceSummary, "attention" | "state">;
  op?: OpProgress | null;
  className?: string;
}) {
  const indicator = statusIndicator(workspace, op);
  const box = cn("flex size-3.5 shrink-0 items-center justify-center", className);

  if (!indicator) return <span aria-hidden className={box} />;

  const icon = (() => {
    switch (indicator.kind) {
      case "needs_input":
        return <CircleQuestionMarkIcon className="size-3.5 text-warning" />;
      case "error":
        return <CircleAlertIcon className="size-3.5 text-destructive" />;
      case "working":
        return <LoaderCircleIcon className="size-3.5 animate-spin text-primary" />;
      case "unread":
        return <span className="size-2 rounded-full bg-primary" />;
      case "busy":
        return <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />;
      case "sleeping":
        return <MoonIcon className="size-3.5 text-muted-foreground" />;
    }
  })();

  return (
    <SimpleTooltip label={indicator.tooltip}>
      <span role="img" aria-label={indicator.tooltip} className={box}>
        {icon}
      </span>
    </SimpleTooltip>
  );
}

/** `#<number>` coloured by pr_state. */
export function PrBadge({
  workspace: w,
  className,
}: {
  workspace: Pick<WorkspaceSummary, "prNumber" | "prState">;
  className?: string;
}) {
  if (w.prNumber === null) return null;
  const label = `PR #${w.prNumber}${w.prState ? `, ${PR_STATE_LABELS[w.prState].toLowerCase()}` : ""}`;

  return (
    <Badge variant={prBadgeVariant(w.prState)} aria-label={label} className={cn("tabular-nums", className)}>
      #{w.prNumber}
    </Badge>
  );
}

/** A dot when checks_state is set: pending amber, success green, failure red. */
export function ChecksDot({ workspace: w }: { workspace: Pick<WorkspaceSummary, "checksState"> }) {
  if (w.checksState === null) return null;
  const label = CHECKS_LABELS[w.checksState];

  return (
    <SimpleTooltip label={label}>
      <span role="img" aria-label={label} className="flex size-3 shrink-0 items-center justify-center">
        <span className={cn("size-1.5 rounded-full", CHECKS_DOT_CLASS[w.checksState])} />
      </span>
    </SimpleTooltip>
  );
}

/** 04, Container pill. With `onWake` (sleeping) it is the workspace view's one Wake button. */
export function ContainerPill({
  pill,
  className,
  onWake,
}: {
  pill: Pill;
  className?: string;
  onWake?: () => void;
}) {
  if (onWake) {
    return (
      <SimpleTooltip label="Wake. Sending a message also wakes it.">
        <button
          type="button"
          onClick={onWake}
          className={cn(
            "inline-flex h-6 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-full border px-2 text-xs whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground",
            className,
          )}
        >
          <MoonIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{pill.text}</span>
        </button>
      </SimpleTooltip>
    );
  }

  // The header shows the state only; the instance is on hover and in Info (04, Container pill).
  const [state, ...rest] = pill.text.split(" · ");

  const status = (
    <span
      role="status"
      aria-label={pill.text}
      className={cn(
        "inline-flex h-6 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-full border px-2 text-xs whitespace-nowrap",
        pill.tone === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
        pill.tone === "muted" && "text-muted-foreground",
        pill.tone === "busy" && "text-muted-foreground",
        className,
      )}
    >
      {pill.tone === "busy" && <LoaderCircleIcon aria-hidden className="size-3 shrink-0 animate-spin" />}
      {pill.tone === "default" && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
      <span className="truncate">{state}</span>
    </span>
  );

  return rest.length ? <SimpleTooltip label={`Running on ${rest.join(" · ")}`}>{status}</SimpleTooltip> : status;
}
