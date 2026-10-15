import { PR_GUIDE_PATH, type PrGuide } from "@tempo/protocol";
import { BookOpenIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import guidePrompt from "../../../../../../packages/protocol/pr-guide-prompt.txt?raw";
import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { EmptyState, ErrorState, SkeletonRows } from "~/ui/components/shell/States";
import { Button } from "~/ui/components/ui/button";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { copyText } from "~/ui/components/topbar/useWorkspaceActions";
import { workspaceUrl } from "~/ui/lib/links";
import { errorCode } from "~/ui/lib/toast";
import { openDiff, openFile, targetChatSession } from "~/ui/state/workspace-ui";
import { DiffFile } from "./DiffFile";
import { EMPTY_MARKS, isViewedMarks, viewedKey, withViewed } from "./diff-model";
import { DraftsMenu, SendComments } from "./DiffTab";
import { decodeGuideFile, GuideChapters } from "./GuideChapters";
import { WakeButton } from "./parts";
import { useInvalidateOnChanges, useLive, useReviewComments } from "./use-review";

const READS = ["readFile", "getFileDiff"] as const;

export function GuideTab({ workspaceId }: CenterTabProps<"guide">) {
  const live = useLive(workspaceId);
  useInvalidateOnChanges(workspaceId, READS);

  const file = useCallQuery(
    "readFile",
    { workspaceId, path: PR_GUIDE_PATH },
    { enabled: live, retry: false },
  );

  const sessionId = useWorkspaceUiSelector(workspaceId, targetChatSession);
  const session = useWorkspaceSelector(workspaceId, (s) => (sessionId ? s.sessions[sessionId] : undefined));

  const ended = useWorkspaceSelector(
    workspaceId,
    (s) => Object.values(s.turns).filter((t) => t.status !== "running" && t.status !== "queued").length,
  );

  const generate = useCallMutation("sendPrompt");

  const requestedTurn = useWorkspaceSelector(workspaceId, (s) =>
    generate.data ? s.turns[generate.data.id] : undefined,
  );

  const generating =
    generate.isPending ||
    (requestedTurn ?? generate.data)?.status === "queued" ||
    (requestedTurn ?? generate.data)?.status === "running";

  const { refetch } = file;
  useEffect(() => {
    if (live && ended > 0) void refetch();
  }, [ended, live, refetch]);

  const result = useMemo(() => (file.data ? decodeGuideFile(file.data) : null), [file.data]);

  const guide = result && "guide" in result ? result.guide : undefined;
  const canGenerate = live && session !== undefined && session.status !== "closed" && !generating;

  const create = () => {
    if (!canGenerate || !sessionId) return;
    generate.mutate({
      workspaceId,
      sessionId,
      text: guidePrompt,
      mentions: [],
      attachmentIds: [],
      reviewCommentIds: [],
    });
  };

  let body;

  if (!live && !guide) {
    body = (
      <EmptyState
        title="Wake to open the guide."
        action={<WakeButton workspaceId={workspaceId} label="Wake workspace" />}
      />
    );
  } else if (file.isError && errorCode(file.error) !== "NOT_FOUND") {
    body = <ErrorState error={file.error} onRetry={() => void file.refetch()} />;
  } else if (file.isError && errorCode(file.error) === "NOT_FOUND") {
    body = (
      <EmptyState
        icon={BookOpenIcon}
        title="Explain this PR with a guide."
        description="Your agent creates focused chapters, before and after comparisons, and interactive artifacts alongside the code."
        action={
          <Button size="sm" disabled={!canGenerate} onClick={create}>
            Create guide
          </Button>
        }
      />
    );
  } else if (result && "error" in result) {
    body = (
      <EmptyState
        title="This guide is not valid."
        description="Ask your agent to repair the guide’s format, chapter ids, file paths, or visual connections."
        action={
          <Button size="sm" disabled={!canGenerate} onClick={create}>
            Repair guide
          </Button>
        }
      />
    );
  } else if (guide) {
    body = <GuideReview key={workspaceId} workspaceId={workspaceId} guide={guide} live={live} />;
  } else {
    body = <SkeletonRows />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2">
        <BookOpenIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Guide</span>
        <div className="ml-auto flex flex-wrap gap-1">
          {guide && <CreateGuidedPr workspaceId={workspaceId} guide={guide} live={live} />}
          <Button
            size="sm"
            variant="ghost"
            disabled={!live || file.isFetching}
            onClick={() => void file.refetch()}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyText(`${workspaceUrl(workspaceId)}?guide=true`, "Guide link copied.")}
          >
            Copy link
          </Button>
          <Button size="sm" variant="outline" disabled={!canGenerate} onClick={create}>
            {guide ? "Update guide" : "Ask agent"}
          </Button>
        </div>
      </div>
      {generating && (
        <p role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
          Your agent is creating the guide. It will appear here when ready.
        </p>
      )}
      {!sessionId && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Open a chat to choose the agent that creates your guide.
        </p>
      )}
      {guide && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          Agent-authored explanation. Verify it against the live branch diff; update the guide after changing
          code.{!live && " Showing the last loaded guide."}
        </p>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

function CreateGuidedPr({
  workspaceId,
  guide,
  live,
}: {
  workspaceId: string;
  guide: PrGuide;
  live: boolean;
}) {
  const workspace = useHubWorkspace(workspaceId);
  const detail = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const seq = useWorkspaceSelector(workspaceId, (s) => s.changesSeq);

  const dirty = useCallQuery(
    "getChanges",
    { workspaceId, scope: "uncommitted" },
    { enabled: live, retry: false },
  );

  const { refetch } = dirty;
  useEffect(() => {
    if (live && seq > 0) void refetch();
  }, [seq, live, refetch]);

  const create = useCallMutation("createPullRequest", {
    onSuccess: (pr) => {
      toast.success(`Created guided PR #${pr.number}.`, {
        action: { label: "Open", onClick: () => globalThis.open?.(pr.url, "_blank", "noopener,noreferrer") },
      });
    },
  });

  if (workspace?.prState === "open" || workspace?.prState === "draft") return null;

  const ready =
    live &&
    detail?.pushed &&
    !detail.hasUnpushedCommits &&
    !dirty.isFetching &&
    !dirty.isError &&
    dirty.data?.files.length === 0;

  return (
    <Button
      size="sm"
      disabled={!ready || create.isPending}
      title={
        ready
          ? "Create a PR with the guide summary and review link"
          : "Commit and push the guide and artifacts first"
      }
      onClick={() =>
        create.mutate({
          workspaceId,
          title: guide.title,
          body: `${guide.summary}\n\n[Open guided review in Tempo](${workspaceUrl(workspaceId)}?guide=true)\n\nCreated with Tempo.`,
          draft: false,
        })
      }
    >
      {create.isPending ? "Creating PR…" : "Create guided PR"}
    </Button>
  );
}

function GuideReview({ workspaceId, guide, live }: { workspaceId: string; guide: PrGuide; live: boolean }) {
  const changes = useCallQuery(
    "getChanges",
    { workspaceId, scope: "branch" },
    { enabled: live, retry: false },
  );

  const changesSeq = useWorkspaceSelector(workspaceId, (s) => s.changesSeq);
  const { refetch } = changes;
  useEffect(() => {
    if (live && changesSeq > 0) void refetch();
  }, [changesSeq, live, refetch]);
  const { drafts } = useReviewComments(workspaceId);
  const [marks, setMarks] = useLocalStorage(viewedKey(workspaceId), EMPTY_MARKS, isViewedMarks);
  const hashes = useRef(new Map<string, string>());
  const register = useCallback(() => {}, []);

  const onHash = useCallback((path: string, hash: string | null) => {
    if (hash) hashes.current.set(path, hash);
    else hashes.current.delete(path);
  }, []);

  const toggleViewed = (path: string) => {
    const hash = hashes.current.get(path);

    if (hash) setMarks((m) => withViewed(m, path, hash, m[path] !== hash));
  };

  const files = changes.data?.files ?? [];
  const covered = new Set(guide.chapters.flatMap((c) => c.files));
  const remaining = files.filter((f) => !covered.has(f.path));

  return (
    <GuideChapters
      className="h-full"
      guide={guide}
      source={{ kind: "workspace", workspaceId, live }}
      nav={
        remaining.length > 0 && (
          <details className="px-2 py-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Files outside guide ({remaining.length})
            </summary>
            <ul className="mt-2 space-y-1">
              {remaining.map((f) => (
                <li key={f.path}>
                  <button
                    className="break-all text-left text-primary underline focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => openDiff(workspaceId, f.path)}
                  >
                    {f.path}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )
      }
      code={(chapter, scrollRoot) => (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="mr-auto text-sm font-medium">Code</h4>
            <DraftsMenu workspaceId={workspaceId} drafts={drafts} />
            <SendComments workspaceId={workspaceId} drafts={drafts} />
          </div>
          {!live && <WakeButton workspaceId={workspaceId} label="Wake to see diffs" />}
          {changes.isError ? (
            <ErrorState error={changes.error} onRetry={() => void changes.refetch()} />
          ) : live && !changes.data ? (
            <SkeletonRows />
          ) : (
            chapter.files.map((path) => {
              const file = files.find((f) => f.path === path);

              return file ? (
                <DiffFile
                  key={path}
                  workspaceId={workspaceId}
                  file={file}
                  scope="branch"
                  beforeSha={changes.data?.baseSha ?? null}
                  view="unified"
                  live={live}
                  viewedHash={marks[path]}
                  drafts={drafts.filter((d) => d.path === path)}
                  reveal={1}
                  scrollRoot={scrollRoot}
                  register={register}
                  onHash={onHash}
                  onToggleViewed={toggleViewed}
                />
              ) : (
                <div key={path} className="rounded-md border p-3 text-xs text-muted-foreground">
                  {path}: {live ? "not in the current branch diff." : "wake to check the current diff."}
                  <Button size="sm" variant="link" onClick={() => openFile(workspaceId, path)}>
                    Open file
                  </Button>
                </div>
              );
            })
          )}
        </>
      )}
    />
  );
}
