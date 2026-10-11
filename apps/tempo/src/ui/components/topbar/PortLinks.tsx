import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { isMacPlatform } from "~/ui/lib/shortcuts";
import { cn } from "~/ui/lib/utils";
import { openBrowser } from "~/ui/state/workspace-ui";

/**
 * 04, Top bar middle: one `<port> ↗` link per detected port. A click opens the preview in a new
 * browser tab; ⌥-click opens it in a Browser tab inside Tempo.
 */
export function PortLinks({
  workspaceId,
  ports,
  className,
}: {
  workspaceId: string;
  ports: ReadonlyArray<{ readonly port: number; readonly url: string }>;
  className?: string;
}) {
  if (ports.length === 0) return null;
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
              if (!e.altKey) return;
              e.preventDefault();
              openBrowser(workspaceId, p.url);
            }}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs text-muted-foreground tabular-nums outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {p.port} ↗
          </a>
        </SimpleTooltip>
      ))}
    </nav>
  );
}
