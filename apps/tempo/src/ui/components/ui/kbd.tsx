import type * as React from "react";
import { formatBinding, type ActionId } from "~/ui/lib/shortcuts";
import { cn } from "~/ui/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4.5 w-fit min-w-4.5 items-center justify-center gap-0.5 rounded-sm border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground select-none [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="kbd-group" className={cn("inline-flex items-center gap-1", className)} {...props} />;
}

/** The platform label of a shortcut from the 04 table, for example ⌥N on macOS and Alt+N elsewhere. */
function ShortcutKbd({ action, className }: { action: ActionId; className?: string }) {
  return <Kbd className={className}>{formatBinding(action)}</Kbd>;
}

export { Kbd, KbdGroup, ShortcutKbd };
