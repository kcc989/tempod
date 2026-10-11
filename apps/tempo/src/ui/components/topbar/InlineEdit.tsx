import { useEffect, useRef } from "react";
import { Input } from "~/ui/components/ui/input";
import { cn } from "~/ui/lib/utils";
import { renameValue } from "./topbar-logic";

/**
 * A one-line editor for a title: Enter or blur saves, Esc cancels. `onSave` gets the trimmed
 * value only when it changed.
 */
export function InlineEdit({
  value,
  label,
  onSave,
  onDone,
  className,
}: {
  value: string;
  label: string;
  onSave: (next: string) => void;
  onDone: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    // After a menu closes it hands focus back to its trigger; take it once that is done.
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = save ? renameValue(ref.current?.value ?? "", value) : null;
    if (next !== null) onSave(next);
    onDone();
  };

  return (
    <Input
      ref={ref}
      defaultValue={value}
      aria-label={label}
      maxLength={200}
      className={cn("h-6 px-1.5 text-sm", className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}
