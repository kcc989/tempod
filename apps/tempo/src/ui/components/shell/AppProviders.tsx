import { useEffect, type ReactNode } from "react";
import { Toaster } from "~/ui/components/ui/sonner";
import { TooltipProvider } from "~/ui/components/ui/tooltip";
import { startThemeSync } from "~/ui/lib/theme";

/** Providers every page needs: theme sync, tooltips and the toaster. */
export function AppProviders({ children }: { children: ReactNode }) {
  useEffect(() => startThemeSync(), []);

  return (
    <TooltipProvider>
      {children}
      <Toaster />
    </TooltipProvider>
  );
}
