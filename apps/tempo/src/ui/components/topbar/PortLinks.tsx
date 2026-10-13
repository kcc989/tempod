import { useApiCall } from "~/ui/hooks/useCall";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { isMacPlatform } from "~/ui/lib/shortcuts";
import { cn } from "~/ui/lib/utils";
import { openBrowser, openLiveView } from "~/ui/state/workspace-ui";
import { openPreviewTab } from "./open-preview";

/**
 * 04, Top bar middle: one `<port> ↗` link per detected port. A click opens the entry link from
 * openPreview in a new browser tab; ⌥-click opens the preview in a Browser tab inside Tempo.
 * While a Browser Run session is open, `Live` follows and opens the Live View tab.
 */
export function PortLinks({
  workspaceId,
  ports,
  browserActive,
  className,
}: {
  workspaceId: string;
  ports: ReadonlyArray<{ readonly port: number; readonly url: string }>;
  browserActive: boolean;
  className?: string;
}) {
  const call = useApiCall();

  if (ports.length === 0 && !browserActive) return null;
  const altClick = isMacPlatform() ? "⌥-click" : "Alt+click";

  return (
    <nav aria-label="Previews" className={cn("flex min-w-0 items-center gap-1 overflow-hidden", className)}>
      {ports.map((p) => (
        <SimpleTooltip key={p.port} label={`Opens in a new tab. ${altClick} opens it in Tempo.`}>
          <a
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault();

              if (e.altKey) openBrowser(workspaceId, p.url);
              else void openPreviewTab(workspaceId, p.port, call);
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              void openPreviewTab(workspaceId, p.port, call);
            }}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs text-muted-foreground tabular-nums outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {p.port} ↗
          </a>
        </SimpleTooltip>
      ))}
      {browserActive && (
        <button
          type="button"
          onClick={() => openLiveView(workspaceId)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <LiveDot />
          Live
        </button>
      )}
    </nav>
  );
}

export function LiveDot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />;
}
