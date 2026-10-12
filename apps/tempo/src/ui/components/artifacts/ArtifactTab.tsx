import { isErrorBody, TempoError, type Artifact } from "@tempo/protocol";
import { ChevronDownIcon, DownloadIcon, ExternalLinkIcon, FileIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { MessageMarkdown } from "~/ui/components/chat/Markdown";
import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { CodeView } from "~/ui/components/review/FileTab";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { openArtifactInBrowser } from "~/ui/components/topbar/open-preview";
import { Button } from "~/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/ui/components/ui/dropdown-menu";
import { LoadingText } from "~/ui/components/ui/spinner";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { call } from "~/ui/lib/api";
import { formatDateTime } from "~/ui/lib/format";
import { errorText } from "~/ui/lib/toast";
import { cn } from "~/ui/lib/utils";
import { openFile } from "~/ui/state/workspace-ui";
import { ARTIFACT_HTML_SANDBOX, artifactGroups, artifactSrc, workspaceRelative } from "./artifact-model";
import { useArtifacts } from "./useArtifacts";

const LOST_TEXT = "This artifact was lost before it was saved.";

/** The versions of one artifact, newest first, or undefined while the list loads. */
const useVersions = (workspaceId: string, artifactId: string) => {
  const { artifacts, error, refetch } = useArtifacts(workspaceId);
  const versions = artifacts
    ? (artifactGroups(artifacts).find((g) => g.id === artifactId)?.versions ?? [])
    : undefined;
  return { versions, error, refetch };
};

export function ArtifactTitle({ workspaceId, tab }: CenterTabProps<"artifact">) {
  const { versions } = useVersions(workspaceId, tab.artifactId);
  return <>{versions?.[0]?.title ?? "Artifact"}</>;
}

/** 04 Artifact tab: one tab per artifact, with a version menu, Download and Reload. */
export function ArtifactTab({ workspaceId, tab, seq }: CenterTabProps<"artifact">) {
  const { versions, error, refetch } = useVersions(workspaceId, tab.artifactId);
  const [picked, setPicked] = useState<{ seq: number; version: number | null }>({
    seq,
    version: tab.version,
  });
  const [nonce, setNonce] = useState(0);
  // Opening the tab again (a card click) shows the version it asks for.
  const chosen = picked.seq === seq ? picked.version : tab.version;

  if (!versions) {
    if (error) return <ErrorState error={error} onRetry={refetch} className="h-full" />;
    return <SkeletonRows />;
  }
  const current = versions.find((v) => v.version === chosen) ?? versions[0];
  if (!current) return <EmptyState className="h-full" icon={FileIcon} title="Not found." />;
  const fileLink = workspaceRelative(current.path);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="min-w-0 truncate text-sm font-medium">{current.title}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" aria-label="Version">
              v{current.version}
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={String(current.version)}
              onValueChange={(v) => setPicked({ seq, version: Number(v) })}
            >
              {versions.map((v) => (
                <DropdownMenuRadioItem key={v.version} value={String(v.version)}>
                  v{v.version} · {formatDateTime(v.createdAt)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {fileLink ? (
          <button
            type="button"
            className="min-w-0 truncate font-mono text-primary hover:underline"
            title={current.path}
            onClick={() => openFile(workspaceId, fileLink)}
          >
            {current.name}
          </button>
        ) : (
          <span className="min-w-0 truncate font-mono text-muted-foreground" title={current.path}>
            {current.name}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <SimpleTooltip label="Download">
            <Button asChild size="icon-sm" variant="ghost">
              <a
                href={artifactSrc(workspaceId, current.id, current.version, true)}
                download={current.name}
                aria-label="Download"
              >
                <DownloadIcon />
              </a>
            </Button>
          </SimpleTooltip>
          <SimpleTooltip label="Reload">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Reload"
              onClick={() => {
                refetch();
                setNonce((n) => n + 1);
              }}
            >
              <RotateCwIcon />
            </Button>
          </SimpleTooltip>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ArtifactBody key={`${current.version}:${nonce}`} workspaceId={workspaceId} artifact={current} />
      </div>
    </div>
  );
}

/** The body of one version, by itself: the phone's full-screen view uses it. */
export function ArtifactView({
  workspaceId,
  artifactId,
  version,
}: {
  workspaceId: string;
  artifactId: string;
  version: number;
}) {
  const { versions, error, refetch } = useVersions(workspaceId, artifactId);
  if (!versions) {
    if (error) return <ErrorState error={error} onRetry={refetch} className="h-full" />;
    return <SkeletonRows />;
  }
  const artifact = versions.find((v) => v.version === version);
  if (!artifact) return <EmptyState className="h-full" icon={FileIcon} title="Not found." />;
  return <ArtifactBody workspaceId={workspaceId} artifact={artifact} />;
}

function ArtifactBody({ workspaceId, artifact }: { workspaceId: string; artifact: Artifact }) {
  if (artifact.status === "uploading")
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingText label="Saving…" />
      </div>
    );
  if (artifact.status === "lost") return <EmptyState className="h-full" icon={FileIcon} title={LOST_TEXT} />;
  switch (artifact.kind) {
    case "image":
      return <ImageBody workspaceId={workspaceId} artifact={artifact} />;
    case "markdown":
    case "text":
      return <TextBody workspaceId={workspaceId} artifact={artifact} />;
    case "pdf":
    case "html":
      return <FramedBody workspaceId={workspaceId} artifact={artifact} />;
  }
}

/** Fit to the tab; a click zooms to 100 %. SVG only through `<img>` (05). */
function ImageBody({ workspaceId, artifact }: { workspaceId: string; artifact: Artifact }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <div className={cn("h-full overflow-auto p-3", !zoomed && "flex items-center justify-center")}>
      <button
        type="button"
        aria-label={zoomed ? "Fit to tab" : "Zoom to 100 %"}
        className={cn("block", zoomed ? "cursor-zoom-out" : "h-full w-full cursor-zoom-in")}
        onClick={() => setZoomed((z) => !z)}
      >
        <img
          src={artifactSrc(workspaceId, artifact.id, artifact.version)}
          alt={artifact.title}
          className={cn(zoomed ? "max-w-none" : "mx-auto h-full w-full object-contain")}
        />
      </button>
    </div>
  );
}

const fetchText = async (url: string): Promise<string> => {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw isErrorBody(body) ? TempoError.fromBody(body) : new TempoError("INTERNAL");
  }
  return res.text();
};

/** Markdown with the transcript's rules plus Mermaid; text with Shiki, as a file tab. */
function TextBody({ workspaceId, artifact }: { workspaceId: string; artifact: Artifact }) {
  const [state, setState] = useState<{ text: string } | { error: unknown } | null>(null);
  useEffect(() => {
    let live = true;
    fetchText(artifactSrc(workspaceId, artifact.id, artifact.version)).then(
      (text) => live && setState({ text }),
      (error: unknown) => live && setState({ error }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, artifact.id, artifact.version]);
  if (!state) return <SkeletonRows />;
  if ("error" in state) return <ErrorState error={state.error} className="h-full" />;
  if (artifact.kind === "markdown")
    return (
      <div className="h-full overflow-auto px-4 py-3">
        <MessageMarkdown workspaceId={workspaceId} text={state.text} streaming={false} />
      </div>
    );
  return <CodeView path={artifact.name} content={state.text} line={null} seq={0} />;
}

/** PDF and HTML load only from the artifact host, through a one-time entry link (05). */
function FramedBody({ workspaceId, artifact }: { workspaceId: string; artifact: Artifact }) {
  const [src, setSrc] = useState<{ url: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    call("openArtifact", { workspaceId, artifactId: artifact.id, version: artifact.version }).then(
      (r) => live && setSrc({ url: r.url }),
      (e: unknown) => live && setSrc({ error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, artifact.id, artifact.version]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end border-b px-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs"
          onClick={() => void openArtifactInBrowser(workspaceId, artifact.id, artifact.version)}
        >
          <ExternalLinkIcon />
          Open in new tab
        </Button>
      </div>
      {src && "url" in src ? (
        <iframe
          title={artifact.title}
          src={src.url}
          referrerPolicy="no-referrer"
          {...(artifact.kind === "html" ? { sandbox: ARTIFACT_HTML_SANDBOX } : {})}
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      ) : src ? (
        <EmptyState className="min-h-0 flex-1" icon={FileIcon} title={src.error} />
      ) : (
        <div aria-busy="true" className="min-h-0 flex-1 bg-background" />
      )}
    </div>
  );
}
