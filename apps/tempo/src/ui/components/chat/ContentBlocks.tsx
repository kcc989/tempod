import { FileIcon, LinkIcon } from "lucide-react";
import { useMemo } from "react";
import { diffLines } from "~/ui/lib/diff";
import { stripAnsi } from "~/ui/lib/format";
import { cn } from "~/ui/lib/utils";
import { openFile } from "~/ui/state/workspace-ui";
import { fileLinkTarget, toUnifiedHunks, workspacePath, type BlockView } from "./transcript-model";

/** One ACP content block (agent message blocks and tool call content). */
export function BlockViewer({
  workspaceId,
  block,
  monospace = false,
}: {
  workspaceId: string;
  block: BlockView;
  monospace?: boolean;
}) {
  switch (block.kind) {
    case "text":
      return (
        <pre
          className={cn(
            "max-h-80 overflow-auto text-xs whitespace-pre-wrap",
            monospace ? "rounded-md bg-muted/50 p-2 font-mono" : "font-sans",
          )}
        >
          {monospace ? stripAnsi(block.text) : block.text}
        </pre>
      );
    case "image":
      return <img src={block.src} alt={block.alt} className="max-h-80 max-w-full rounded-md border" />;
    case "audio":
      return <audio controls src={block.src} className="h-8 max-w-full" />;
    case "link":
      return <ResourceLink workspaceId={workspaceId} uri={block.uri} name={block.name} />;
    case "resource":
      return (
        <div className="flex flex-col gap-1">
          <ResourceLink workspaceId={workspaceId} uri={block.uri} name={block.uri} />
          {block.text !== null && (
            <pre className="max-h-60 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
              {block.text}
            </pre>
          )}
        </div>
      );
    case "unknown":
      return <p className="text-xs text-muted-foreground">Content of type {block.type} is not shown.</p>;
  }
}

function ResourceLink({ workspaceId, uri, name }: { workspaceId: string; uri: string; name: string }) {
  const file = fileLinkTarget(uri);
  if (file) {
    return (
      <button
        type="button"
        onClick={() => openFile(workspaceId, file.path, file.line)}
        className="inline-flex w-fit items-center gap-1 rounded-sm text-xs text-primary hover:underline"
      >
        <FileIcon className="size-3" />
        {name === uri ? file.path : name}
      </button>
    );
  }
  if (/^https?:\/\//i.test(uri)) {
    return (
      <a
        href={uri}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
      >
        <LinkIcon className="size-3" />
        {name}
      </a>
    );
  }
  return <span className="text-xs text-muted-foreground">{workspacePath(name) || uri}</span>;
}

/** An ACP `diff` tool content as a unified diff. */
export function UnifiedDiff({
  workspaceId,
  path,
  oldText,
  newText,
}: {
  workspaceId: string;
  path: string;
  oldText: string;
  newText: string;
}) {
  const hunks = useMemo(() => toUnifiedHunks(diffLines(oldText, newText)), [oldText, newText]);
  const rel = workspacePath(path);
  const adds = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0);
  const dels = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0);
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex h-6 items-center gap-2 border-b bg-muted/40 px-2 text-xs">
        <button
          type="button"
          className="truncate font-mono hover:underline"
          onClick={() => openFile(workspaceId, rel || path)}
        >
          {rel || path}
        </button>
        <span className="ml-auto text-success">+{adds}</span>
        <span className="text-destructive">−{dels}</span>
      </div>
      <div className="max-h-96 overflow-auto font-mono text-xs leading-5">
        {hunks.length === 0 && <p className="px-2 text-muted-foreground">No changes.</p>}
        {hunks.map((h, i) => (
          <div key={i}>
            <div className="bg-muted/30 px-2 text-muted-foreground">{h.header}</div>
            {h.lines.map((l, j) => (
              <div
                key={j}
                className={cn(
                  "flex whitespace-pre",
                  l.kind === "add" && "bg-diff-add",
                  l.kind === "del" && "bg-diff-del",
                )}
              >
                <span aria-hidden className="w-10 shrink-0 pr-1 text-right text-muted-foreground select-none">
                  {l.kind === "add" ? l.newLine : l.oldLine}
                </span>
                <span aria-hidden className="w-4 shrink-0 text-center select-none">
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </span>
                <span className="sr-only">
                  {l.kind === "add" ? "Added: " : l.kind === "del" ? "Removed: " : ""}
                </span>
                <span className="pr-2">{l.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
