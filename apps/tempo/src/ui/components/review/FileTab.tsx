import { ERROR_MESSAGES } from "@tempo/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { LoadingText } from "~/ui/components/ui/spinner";
import { useCallQuery } from "~/ui/hooks/useCall";
import { formatBytes } from "~/ui/lib/format";
import { errorCode, errorText } from "~/ui/lib/toast";
import { cn } from "~/ui/lib/utils";
import { isComingUp, isLive } from "./changes-model";
import { highlightFile, splitLines, type TokenLines } from "./highlight";
import { VIRTUALIZE_AFTER } from "./ListBox";
import { WakeButton } from "./parts";
import { retryWhileWaking, useInvalidateOnChanges, useWorkspaceStateValue } from "./use-review";

const READ_FILE = ["readFile"] as const;
const LINE_HEIGHT = 20;

/** A read-only file (readFile) with Shiki highlighting; `tab.line` is revealed and marked. */
export function FileTab({ workspaceId, tab, seq }: CenterTabProps<"file">) {
  const state = useWorkspaceStateValue(workspaceId);
  const live = isLive(state);
  const available = live || state === "sleeping";
  useInvalidateOnChanges(workspaceId, READ_FILE);
  const file = useCallQuery(
    "readFile",
    { workspaceId, path: tab.path },
    { enabled: available, retry: false, staleTime: 5_000, refetchInterval: live ? retryWhileWaking : false },
  );
  const { refetch } = file;
  useEffect(() => {
    if (available) void refetch();
  }, [available, state, refetch]);

  let body;
  if (file.data) {
    body =
      file.data.encoding === "utf8" ? (
        <CodeView path={tab.path} content={file.data.content} line={tab.line} seq={seq} />
      ) : (
        <EmptyState icon={FileIcon} title="Binary file." description={formatBytes(file.data.size)} />
      );
  } else if (
    !available ||
    (state === "sleeping" && file.isError && errorCode(file.error) === "CONTAINER_NOT_READY")
  ) {
    body = isComingUp(state) ? (
      <div className="flex h-full items-center justify-center">
        <LoadingText label={ERROR_MESSAGES.CONTAINER_NOT_READY} />
      </div>
    ) : (
      <div className="flex h-full items-center justify-center">
        <WakeButton workspaceId={workspaceId} label="Wake to browse files" />
      </div>
    );
  } else if (file.isError) {
    const code = errorCode(file.error);
    body =
      code === "CONTAINER_NOT_READY" ? (
        <div className="flex h-full items-center justify-center">
          <LoadingText label={ERROR_MESSAGES.CONTAINER_NOT_READY} />
        </div>
      ) : code === "FILE_TOO_LARGE" || code === "PATH_OUTSIDE_WORKSPACE" || code === "NOT_FOUND" ? (
        <EmptyState icon={FileIcon} title={errorText(file.error)} />
      ) : (
        <ErrorState error={file.error} onRetry={() => void file.refetch()} />
      );
  } else {
    body = <SkeletonRows />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono text-foreground" title={tab.path}>
          {tab.path}
        </span>
        {file.data && <span className="shrink-0">{formatBytes(file.data.size)}</span>}
        <span className="ml-auto shrink-0">Read only</span>
      </div>
      {state === "sleeping" && file.data && (
        <p className="px-3 py-1 text-xs text-muted-foreground">Last synced file. May be out of date.</p>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

function CodeView({
  path,
  content,
  line,
  seq,
}: {
  path: string;
  content: string;
  line: number | null;
  seq: number;
}) {
  const lines = useMemo(() => splitLines(content), [content]);
  const [tokens, setTokens] = useState<{ content: string; lines: TokenLines } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = lines.length > VIRTUALIZE_AFTER;
  const gutter = String(lines.length).length + 1;
  const widest = useMemo(() => lines.reduce((m, l) => Math.max(m, l.length), 0), [lines]);

  useEffect(() => {
    let cancelled = false;
    highlightFile(content, path)
      .then((t) => {
        if (!cancelled) setTokens(t ? { content, lines: t } : null);
      })
      .catch(() => {
        // Plain text is fine.
      });
    return () => {
      cancelled = true;
    };
  }, [content, path]);

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
    enabled: virtual,
  });

  const target = line !== null && line >= 1 && line <= lines.length ? line : null;
  const { scrollToIndex } = virtualizer;
  useEffect(() => {
    if (target === null) return;
    if (virtual) scrollToIndex(target - 1, { align: "center" });
    else scrollRef.current?.querySelector(`[data-line="${target}"]`)?.scrollIntoView({ block: "center" });
  }, [target, seq, virtual, scrollToIndex]);

  const highlighted = tokens?.content === content ? tokens.lines : null;

  const row = (i: number, style?: CSSProperties) => {
    const n = i + 1;
    const toks = highlighted?.[i];
    return (
      <div
        key={i}
        data-line={n}
        style={style ?? { height: LINE_HEIGHT }}
        className={cn("flex", n === target && "bg-warning/15")}
      >
        <span
          aria-hidden
          className="sticky left-0 shrink-0 bg-background pr-3 pl-2 text-right text-muted-foreground select-none"
          style={{ width: `${gutter + 2}ch` }}
        >
          {n}
        </span>
        <span className="pr-4 whitespace-pre">
          {toks
            ? toks.map((t, k) => (
                <span key={k} style={t.style}>
                  {t.content}
                </span>
              ))
            : lines[i]}
        </span>
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="region"
      aria-label={path}
      data-shiki=""
      className="h-full overflow-auto font-mono text-xs leading-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      style={{ tabSize: 4 }}
    >
      {virtual ? (
        <div
          className="relative"
          style={{ height: virtualizer.getTotalSize(), minWidth: `${widest + gutter + 8}ch` }}
        >
          {virtualizer.getVirtualItems().map((v) =>
            row(v.index, {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: LINE_HEIGHT,
              transform: `translateY(${v.start}px)`,
            }),
          )}
        </div>
      ) : (
        <div className="w-max min-w-full py-1">{lines.map((_, i) => row(i))}</div>
      )}
    </div>
  );
}
