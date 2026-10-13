import { ERROR_MESSAGES, type ChangedFile, type DiffScope, type ReviewComment } from "@tempo/protocol";
import { ChevronDownIcon, ChevronRightIcon, MessageSquarePlusIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { isImagePath } from "~/ui/components/artifacts/artifact-model";
import { Button } from "~/ui/components/ui/button";
import { Checkbox } from "~/ui/components/ui/checkbox";
import { ShortcutKbd } from "~/ui/components/ui/kbd";
import { Label } from "~/ui/components/ui/label";
import { Skeleton } from "~/ui/components/ui/skeleton";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useCallQuery } from "~/ui/hooks/useCall";
import { parseUnifiedDiff } from "~/ui/lib/diff";
import { errorCode, errorText } from "~/ui/lib/toast";
import { cn } from "~/ui/lib/utils";
import { openFile } from "~/ui/state/workspace-ui";
import { statusLetter } from "./changes-model";
import { CommentForm, DraftCard } from "./CommentParts";
import { DiffLines } from "./DiffLines";
import { ImageDiff } from "./ImageDiff";
import {
  diffHash,
  diffLineCount,
  LARGE_DIFF_LINES,
  placeComments,
  type DiffView,
  type LineRange,
} from "./diff-model";
import { LineCounts, StatusLetter } from "./parts";
import { retryWhileWaking } from "./use-review";

export interface DiffFileProps {
  readonly workspaceId: string;
  readonly file: ChangedFile;
  readonly scope: DiffScope;
  readonly beforeSha: string | null;
  readonly view: DiffView;
  readonly live: boolean;
  readonly viewedHash: string | undefined;
  readonly drafts: ReadonlyArray<ReviewComment>;
  /** Changes each time this file is opened from the Changes list: load, expand and show it. */
  readonly reveal: number;
  readonly scrollRoot: RefObject<HTMLDivElement | null>;
  readonly register: (path: string, el: HTMLElement | null) => void;
  readonly onHash: (path: string, hash: string | null) => void;
  readonly onToggleViewed: (path: string) => void;
}

/** One file in the Diff tab: a sticky header and its diff, loaded when it scrolls near. */
export function DiffFile({
  workspaceId,
  file,
  scope,
  beforeSha,
  view,
  live,
  viewedHash,
  drafts,
  reveal,
  scrollRoot,
  register,
  onHash,
  onToggleViewed,
}: DiffFileProps) {
  const bodyId = useId();
  const viewedId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [showLarge, setShowLarge] = useState(false);
  const [composer, setComposer] = useState<LineRange | null>(null);
  const [fileComposer, setFileComposer] = useState(false);
  const path = file.path;

  useLayoutEffect(() => {
    const el = sectionRef.current;
    register(path, el);

    return () => register(path, null);
  }, [path, register]);

  useEffect(() => {
    const el = sectionRef.current;

    if (!el || near || typeof IntersectionObserver === "undefined") return;

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: scrollRoot.current, rootMargin: "800px 0px" },
    );

    io.observe(el);

    return () => io.disconnect();
  }, [near, scrollRoot]);

  const [lastReveal, setLastReveal] = useState(0);

  if (reveal !== lastReveal) {
    setLastReveal(reveal);

    if (reveal !== 0) {
      setNear(true);
      setOpenOverride(true);
    }
  }

  const load = near || typeof IntersectionObserver === "undefined";

  const diff = useCallQuery(
    "getFileDiff",
    { workspaceId, scope, path },
    { enabled: load && live, retry: false, staleTime: 30_000, refetchInterval: retryWhileWaking },
  );

  const text = diff.data?.diff;
  const parsed = useMemo(() => (text === undefined ? null : parseUnifiedDiff(text)), [text]);
  const hash = useMemo(() => (text === undefined ? null : diffHash(text)), [text]);

  useEffect(() => {
    onHash(path, hash);
  }, [path, hash, onHash]);

  const viewed = hash !== null && viewedHash === hash;
  // Before the diff loads, a stored mark keeps the file folded so it does not jump open and shut.
  const folded = hash === null ? viewedHash !== undefined : viewed;
  const [lastMark, setLastMark] = useState(viewedHash);

  if (lastMark !== viewedHash) {
    setLastMark(viewedHash);
    setOpenOverride(null);
  }

  const open = openOverride ?? !folded;
  const placed = useMemo(() => placeComments(parsed, drafts), [parsed, drafts]);
  const deleted = statusLetter(file.status) === "D";

  let body;

  if (!open) body = null;
  else if (!diff.data && !live) {
    body = <Note>Wake the workspace to see this diff.</Note>;
  } else if (diff.isError && !diff.data) {
    body = (
      <Note>
        {errorCode(diff.error) === "CONTAINER_NOT_READY"
          ? ERROR_MESSAGES.CONTAINER_NOT_READY
          : errorText(diff.error)}
      </Note>
    );
  } else if (!parsed) {
    body = (
      <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-1.5 p-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  } else if (isImagePath(path)) {
    body = (
      <ImageDiff
        workspaceId={workspaceId}
        path={path}
        oldPath={file.oldPath ?? path}
        status={statusLetter(file.status)}
        beforeSha={beforeSha}
        live={live}
      />
    );
  } else if (parsed.binary) {
    body = <Note>Binary file.</Note>;
  } else if (parsed.hunks.length === 0) {
    body = <Note>No text changes.</Note>;
  } else if (!showLarge && diffLineCount(parsed) > LARGE_DIFF_LINES) {
    body = (
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        {`${diffLineCount(parsed)} lines changed.`}
        <Button size="sm" variant="outline" onClick={() => setShowLarge(true)}>
          Show diff
        </Button>
      </div>
    );
  } else {
    body = (
      <div className={cn(view === "unified" && "overflow-x-auto")}>
        <DiffLines
          workspaceId={workspaceId}
          path={path}
          parsed={parsed}
          view={view}
          placed={placed}
          composer={composer}
          setComposer={setComposer}
        />
      </div>
    );
  }

  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const fileLevel = placed.fileLevel;

  return (
    <section ref={sectionRef} aria-label={path} data-path={path} className="border-b">
      <header className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b bg-background px-2">
        <Button
          size="icon-sm"
          variant="ghost"
          data-file-toggle
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? `Collapse ${path}` : `Expand ${path}`}
          onClick={() => {
            setNear(true);
            setOpenOverride(!open);
          }}
        >
          <Chevron />
        </Button>
        <StatusLetter status={file.status} />
        <button
          type="button"
          disabled={deleted}
          onClick={() => openFile(workspaceId, path)}
          title={file.oldPath ? `${file.oldPath} → ${path}` : `Open ${path}`}
          className="min-w-0 truncate rounded-sm text-left font-mono text-xs hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:no-underline"
        >
          {file.oldPath ? `${file.oldPath} → ${path}` : path}
        </button>
        <LineCounts additions={file.additions} deletions={file.deletions} className="ml-auto" />
        <SimpleTooltip label="Comment on file">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Comment on file"
            onClick={() => {
              setOpenOverride(true);
              setFileComposer(true);
            }}
          >
            <MessageSquarePlusIcon />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip
          label={
            <span className="inline-flex items-center gap-1.5">
              Mark as viewed
              <ShortcutKbd
                action="markViewed"
                className="border-background/30 bg-transparent text-background"
              />
            </span>
          }
        >
          <div className="flex items-center gap-1.5">
            <Checkbox
              id={viewedId}
              checked={viewed}
              disabled={hash === null}
              onCheckedChange={() => onToggleViewed(path)}
            />
            <Label htmlFor={viewedId} className="text-xs font-normal text-muted-foreground">
              Viewed
            </Label>
          </div>
        </SimpleTooltip>
      </header>
      <div id={bodyId} hidden={!open}>
        {(fileLevel.length > 0 || fileComposer) && open && (
          <div className="border-b py-0.5">
            {fileLevel.map((c) => (
              <DraftCard key={c.id} workspaceId={workspaceId} comment={c} />
            ))}
            {fileComposer && (
              <CommentForm
                workspaceId={workspaceId}
                path={path}
                range={null}
                onDone={() => setFileComposer(false)}
              />
            )}
          </div>
        )}
        {body}
      </div>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}
