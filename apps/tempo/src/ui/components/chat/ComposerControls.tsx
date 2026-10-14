import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "~/ui/components/ui/dropdown-menu";
import { Textarea } from "~/ui/components/ui/textarea";
import { cn } from "~/ui/lib/utils";

export const COMPOSER_PICKER_TRIGGER =
  "inline-flex h-7 max-w-36 items-center gap-1.5 rounded-lg px-1.5 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

export function ComposerSurface({ className, ...props }: ComponentProps<"div">) {
  return (
    <div {...props} className={cn("rounded-2xl border border-input bg-muted p-3 shadow-md", className)} />
  );
}

export function ComposerInput({ className, ...props }: ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      {...props}
      className={cn(
        "max-h-72 min-h-16 resize-none rounded-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent",
        className,
      )}
    />
  );
}

export function ComposerToolbar({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("mt-3 flex flex-wrap items-center gap-x-1 gap-y-2", className)} />;
}

export function ComposerModelMenu({
  label,
  ariaLabel,
  open,
  onOpenChange,
  disabled,
  onClosed,
  children,
}: {
  label: string;
  ariaLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onClosed: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        className={cn(COMPOSER_PICKER_TRIGGER, "text-foreground")}
        disabled={disabled}
        aria-label={ariaLabel ?? `Model: ${label}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="max-h-80 min-w-48"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
