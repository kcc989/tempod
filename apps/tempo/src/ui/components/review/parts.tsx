import { ERROR_MESSAGES } from "@tempo/protocol";
import { PowerIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Spinner } from "~/ui/components/ui/spinner";
import { useCallMutation } from "~/ui/hooks/useCall";
import { cn } from "~/ui/lib/utils";
import { statusClass, statusLabel, statusLetter, type ChangesSource } from "./changes-model";
import type { Tone } from "./checks-model";

export function StatusLetter({ status, className }: { status: string; className?: string }) {
  return (
    <span
      title={statusLabel(status)}
      className={cn(
        "w-3 shrink-0 text-center font-mono text-xs font-semibold",
        statusClass(status),
        className,
      )}
    >
      <span aria-hidden>{statusLetter(status)}</span>
      <span className="sr-only">{statusLabel(status)}</span>
    </span>
  );
}

export function LineCounts({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums", className)}>
      <span className="text-success">
        <span aria-hidden>+</span>
        <span className="sr-only">Added lines: </span>
        {additions}
      </span>
      <span className="text-destructive">
        <span aria-hidden>−</span>
        <span className="sr-only">Removed lines: </span>
        {deletions}
      </span>
    </span>
  );
}

/** Explicit wake for container-dependent views and sleeping file cache misses. */
export function WakeButton({
  workspaceId,
  label,
  className,
}: {
  workspaceId: string;
  label: string;
  className?: string;
}) {
  const wake = useCallMutation("wakeWorkspace");

  return (
    <Button
      size="sm"
      variant="outline"
      className={className}
      disabled={wake.isPending}
      onClick={() => wake.mutate({ workspaceId })}
    >
      {wake.isPending ? <Spinner /> : <PowerIcon />}
      {label}
    </Button>
  );
}

/** A thin line above a list that does not come straight from the container. */
export function SourceNote({ source, className }: { source: ChangesSource; className?: string }) {
  if (source === "waking") {
    return (
      <p
        role="status"
        className={cn("flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground", className)}
      >
        <Spinner className="size-3" />
        {ERROR_MESSAGES.CONTAINER_NOT_READY}
      </p>
    );
  }

  if (source === "lastKnown") {
    return <p className={cn("px-3 py-1 text-xs text-muted-foreground", className)}>Last known changes.</p>;
  }

  return null;
}

const BADGE: Record<Tone, "success" | "danger" | "warning" | "muted" | "merged"> = {
  success: "success",
  danger: "danger",
  warning: "warning",
  muted: "muted",
  merged: "merged",
};

export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Badge variant={BADGE[tone]}>{children}</Badge>;
}
