import type { ItemOf } from "@tempo/protocol";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";
import { openArtifactInBrowser } from "~/ui/components/topbar/open-preview";
import { Button } from "~/ui/components/ui/button";
import { Spinner } from "~/ui/components/ui/spinner";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { formatBytes } from "~/ui/lib/format";
import { cn } from "~/ui/lib/utils";
import { openArtifactTab } from "~/ui/state/workspace-ui";
import { ArtifactIcon } from "./ArtifactIcon";
import { artifactSrc, isFramed, versionLabel } from "./artifact-model";
import { ArtifactView } from "./ArtifactTab";

export const LOST_TEXT = "This artifact was lost before it was saved.";

/** 04 Transcript: an `artifact` item. A click or Enter opens the Artifact tab at this version. */
export function ArtifactCard({ workspaceId, item }: { workspaceId: string; item: ItemOf<"artifact"> }) {
  const phone = useIsPhone();
  const [fullScreen, setFullScreen] = useState(false);
  const { artifactId, version, title, summary, name, size, artifactKind } = item.content;
  const pending = item.status === "pending";
  const failed = item.status === "failed";
  const clickable = !pending && !failed;
  const open = () => {
    if (!clickable) return;
    if (!phone) openArtifactTab(workspaceId, artifactId, version);
    else if (isFramed(artifactKind)) void openArtifactInBrowser(workspaceId, artifactId, version);
    else setFullScreen(true);
  };
  const tag = versionLabel(version);
  return (
    <>
      <div
        role={clickable ? "button" : "group"}
        tabIndex={clickable ? 0 : -1}
        aria-label={`Artifact: ${title}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) {
            e.preventDefault();
            open();
          }
        }}
        className={cn(
          "flex max-w-xl flex-col gap-2 rounded-md border p-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          clickable && "cursor-pointer hover:bg-accent/40",
          failed && "opacity-80",
        )}
      >
        <div className="flex items-start gap-2">
          <ArtifactIcon kind={artifactKind} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="flex items-baseline gap-1.5 text-sm font-medium">
              <span className="truncate">{title}</span>
              {tag && <span className="shrink-0 text-xs font-normal text-muted-foreground">{tag}</span>}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {name} · {formatBytes(size)}
            </p>
            {summary && <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>}
          </div>
          {pending && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <Spinner aria-hidden className="text-primary" />
              Saving
            </span>
          )}
        </div>
        {failed && <p className="text-xs text-destructive">{LOST_TEXT}</p>}
        {artifactKind === "image" && clickable && (
          <img
            src={artifactSrc(workspaceId, artifactId, version)}
            alt={title}
            loading="lazy"
            className="max-h-60 w-fit max-w-full rounded-sm border object-contain"
          />
        )}
      </div>
      {fullScreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
            <Button size="sm" variant="ghost" onClick={() => setFullScreen(false)}>
              <ArrowLeftIcon />
              Back
            </Button>
            <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          </div>
          <div className="min-h-0 flex-1">
            <ArtifactView workspaceId={workspaceId} artifactId={artifactId} version={version} />
          </div>
        </div>
      )}
    </>
  );
}
