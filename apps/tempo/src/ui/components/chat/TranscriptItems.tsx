import type { AgentId, Item, ItemOf, Turn } from "@tempo/protocol";
import {
  AlertCircleIcon,
  ArrowRightLeftIcon,
  BanIcon,
  BrainIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleIcon,
  FileIcon,
  FileTextIcon,
  GlobeIcon,
  type LucideIcon,
  MessageSquareIcon,
  PaperclipIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldQuestionIcon,
  TerminalIcon,
  ToggleLeftIcon,
  Trash2Icon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Button } from "~/ui/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/ui/components/ui/collapsible";
import { Kbd } from "~/ui/components/ui/kbd";
import { Spinner } from "~/ui/components/ui/spinner";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useShortcuts } from "~/ui/hooks/useShortcuts";
import { formatDuration, formatTime } from "~/ui/lib/format";
import { isEditableTarget } from "~/ui/lib/shortcuts";
import { cn } from "~/ui/lib/utils";
import { CONFIRM_TEXT, confirm, openFile } from "~/ui/state/workspace-ui";
import { attachmentPreview } from "./attachment-cache";
import { reviewChipLabel } from "./composer-model";
import { BlockViewer, UnifiedDiff } from "./ContentBlocks";
import { toggleExpanded, useExpanded } from "./expand-store";
import { MessageMarkdown } from "./Markdown";
import {
  blockView,
  errorItemMessage,
  firstPermissionOption,
  isPermissionAnswered,
  locationLabel,
  planProgress,
  toolContentView,
  toolIcon,
  turnDuration,
  turnOutcome,
  workspacePath,
  type ToolIcon,
} from "./transcript-model";

export interface ItemContext {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly agent: AgentId | undefined;
  /** False when the workspace is archived or the chat is closed: no revert, retry or answers. */
  readonly writable: boolean;
  /** 03, Revert: only while no turn runs or waits in the queue. */
  readonly canRevert: boolean;
}

/** One transcript item, by kind (04, Transcript: how each item kind renders). */
export const ItemView = memo(function ItemView({
  ctx,
  item,
  turn,
}: {
  ctx: ItemContext;
  item: Item;
  turn: Turn | undefined;
}) {
  switch (item.kind) {
    case "user_message":
      return <UserMessage ctx={ctx} item={item} turn={turn} />;
    case "agent_message":
      return <AgentMessage ctx={ctx} item={item} />;
    case "agent_thought":
      return (
        <Collapsed label={item.status === "streaming" ? "Thinking…" : "Thinking"} text={item.content.text} />
      );
    case "tool_call":
      return <ToolCall ctx={ctx} item={item} />;
    case "plan":
      return <Plan item={item} />;
    case "permission":
      return <Permission ctx={ctx} item={item} />;
    case "notice":
      return <Notice item={item} />;
    case "handoff":
      return (
        <Collapsed label="Session restarted; transcript handed to the agent" text={item.content.text} mono />
      );
    case "revert_marker":
      return (
        <div role="separator" className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          <RotateCcwIcon className="size-3" />
          Reverted to turn {item.content.toTurnSeq}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "error":
      return <ErrorCard ctx={ctx} item={item} turn={turn} />;
  }
});

function UserMessage({
  ctx,
  item,
  turn,
}: {
  ctx: ItemContext;
  item: ItemOf<"user_message">;
  turn: Turn | undefined;
}) {
  const revert = useCallMutation("revertToCheckpoint");
  const { text, mentions, attachments, reviewCommentIds } = item.content;
  const checkpointId = turn?.checkpointId ?? null;
  const canRevert = ctx.writable && ctx.canRevert && checkpointId !== null && turn !== undefined;
  const onRevert = async () => {
    if (!turn || checkpointId === null) return;
    if (!(await confirm(CONFIRM_TEXT.revert(turn.seq)))) return;
    revert.mutate({ workspaceId: ctx.workspaceId, checkpointId });
  };
  return (
    <div className="group/user flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2">
        {text && <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>}
        {(mentions.length > 0 || attachments.length > 0 || reviewCommentIds.length > 0) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {mentions.map((m) => (
              <button
                key={m.path}
                type="button"
                onClick={() => openFile(ctx.workspaceId, m.path)}
                className="inline-flex max-w-60 items-center gap-1 rounded-sm border bg-background px-1.5 py-px text-xs hover:bg-accent"
              >
                <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{m.path}</span>
              </button>
            ))}
            {attachments.map((a) => {
              const preview = attachmentPreview(a.id);
              return preview ? (
                <img
                  key={a.id}
                  src={preview}
                  alt={a.name}
                  title={a.name}
                  className="size-16 rounded-sm border object-cover"
                />
              ) : (
                <span
                  key={a.id}
                  className="inline-flex max-w-60 items-center gap-1 rounded-sm border bg-background px-1.5 py-px text-xs"
                >
                  <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{a.name}</span>
                </span>
              );
            })}
            {reviewCommentIds.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-sm border bg-background px-1.5 py-px text-xs">
                <MessageSquareIcon className="size-3 text-muted-foreground" />
                {reviewChipLabel(reviewCommentIds.length)}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex h-5 items-center gap-2 text-xs text-muted-foreground opacity-0 transition-opacity group-focus-within/user:opacity-100 group-hover/user:opacity-100">
        <time dateTime={new Date(item.createdAt).toISOString()}>{formatTime(item.createdAt)}</time>
        {canRevert && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5"
            onClick={onRevert}
            disabled={revert.isPending}
          >
            <RotateCcwIcon />
            Revert to here
          </Button>
        )}
      </div>
    </div>
  );
}

function AgentMessage({ ctx, item }: { ctx: ItemContext; item: ItemOf<"agent_message"> }) {
  const streaming = item.status === "streaming";
  return (
    <div className="flex flex-col gap-2">
      {item.content.text !== "" && (
        <MessageMarkdown workspaceId={ctx.workspaceId} text={item.content.text} streaming={streaming} />
      )}
      {(item.content.blocks ?? []).map((b, i) => (
        <BlockViewer key={i} workspaceId={ctx.workspaceId} block={blockView(b)} />
      ))}
      {streaming && (
        <span aria-hidden className="inline-block h-3.5 w-1.5 animate-pulse rounded-[1px] bg-foreground/60" />
      )}
    </div>
  );
}

function Collapsed({ label, text, mono = false }: { label: string; text: string; mono?: boolean }) {
  return (
    <Collapsible className="group/c">
      <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/c:rotate-90" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p
          className={cn(
            "mt-1 max-h-96 overflow-auto border-l-2 pl-3 text-xs whitespace-pre-wrap text-muted-foreground",
            mono && "font-mono",
          )}
        >
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

const TOOL_ICONS: Record<ToolIcon, LucideIcon> = {
  read: FileTextIcon,
  edit: PencilIcon,
  delete: Trash2Icon,
  move: ArrowRightLeftIcon,
  search: SearchIcon,
  execute: TerminalIcon,
  think: BrainIcon,
  fetch: GlobeIcon,
  switch_mode: ToggleLeftIcon,
  other: WrenchIcon,
};

const STATUS_TEXT: Record<Item["status"], string> = {
  streaming: "Running",
  pending: "Pending",
  in_progress: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function StatusIcon({ status }: { status: Item["status"] }) {
  const label = STATUS_TEXT[status];
  switch (status) {
    case "in_progress":
    case "streaming":
      return <Spinner aria-label={label} className="text-primary" />;
    case "completed":
      return <CheckIcon aria-label={label} className="size-3.5 text-success" />;
    case "failed":
      return <XCircleIcon aria-label={label} className="size-3.5 text-destructive" />;
    case "cancelled":
      return <BanIcon aria-label={label} className="size-3.5 text-muted-foreground" />;
    case "pending":
      return <CircleDashedIcon aria-label={label} className="size-3.5 text-muted-foreground" />;
  }
}

const MAX_LOCATIONS = 5;

function ToolCall({ ctx, item }: { ctx: ItemContext; item: ItemOf<"tool_call"> }) {
  const open = useExpanded(ctx.sessionId, item.id);
  const { title, toolKind, locations, content, rawInput } = item.content;
  const Icon = TOOL_ICONS[toolIcon(toolKind)];
  const mono = toolKind === "execute";
  const hasBody = content.length > 0 || rawInput !== undefined;
  return (
    <div className="rounded-md border">
      <button
        type="button"
        aria-expanded={hasBody ? open : undefined}
        onClick={() => hasBody && toggleExpanded(ctx.sessionId, item.id)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
          hasBody ? "hover:bg-accent/60" : "cursor-default",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{title || "Tool call"}</span>
        <StatusIcon status={item.status} />
        {hasBody && (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {locations.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 px-2 pb-1 pl-7.5">
          {locations.slice(0, open ? undefined : MAX_LOCATIONS).map((loc, i) => (
            <button
              key={`${loc.path}:${loc.line ?? ""}:${i}`}
              type="button"
              onClick={() => openFile(ctx.workspaceId, workspacePath(loc.path) || loc.path, loc.line ?? null)}
              className="max-w-full truncate rounded-sm font-mono text-xs text-primary hover:underline"
            >
              {locationLabel(loc)}
            </button>
          ))}
          {!open && locations.length > MAX_LOCATIONS && (
            <span className="text-xs text-muted-foreground">+{locations.length - MAX_LOCATIONS} more</span>
          )}
        </div>
      )}
      {open && hasBody && (
        <div className="flex flex-col gap-2 border-t p-2">
          {content.map((c, i) => {
            const view = toolContentView(c);
            if (view.kind === "diff") {
              return (
                <UnifiedDiff
                  key={i}
                  workspaceId={ctx.workspaceId}
                  path={view.path}
                  oldText={view.oldText}
                  newText={view.newText}
                />
              );
            }
            if (view.kind === "terminal") {
              return (
                <p key={i} className="rounded-md bg-muted/50 p-2 font-mono text-xs">
                  Terminal {view.terminalId}
                </p>
              );
            }
            return <BlockViewer key={i} workspaceId={ctx.workspaceId} block={view.block} monospace={mono} />;
          })}
          {content.length === 0 && rawInput !== undefined && (
            <pre className="max-h-60 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
              {jsonText(rawInput)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const jsonText = (u: unknown): string => {
  try {
    const s = typeof u === "string" ? u : JSON.stringify(u, null, 2);
    return s.length > 20_000 ? `${s.slice(0, 20_000)}…` : s;
  } catch {
    return String(u);
  }
};

function Plan({ item }: { item: ItemOf<"plan"> }) {
  const { done, total } = planProgress(item.content.entries);
  return (
    <div className="rounded-md border px-2 py-1.5">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        Plan {done}/{total}
      </p>
      <ul className="flex flex-col gap-0.5">
        {item.content.entries.map((e, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {e.status === "completed" ? (
              <CheckCircle2Icon aria-label="Done" className="mt-0.5 size-3.5 shrink-0 text-success" />
            ) : e.status === "in_progress" ? (
              <Spinner aria-label="In progress" className="mt-0.5 text-primary" />
            ) : (
              <CircleIcon aria-label="To do" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn(e.status === "completed" && "text-muted-foreground line-through")}>
              {e.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Permission({ ctx, item }: { ctx: ItemContext; item: ItemOf<"permission"> }) {
  const ref = useRef<HTMLDivElement>(null);
  const respond = useCallMutation("respondPermission");
  const answered = isPermissionAnswered(item);
  const pending = !answered && ctx.writable;
  const { options, requestId, chosenOptionId } = item.content;
  const allow = firstPermissionOption(options, "allow");
  const reject = firstPermissionOption(options, "reject");
  const choose = (optionId: string) => {
    if (!respond.isPending) respond.mutate({ workspaceId: ctx.workspaceId, requestId, optionId });
  };
  useShortcuts(
    {
      permissionAllow: (e) => {
        if (e.target !== ref.current || !allow) return false;
        choose(allow.optionId);
      },
      permissionReject: (e) => {
        if (e.target !== ref.current || !reject) return false;
        choose(reject.optionId);
      },
    },
    { target: ref, enabled: pending },
  );
  useEffect(() => {
    if (pending && !isEditableTarget(document.activeElement)) ref.current?.focus({ preventScroll: true });
  }, [pending]);
  const chosen = options.find((o) => o.optionId === chosenOptionId);
  return (
    <div
      ref={ref}
      tabIndex={pending ? 0 : -1}
      role="group"
      aria-label={`Permission: ${item.content.title}`}
      className={cn(
        "rounded-md border p-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        pending ? "border-warning/60 bg-warning/5" : "opacity-80",
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldQuestionIcon
          className={cn("mt-0.5 size-4 shrink-0", pending ? "text-warning" : "text-muted-foreground")}
        />
        <p className="text-sm font-medium">{item.content.title}</p>
      </div>
      {answered ? (
        <p className="mt-1 pl-6 text-xs text-muted-foreground">
          {chosen ? `Chose: ${chosen.name}` : "Cancelled"}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
          {options.map((o) => (
            <Button
              key={o.optionId}
              size="sm"
              variant={o === allow ? "default" : o.kind.startsWith("reject") ? "outline" : "secondary"}
              disabled={!pending || respond.isPending}
              onClick={() => choose(o.optionId)}
            >
              {o.name}
              {o === allow && (
                <Kbd className="border-transparent bg-primary-foreground/20 text-current">Enter</Kbd>
              )}
              {o === reject && <Kbd>⌫</Kbd>}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Notice({ item }: { item: ItemOf<"notice"> }) {
  const { level, text } = item.content;
  return (
    <p
      role={level === "error" ? "alert" : undefined}
      className={cn(
        "px-4 text-center text-xs",
        level === "info" && "text-muted-foreground",
        level === "warning" && "text-warning",
        level === "error" && "text-destructive",
      )}
    >
      {text}
    </p>
  );
}

function ErrorCard({ ctx, item, turn }: { ctx: ItemContext; item: ItemOf<"error">; turn: Turn | undefined }) {
  const retry = useCallMutation("sendPrompt");
  const [showDetail, setShowDetail] = useState(false);
  const { code, detail } = item.content;
  const prompt = turn?.prompt;
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
      <div className="flex items-start gap-2">
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-sm">{errorItemMessage(code, ctx.agent)}</p>
          <p className="font-mono text-xs text-muted-foreground">{code}</p>
          {showDetail && detail && (
            <pre className="mt-1 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {detail}
            </pre>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {detail && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showDetail}
              onClick={() => setShowDetail((v) => !v)}
            >
              Details
            </Button>
          )}
          {prompt && ctx.writable && (
            <Button
              size="sm"
              variant="outline"
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate({
                  workspaceId: ctx.workspaceId,
                  sessionId: ctx.sessionId,
                  text: prompt.text,
                  mentions: prompt.mentions,
                  attachmentIds: prompt.attachmentIds,
                  reviewCommentIds: prompt.reviewCommentIds,
                })
              }
            >
              Retry
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Under each turn: its duration, and how it ended when that is not plain success. */
export function TurnFooter({ turn }: { turn: Turn }) {
  const ms = turnDuration(turn);
  const outcome = turnOutcome(turn);
  if (ms === null && outcome === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {[ms !== null ? formatDuration(ms) : null, outcome].filter(Boolean).join(" · ")}
    </p>
  );
}

/** The running turn: a spinner with the time so far. */
export function WorkingRow({ turn }: { turn: Turn }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const since = turn.startedAt ?? now;
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner aria-hidden className="text-primary" />
      Working {formatDuration(Math.max(1000, Math.floor((now - since) / 1000) * 1000))}
    </p>
  );
}
