import { AlertCircleIcon, MonitorIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "~/ui/components/ui/button";
import { Skeleton } from "~/ui/components/ui/skeleton";
import { LoadingText } from "~/ui/components/ui/spinner";
import { errorText } from "~/ui/lib/toast";
import { cn } from "~/ui/lib/utils";

/** 04, Empty states: a short line and an optional action. */
export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 p-6 text-center", className)}>
      {Icon && <Icon className="size-5 text-muted-foreground" />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** A failed load: the error-table message and Retry. */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-2 p-6 text-center", className)}>
      <AlertCircleIcon className="size-5 text-destructive" />
      <p className="text-sm">{errorText(error)}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** 04: lists show skeleton rows while loading, never a blank pane. */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={cn("flex flex-col gap-2 p-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5" style={{ width: `${60 + ((i * 37) % 35)}%` }} />
      ))}
    </div>
  );
}

export function CenteredLoading({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("flex h-full w-full items-center justify-center p-6", className)}>
      <LoadingText label={label} />
    </div>
  );
}

/** 04, Phone width: terminal, Run output and the file tree are not shown. */
export function PhoneUnavailable({ className }: { className?: string }) {
  return <EmptyState icon={MonitorIcon} title="Open Tempo on a larger screen for this." className={className} />;
}

export function NotFoundState({ action, className }: { action?: ReactNode; className?: string }) {
  return <EmptyState title="Not found." action={action} className={className} />;
}
