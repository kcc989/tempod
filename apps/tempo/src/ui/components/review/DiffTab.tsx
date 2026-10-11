import type { ReviewComment } from "@tempo/protocol";
import { MessageSquareIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Badge } from "~/ui/components/ui/badge";
import { Button } from "~/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "~/ui/components/ui/toggle-group";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";
import { useIsNarrow } from "~/ui/hooks/useMediaQuery";
import { useShortcuts } from "~/ui/hooks/useShortcuts";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { agentLabel } from "~/ui/lib/agents";
import { isEditableTarget } from "~/ui/lib/shortcuts";
import { insertIntoComposer, openDiff, targetChatSession } from "~/ui/state/workspace-ui";
import { changeRows, GROUP_BY_FOLDER_KEY, isBoolean, totals } from "./changes-model";
import { ScopeToggle } from "./ChangesView";
import { DiffFile } from "./DiffFile";
import {
  commentLocation,
  currentFileIndex,
  DIFF_VIEW_KEY,
  EMPTY_MARKS,
  effectiveView,
  isDiffView,
  isViewedMarks,
  sendLabel,
  stepFileIndex,
  viewedKey,
  withViewed,
  type DiffView,
} from "./diff-model";
import { LineCounts, SourceNote, WakeButton } from "./parts";
import { useChanges, useDeleteComment, useInvalidateOnChanges, useReviewComments } from "./use-review";

const UNIFIED: DiffView = "unified";
const GET_FILE_DIFF = ["getFileDiff"] as const;

/**
 * 04, Diff tab: every changed file in the shared scope, stacked. J and K move between files, ⌃V
 * marks the file at the top as viewed, line and file comments stay drafts until sent.
 */
export function DiffTab({ workspaceId, tab, active, seq }: CenterTabProps<"diff">) {
  const changes = useChanges(workspaceId);
  useInvalidateOnChanges(workspaceId, GET_FILE_DIFF);
  const narrow = useIsNarrow();
  const [preference, setPreference] = useLocalStorage(DIFF_VIEW_KEY, UNIFIED, isDiffView);
  const view = effectiveView(preference, narrow);
  const [grouped] = useLocalStorage(GROUP_BY_FOLDER_KEY, false, isBoolean);
  const [marks, setMarks] = useLocalStorage(viewedKey(workspaceId), EMPTY_MARKS, isViewedMarks);
  const { drafts } = useReviewComments(workspaceId);

  const files = useMemo(
    () => changeRows(changes.files, { grouped }).flatMap((r) => (r.kind === "file" ? [r.file] : [])),
    [changes.files, grouped],
  );
  const draftsByPath = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of drafts) {
      const list = m.get(c.path);
      if (list) list.push(c);
      else m.set(c.path, [c]);
    }
    return m;
  }, [drafts]);
  const sum = totals(files);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const hashes = useRef(new Map<string, string>());
  const register = useCallback((path: string, el: HTMLElement | null) => {
    if (el) sections.current.set(path, el);
    else sections.current.delete(path);
  }, []);
  const onHash = useCallback((path: string, hash: string | null) => {
    if (hash) hashes.current.set(path, hash);
    else hashes.current.delete(path);
  }, []);

  const topOf = (el: HTMLElement): number => {
    const root = scrollRef.current;
    if (!root) return 0;
    return el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
  };
  const tops = () =>
    files.map((f) => {
      const el = sections.current.get(f.path);
      return el ? topOf(el) : 0;
    });
  const scrollToPath = (path: string, focus: boolean) => {
    const root = scrollRef.current;
    const el = sections.current.get(path);
    if (!root || !el) return false;
    root.scrollTop = topOf(el);
    if (focus) el.querySelector<HTMLElement>("[data-file-toggle]")?.focus({ preventScroll: true });
    return true;
  };

  // Show tab.path each time the tab is opened at a file.
  const [revealed, setRevealed] = useState<{ path: string; seq: number } | null>(null);
  if (tab.path && revealed?.seq !== seq) setRevealed({ path: tab.path, seq });
  const revealedSeq = useRef(0);
  useLayoutEffect(() => {
    if (!revealed || revealedSeq.current === revealed.seq) return;
    if (scrollToPath(revealed.path, false)) revealedSeq.current = revealed.seq;
  });

  const toggleViewed = (path: string) => {
    const hash = hashes.current.get(path);
    if (!hash) return;
    setMarks((m) => withViewed(m, path, hash, m[path] !== hash));
  };

  const step = (dir: 1 | -1) => {
    const root = scrollRef.current;
    if (!root) return;
    const i = stepFileIndex(tops(), root.scrollTop, dir);
    const f = i === null ? undefined : files[i];
    if (f) scrollToPath(f.path, true);
  };

  useShortcuts(
    {
      nextFile: () => step(1),
      prevFile: () => step(-1),
      markViewed: (e) => {
        if (isEditableTarget(e.target)) return false;
        const root = scrollRef.current;
        if (!root || files.length === 0) return;
        const f = files[currentFileIndex(tops(), root.scrollTop)];
        if (f) toggleViewed(f.path);
      },
    },
    { enabled: active },
  );

  let body;
  if (!changes.hasList) {
    body =
      changes.source === "error" ? (
        <ErrorState error={changes.error} onRetry={changes.refetch} />
      ) : (
        <SkeletonRows />
      );
  } else if (files.length === 0) {
    body =
      changes.source === "error" ? (
        <ErrorState error={changes.error} onRetry={changes.refetch} />
      ) : (
        <EmptyState title="No changes yet." />
      );
  } else {
    body = files.map((f) => (
      <DiffFile
        key={f.path}
        workspaceId={workspaceId}
        file={f}
        scope={changes.scope}
        view={view}
        live={changes.live}
        viewedHash={marks[f.path]}
        drafts={draftsByPath.get(f.path) ?? []}
        reveal={revealed?.path === f.path ? revealed.seq : 0}
        scrollRoot={scrollRef}
        register={register}
        onHash={onHash}
        onToggleViewed={toggleViewed}
      />
    ));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5">
        <ScopeToggle workspaceId={workspaceId} changes={changes} />
        {sum.files > 0 && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {sum.files === 1 ? "1 file" : `${sum.files} files`}
            <LineCounts additions={sum.additions} deletions={sum.deletions} />
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <SimpleTooltip label={narrow ? "Split view needs a wider window." : "Unified or split"}>
            <ToggleGroup
              type="single"
              size="sm"
              aria-label="Diff view"
              value={view}
              disabled={narrow}
              onValueChange={(v) => {
                if (isDiffView(v)) setPreference(v);
              }}
            >
              <ToggleGroupItem value="unified" className="px-2">
                Unified
              </ToggleGroupItem>
              <ToggleGroupItem value="split" className="px-2">
                Split
              </ToggleGroupItem>
            </ToggleGroup>
          </SimpleTooltip>
          <DraftsMenu workspaceId={workspaceId} drafts={drafts} />
          <SendComments workspaceId={workspaceId} drafts={drafts} />
        </div>
      </div>
      <SourceNote source={changes.source} />
      {changes.source === "lastKnown" && files.length > 0 && (
        <div className="px-3 pb-1">
          <WakeButton workspaceId={workspaceId} label="Wake to see diffs" />
        </div>
      )}
      <div
        ref={scrollRef}
        tabIndex={-1}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none"
        aria-label="Diff"
      >
        {body}
      </div>
    </div>
  );
}

/** `Send <n> comments to <agent>`: the drafts go to the composer as one chip. */
function SendComments({
  workspaceId,
  drafts,
}: {
  workspaceId: string;
  drafts: ReadonlyArray<ReviewComment>;
}) {
  const sessionId = useWorkspaceUiSelector(workspaceId, targetChatSession);
  const sessionAgent = useWorkspaceSelector(workspaceId, (s) =>
    sessionId ? s.sessions[sessionId]?.agent : undefined,
  );
  const defaultAgent = useHubWorkspace(workspaceId)?.defaultAgent;
  const agent = sessionAgent ?? defaultAgent;
  if (drafts.length === 0) return null;
  return (
    <Button
      size="sm"
      onClick={() =>
        insertIntoComposer(workspaceId, { kind: "reviewComments", commentIds: drafts.map((c) => c.id) })
      }
    >
      <SendIcon />
      {sendLabel(drafts.length, agent ? agentLabel(agent) : "the agent")}
    </Button>
  );
}

function DraftsMenu({ workspaceId, drafts }: { workspaceId: string; drafts: ReadonlyArray<ReviewComment> }) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteComment();
  if (drafts.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          <MessageSquareIcon />
          Drafts
          <Badge variant="muted">{drafts.length}</Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-1">
        <ul aria-label="Draft comments" className="flex max-h-80 flex-col overflow-y-auto">
          {drafts.map((c) => (
            <li key={c.id} className="flex items-start gap-1 rounded-sm hover:bg-accent/60">
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-sm px-2 py-1 text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={() => {
                  setOpen(false);
                  openDiff(workspaceId, c.path);
                }}
              >
                <span className="max-w-full truncate font-mono text-xs text-muted-foreground">
                  {commentLocation(c)}
                </span>
                <span className="line-clamp-2 text-sm break-words">{c.body}</span>
              </button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Delete comment"
                className="mt-1 mr-1"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ workspaceId, commentId: c.id })}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
