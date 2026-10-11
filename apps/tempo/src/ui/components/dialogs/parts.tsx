import type { ReactNode } from "react";
import { Kbd } from "~/ui/components/ui/kbd";
import { formatCombo, isMacPlatform } from "~/ui/lib/shortcuts";
import { cn } from "~/ui/lib/utils";

/** The ⌘Enter label shown next to a dialog's submit button (04, Dialogs). */
export function SubmitKbd({ className }: { className?: string }) {
  return <Kbd className={className}>{formatCombo({ code: "Enter", mod: true }, isMacPlatform())}</Kbd>;
}

/** A labelled block inside a dialog form. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
      ) : (
        <span className="text-sm font-medium">{label}</span>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** A copyable command shown in monospace, for example `claude setup-token`. */
export function CommandLine({ children }: { children: string }) {
  return (
    <code className="inline-block rounded-sm border bg-muted px-1.5 py-0.5 font-mono text-xs select-all">
      {children}
    </code>
  );
}
