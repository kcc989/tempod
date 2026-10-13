import { AgentProposalCard } from "./AgentProposalCard";
import { RunCard } from "./RunCard";
import { Match, Schema } from "effect";
import type { AgentId, Item, ItemOf, Turn } from "@tempo/protocol";
import {
  AlertCircleIcon,
  ArrowRightLeftIcon,
  BanIcon,
  BrainIcon,
  CheckCircle2Icon,
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
import { CONFIRM_TEXT, confirm, openFile, setPhonePane, showRightTab } from "~/ui/state/workspace-ui";
import { thumbnailSrc } from "./attachment-cache";
import { reviewChipLabel } from "./composer-model";
import { BlockViewer, UnifiedDiff } from "./ContentBlocks";
import { toggleExpanded, useExpanded } from "./expand-store";
import { ArtifactCard } from "~/ui/components/artifacts/ArtifactCard";
import { MessageMarkdown } from "./Markdown";
import { currentStep, editCounts, planProposalText, toolLabel, workSummary, workType } from "./work-model";
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
  turnTokens,
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
  permission,
}: {
  ctx: ItemContext;
  item: Item;
  turn: Turn | undefined;
  /** A plan proposal's permission item, shown under its card. */
  permission?: Item | undefined;
}) {
  switch (item.kind) {
    case "run":
      return (
        <RunCard
          workspaceId={ctx.workspaceId}
          runId={item.content.runId}
          canRevert={ctx.canRevert}
          writable={ctx.writable}
        />
      );
    case "agent_proposal":
      return (
        <AgentProposalCard
          workspaceId={ctx.workspaceId}
          proposalId={item.content.proposalId}
          writable={ctx.writable}
        />
      );
    case "user_message":
      return <UserMessage ctx={ctx} item={item} turn={turn} />;
    case "agent_message":
      return <AgentMessage ctx={ctx} item={item} />;
    case "agent_thought":
      return (
        <Collapsed label={item.status === "streaming" ? "Thinking…" : "Thinking"} text={item.content.text} />
      );
    case "tool_call": {
      const plan = planProposalText(item);

      if (plan !== null)
        return (
          <PlanProposal
            ctx={ctx}
            plan={plan}
            permission={permission?.kind === "permission" ? permission : undefined}
          />
        );

      return <ToolCall ctx={ctx} item={item} />;
    }

    case "plan":
      return <Plan item={item} />;
    case "permission":
      return <Permission ctx={ctx} item={item} />;
    case "notice":
      return <Notice item={item} ctx={ctx} />;
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
    case "artifact":
      return <ArtifactCard workspaceId={ctx.workspaceId} item={item} />;
  }
});

/** 04 Plan proposals: the plan as Markdown, expanded, with its permission's buttons under it. */
function PlanProposal({
  ctx,
  plan,
  permission,
}: {
  ctx: ItemContext;
  plan: string;
  permission: ItemOf<"permission"> | undefined;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <p className="text-xs font-medium text-muted-foreground">Plan</p>
      <MessageMarkdown workspaceId={ctx.workspaceId} text={plan} streaming={false} />
      {permission && <Permission ctx={ctx} item={permission} />}
    </div>
  );
}

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
            {attachments.map((a) => (
              <AttachmentThumb key={a.id} workspaceId={ctx.workspaceId} attachment={a} />
            ))}
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
      return null;
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
  const failed = item.status === "failed";
  const open = useExpanded(ctx.sessionId, item.id, failed);
  const { title, toolKind, locations, content, rawInput } = item.content;
  const Icon = TOOL_ICONS[toolIcon(toolKind)];
  const mono = toolKind === "execute";
  const hasBody = content.length > 0 || rawInput !== undefined;
  const label = toolLabel(item);
  const edit = workType(item) === "edit" ? editCounts(item) : null;

  return (
    <div className="min-w-0">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={hasBody ? open : undefined}
          onClick={() => hasBody && toggleExpanded(ctx.sessionId, item.id, failed)}
          title={title || undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
            hasBody ? "hover:bg-accent/60" : "cursor-default",
          )}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 flex-1 truncate", label.mono && "font-mono text-xs")}>
            {edit?.path ? workspacePath(edit.path).split("/").pop() || label.text : label.text}
          </span>
          {edit && (
            <span className="shrink-0 font-mono text-xs">
              <span className="text-success">+{edit.added}</span>{" "}
              <span className="text-destructive">−{edit.removed}</span>
            </span>
          )}
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
        {edit && (
          <Button
            size="sm"
            variant="link"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => {
              showRightTab(ctx.workspaceId, "changes");
              setPhonePane("changes");
            }}
          >
            Changes
          </Button>
        )}
      </div>
      {locations.length > 0 && !edit && (
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
        <div className="flex min-w-0 flex-col gap-2 pt-1 pr-2 pb-2 pl-7.5">
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

            return (
              <BlockViewer
                key={i}
                workspaceId={ctx.workspaceId}
                block={view.block}
                monospace={mono}
                markdown
                streaming={item.status === "streaming" || item.status === "in_progress"}
              />
            );
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

const jsonText = <T,>(u: T): string => {
  try {
    const s = Schema.is(Schema.String)(u) ? u : (JSON.stringify(u, null, 2) ?? String(u));

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
            {Match.value(e).pipe(
              Match.when({ status: "completed" }, () => (
                <CheckCircle2Icon aria-label="Done" className="mt-0.5 size-3.5 shrink-0 text-success" />
              )),
              Match.when({ status: "in_progress" }, () => (
                <Spinner aria-label="In progress" className="mt-0.5 text-primary" />
              )),
              Match.orElse(() => (
                <CircleIcon aria-label="To do" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              )),
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

function Notice({ item, ctx }: { item: ItemOf<"notice">; ctx: ItemContext }) {
  const revert = useCallMutation("revertToCheckpoint");
  const { level, text } = item.content;
  const request = useCallMutation("requestAgent", { invalidates: ["listRuns", "listLifecycleEvents"] });

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
      {item.content.agentId && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!ctx.writable || request.isPending}
          onClick={() =>
            request.mutate({
              workspaceId: ctx.workspaceId,
              sessionId: ctx.sessionId,
              agentId: item.content.agentId!,
            })
          }
        >
          Run anyway
        </Button>
      )}
      {item.content.checkpointId && (
        <Button
          variant="ghost"
          size="sm"
          disabled={revert.isPending}
          onClick={() =>
            revert.mutate({ workspaceId: ctx.workspaceId, checkpointId: item.content.checkpointId! })
          }
        >
          Revert
        </Button>
      )}
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

function AttachmentThumb({
  workspaceId,
  attachment,
}: {
  workspaceId: string;
  attachment: { id: string; name: string; mime: string };
}) {
  const [failed, setFailed] = useState(false);
  const src = failed ? undefined : thumbnailSrc(workspaceId, attachment);

  return src ? (
    <img
      src={src}
      alt={attachment.name}
      title={attachment.name}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-16 rounded-sm border object-cover"
    />
  ) : (
    <span className="inline-flex max-w-60 items-center gap-1 rounded-sm border bg-background px-1.5 py-px text-xs">
      <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{attachment.name}</span>
    </span>
  );
}

/**
 * Under each turn: its duration, unless its work row shows it, its tokens when the agent sent usage,
 * and how it ended when that is not plain success.
 */
export function TurnFooter({ turn, worked = false }: { turn: Turn; worked?: boolean }) {
  const ms = worked ? null : turnDuration(turn);
  const tokens = turnTokens(turn);
  const outcome = turnOutcome(turn);

  if (ms === null && tokens === null && outcome === null) return null;

  return (
    <p className="text-xs text-muted-foreground">
      {[ms !== null ? formatDuration(ms) : null, tokens, outcome].filter(Boolean).join(" · ")}
    </p>
  );
}

/** Seconds since `since`, ticking while mounted. */
function useElapsed(since: number | null, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(t);
  }, [live]);

  return Math.max(1000, Math.floor((now - (since ?? now)) / 1000) * 1000);
}

/** One row per turn for its reads, commands and thoughts (04, Work row). */
export function WorkRow({ ctx, turn, items }: { ctx: ItemContext; turn: Turn; items: ReadonlyArray<Item> }) {
  const id = `work:${turn.id}`;
  const running = turn.status === "running";
  const open = useExpanded(ctx.sessionId, id, running);
  const elapsed = useElapsed(turn.startedAt, running);

  const text = running
    ? [currentStep(items) ?? "Working", formatDuration(elapsed)].join(" · ")
    : workSummary(items, turnDuration(turn));

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggleExpanded(ctx.sessionId, id, running)}
        className="flex max-w-full items-center gap-1.5 rounded-sm py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {running ? (
          <Spinner aria-label="Running" className="text-primary" />
        ) : (
          <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        )}
        <span className="min-w-0 truncate">{text}</span>
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1.5 border-l-2 pl-3">
          {items.map((item) => (
            <ItemView key={item.id} ctx={ctx} item={item} turn={turn} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The running turn: a spinner with the time so far. */
export function WorkingRow({ turn }: { turn: Turn }) {
  const elapsed = useElapsed(turn.startedAt, true);

  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner aria-hidden className="text-primary" />
      Working {formatDuration(elapsed)}
    </p>
  );
}
