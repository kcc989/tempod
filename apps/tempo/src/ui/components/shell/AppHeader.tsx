import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelLeftIcon } from "lucide-react";
import { Button } from "~/ui/components/ui/button";
import { toggleSidebar } from "~/ui/state/workspace-ui";

interface HeaderSlots {
  readonly center: HTMLDivElement | null;
  readonly tools: HTMLDivElement | null;
  readonly setToolWidth: (width: number) => void;
}

const HeaderContext = createContext<HeaderSlots | null>(null);

export const useAppHeader = () => useContext(HeaderContext);

export function SharedHeaderRegion({
  region,
  children,
}: {
  region: "center" | "tools";
  children: ReactNode;
}) {
  const header = useAppHeader();

  if (!header) return children;
  const host = header[region];

  return host ? createPortal(children, host) : null;
}

export function AppHeader({ sidebarWidth, children }: { sidebarWidth: number; children: ReactNode }) {
  const [center, setCenter] = useState<HTMLDivElement | null>(null);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const [toolWidth, setToolWidth] = useState(0);
  const slots = useMemo(() => ({ center, tools, setToolWidth }), [center, tools]);

  return (
    <HeaderContext.Provider value={slots}>
      <div className="flex h-full min-h-0 flex-col">
        <header aria-label="App header" className="flex h-10 shrink-0 border-b bg-muted">
          <div className="flex h-full shrink-0 items-center justify-end px-2" style={{ width: sidebarWidth }}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle sidebar"
              title="Toggle sidebar"
              onClick={toggleSidebar}
            >
              <PanelLeftIcon />
            </Button>
          </div>
          <div ref={setCenter} className="h-full min-w-0 flex-1" />
          <div
            ref={setTools}
            className={"h-full min-w-0 shrink-0 overflow-hidden" + (toolWidth > 0 ? " border-l" : "")}
            style={{ width: toolWidth }}
          />
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </HeaderContext.Provider>
  );
}
