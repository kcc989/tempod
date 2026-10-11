import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type * as React from "react";
import { cn } from "~/ui/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-3.5 shrink-0 animate-spin", className)}
      {...props}
    />
  );
}

/** 04: a spinner never shows alone for more than 300 ms; after that it gets words. */
const WORDS_AFTER_MS = 300;

function LoadingText({ label, className }: { label: string; className?: string }) {
  const [showWords, setShowWords] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowWords(true), WORDS_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-2 text-sm text-muted-foreground", className)}
    >
      <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />
      <span className={showWords ? undefined : "sr-only"}>{label}</span>
    </span>
  );
}

export { LoadingText, Spinner, WORDS_AFTER_MS };
