import { Schema } from "effect";
import { isErrorBody, TempoError, API, type ConfigOption, type Session } from "@tempo/protocol";
import { useIsMutating } from "@tanstack/react-query";
import { ArchiveRestoreIcon, ArrowUpIcon, PlusIcon, SquareIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/ui/components/ui/button";
import { Textarea } from "~/ui/components/ui/textarea";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useAction } from "~/ui/hooks/useActions";
import { useBanner } from "~/ui/hooks/useBanner";
import { useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useCredentialStatus } from "~/ui/hooks/useCredentialStatus";
import { useShortcuts } from "~/ui/hooks/useShortcuts";
import { useWorkspaceSelector, useWorkspaceStore } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import {
  AGENT_PROVIDERS,
  agentLabel,
  hasLogin,
  isPlanMode,
  planModeId,
  togglePlanTarget,
} from "~/ui/lib/agents";
import { formatBinding } from "~/ui/lib/shortcuts";
import { errorText, toastError } from "~/ui/lib/toast";
import { fuzzyFilter } from "~/ui/lib/fuzzy";
import { cn } from "~/ui/lib/utils";
import { getWorkspaceUi, takeInsertions, workspaceUiStore } from "~/ui/state/workspace-ui";
import { reorderedQueue, runningPlan } from "~/ui/stores/workspace-state";
import {
  finishAttachmentUpload,
  isPreviewable,
  rememberAttachment,
  startAttachmentUpload,
} from "./attachment-cache";
import { runningTurnOf } from "./chat-tabs-model";
import { useComposerDraft } from "./useComposerDraft";
import {
  applyInsertions,
  canSend,
  configPickers,
  profileIssuesText,
  contextUsage,
  mentionTrigger,
  moveIndex,
  replaceTrigger,
  slashEntries,
  slashTrigger,
  splitBySize,
} from "./composer-model";
import {
  AttachmentChip,
  ContextRing,
  LoginBanner,
  ProfileIssuesNotice,
  MentionChip,
  LevelPicker,
  ModelPicker,
  ModePicker,
  OptionsMenu,
  PickerList,
  PlanModeBadge,
  PlanPill,
  QueuedChip,
  ReviewChip,
  type PendingAttachment,
  type PickerRow,
} from "./ComposerParts";
import { EnvironmentProposalBanner } from "./EnvironmentProposals";

export interface ComposerProps {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** 04, Composer. Archived workspaces show `Restore to continue`; closed chats are read-only. */
/** Sessions whose profile-issues notice was dismissed; kept in memory only (04, browser storage). */
const dismissedProfileIssues = new Set<string>();

export function Composer({ workspaceId, sessionId }: ComposerProps) {
  const state = useWorkspaceSelector(workspaceId, (s) => s.workspace?.state);
  const session = useWorkspaceSelector(workspaceId, (s) => s.sessions[sessionId]);

  if (state === "archived" || state === "archiving") return <RestoreBar workspaceId={workspaceId} />;

  if (!session) return null;

  if (session.status === "closed") {
    return (
      <p className="shrink-0 border-t px-3 py-2 text-center text-sm text-muted-foreground">
        This chat is closed.
      </p>
    );
  }

  if (session.runId) return <RunComposer workspaceId={workspaceId} session={session} />;

  return <ComposerBody key={sessionId} workspaceId={workspaceId} session={session} />;
}

function RunComposer({ workspaceId, session }: { workspaceId: string; session: Session }) {
  const live = useWorkspaceSelector(workspaceId, (s) => (session.runId ? s.runs[session.runId] : undefined));

  const runs = useCallQuery("listRuns", { workspaceId });
  const cancel = useCallMutation("cancelRun", { invalidates: ["listRuns"] });
  const run = live ?? runs.data?.find((r) => r.id === session.runId);

  if (!run || run.status === "running" || run.status === "queued")
    return (
      <div className="flex items-center justify-between border-t p-3">
        <span>{run ? `${run.name} · ${run.status}` : "Loading run…"}</span>
        <Button
          disabled={!run || cancel.isPending}
          onClick={() => cancel.mutate({ workspaceId, runId: session.runId! })}
        >
          Cancel run
        </Button>
      </div>
    );

  return <ComposerBody key={session.id} workspaceId={workspaceId} session={session} />;
}

function RestoreBar({ workspaceId }: { workspaceId: string }) {
  const restore = useCallMutation("restoreWorkspace");

  return (
    <div className="flex shrink-0 items-center justify-center border-t p-3">
      <Button onClick={() => restore.mutate({ workspaceId })} disabled={restore.isPending}>
        <ArchiveRestoreIcon />
        Restore to continue
      </Button>
    </div>
  );
}

/** Composer focus requests already handled, per workspace (⌥L and insertions bump the counter). */
const handledFocus = new Map<string, number>();

const uploadAttachment = async (
  workspaceId: string,
  file: File,
): Promise<{ attachmentId: string; name: string; mime: string; size: number }> => {
  const form = new FormData();
  form.append("file", file, file.name);

  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`, {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) throw isErrorBody(body) ? TempoError.fromBody(body) : new TempoError("INTERNAL");

  return Schema.decodeUnknownSync(
    Schema.Struct({
      attachmentId: Schema.String,
      name: Schema.String,
      mime: Schema.String,
      size: Schema.Number,
    }),
  )(body);
};

const triggerKeyOf = (text: string, caret: number): string | null => {
  const t = slashTrigger(text, caret) ?? mentionTrigger(text, caret);

  return t ? `${text[t.start] === "@" ? "mention" : "slash"}:${t.start}` : null;
};

function ComposerBody({ workspaceId, session }: { workspaceId: string; session: Session }) {
  const sessionId = session.id;
  const store = useWorkspaceStore(workspaceId);
  const turns = useWorkspaceSelector(workspaceId, (s) => s.turns);
  const credentialInvalid = useWorkspaceSelector(workspaceId, (s) => s.credentialInvalid);

  const plan = useWorkspaceSelector(workspaceId, (s) => {
    const p = runningPlan(s, sessionId);

    return p ? `${p.done}/${p.total}` : null;
  });

  const workspaceBusy = useWorkspaceSelector(workspaceId, (s) => s.workspace?.runningTurnId ?? null) !== null;
  const sleeping = useWorkspaceSelector(workspaceId, (s) => s.workspace?.state === "sleeping");
  const focusSeq = useWorkspaceUiSelector(workspaceId, (s) => s.composerFocusSeq);
  const { draft: savedDraft, update, clearSent } = useComposerDraft(workspaceId, sessionId);
  const { text: draft, mentions, reviewCommentIds, attachments } = savedDraft;
  const setDraft = (next: string | ((value: string) => string)) => update("text", next);

  const setMentions = (next: typeof mentions | ((value: typeof mentions) => typeof mentions)) =>
    update("mentions", next);

  const setReviewCommentIds = (
    next: typeof reviewCommentIds | ((value: typeof reviewCommentIds) => typeof reviewCommentIds),
  ) => update("reviewCommentIds", next);

  const setAttachments = (next: typeof attachments | ((value: typeof attachments) => typeof attachments)) =>
    update("attachments", next);

  const sending = useRef(false);
  const sentDraft = useRef(savedDraft);

  const sendPending =
    useIsMutating({
      mutationKey: ["call", "sendPrompt"],
      predicate: (mutation) => {
        const input = Schema.is(API.sendPrompt.input)(mutation.state.variables)
          ? mutation.state.variables
          : undefined;

        return input?.workspaceId === workspaceId && input.sessionId === sessionId;
      },
    }) > 0;

  const [caret, setCaret] = useState(0);
  const [, rerender] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState({ key: "", index: 0 });
  const [modelOpen, setModelOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const draggedTurn = useRef<string | null>(null);
  const previousMode = useRef<string | null>(null);
  const pickerId = useId();

  const send = useCallMutation("sendPrompt", {
    invalidates: ["listReviewComments"],
    onSuccess: () => {
      clearSent(sentDraft.current);
      sending.current = false;
    },
    onError: () => {
      sending.current = false;
    },
  });

  const agents = useCallQuery("listAgents", {});
  const projectId = useWorkspaceSelector(workspaceId, (s) => s.workspace?.projectId);

  const attachmentsQuery = useCallQuery(
    "listProjectAgents",
    { projectId: projectId ?? "" },
    { enabled: !!projectId },
  );

  const requestAgent = useCallMutation("requestAgent", {
    invalidates: ["listRuns", "listLifecycleEvents"],
    onSuccess: () => {
      clearSent(sentDraft.current);
      sending.current = false;
    },
    onError: () => {
      sending.current = false;
    },
  });

  const cancel = useCallMutation("cancelTurn");
  const setMode = useCallMutation("setSessionMode");
  const setConfig = useCallMutation("setSessionConfig");
  const editQueued = useCallMutation("editQueuedTurn");
  const deleteQueued = useCallMutation("deleteQueuedTurn");
  const reorder = useCallMutation("reorderQueue");
  const running = runningTurnOf(turns, sessionId);

  const queued = useMemo(
    () =>
      Object.values(turns)
        .filter((t) => t.status === "queued" && t.sessionId === sessionId)
        .sort((a, b) => (a.queuePos ?? Infinity) - (b.queuePos ?? Infinity) || a.queuedAt - b.queuedAt),
    [turns, sessionId],
  );

  const pickers = configPickers(session);
  const planId = planModeId(session);
  const inPlan = isPlanMode(session);
  const usage = contextUsage(session.usage);
  const uploading = attachments.some((a) => a.status === "uploading");
  const ready = attachments.filter((a) => a.status === "ready" && a.attachmentId !== undefined);

  const sendable = canSend({
    text: draft,
    attachmentCount: ready.length,
    reviewCommentCount: reviewCommentIds.length,
    uploading,
  });

  const pickersDisabled = running !== undefined || session.status === "starting";
  // Logins (04: missing login banner; credential.invalid banner).
  const creds = useCredentialStatus().data;
  const providers = AGENT_PROVIDERS[session.agent];
  const invalid = credentialInvalid.some((p) => providers.includes(p));
  const missing = !invalid && creds !== undefined && !hasLogin(session.agent, creds);
  useBanner(["CREDENTIAL_INVALID"], invalid);
  useBanner(["CREDENTIAL_MISSING"], missing);
  const stamp = creds ? providers.map((p) => creds[p].updatedAt ?? 0).join(",") : null;
  const stampWhenInvalid = useRef<string | null>(null);
  useEffect(() => {
    if (!invalid) {
      stampWhenInvalid.current = null;

      return;
    }

    if (stamp === null) return;

    if (stampWhenInvalid.current === null) stampWhenInvalid.current = stamp;
    else if (stamp !== stampWhenInvalid.current) store.clearCredentialInvalid(providers);
  }, [invalid, stamp, store, providers]);

  // Chips and text from other regions (review comments, mentions).
  const drain = useEffectEvent(() => {
    if (getWorkspaceUi(workspaceId).insertions.length === 0) return;
    const taken = takeInsertions(workspaceId, sessionId);

    if (taken.length === 0) return;
    const next = applyInsertions({ text: draft, mentions, reviewCommentIds }, taken);

    if (next.text !== draft) setDraft(next.text);
    setMentions(next.mentions);
    setReviewCommentIds(next.reviewCommentIds);
  });

  useEffect(() => {
    queueMicrotask(() => drain());

    return workspaceUiStore(workspaceId).subscribe(() => drain());
  }, [workspaceId]);
  useEffect(() => {
    if (focusSeq > (handledFocus.get(workspaceId) ?? 0)) {
      handledFocus.set(workspaceId, focusSeq);
      textRef.current?.focus();
    }
  }, [focusSeq, workspaceId]);
  useLayoutEffect(() => {
    const at = pendingCaret.current;

    if (at === null || !textRef.current) return;
    pendingCaret.current = null;
    textRef.current.setSelectionRange(at, at);
    setCaret(at);
  }, [draft]);
  // The @ file picker and the / command menu.
  const trigger = slashTrigger(draft, caret) ?? mentionTrigger(draft, caret);
  const triggerKind = trigger ? (draft[trigger.start] === "@" ? "mention" : "slash") : null;
  const triggerKey = triggerKeyOf(draft, caret);

  const files = useCallQuery(
    "listFiles",
    { workspaceId },
    {
      enabled: triggerKind === "mention",
      staleTime: 30_000,
      retry: false,
    },
  );

  const query = trigger?.query ?? null;

  const rows: PickerRow[] = useMemo(() => {
    if (query === null) return [];

    if (triggerKind === "mention") {
      const attached = new Set(attachmentsQuery.data?.map((row) => row.agentId));
      const library = agents.data ?? [];

      const agentRows: PickerRow[] = [
        ...fuzzyFilter(
          query,
          library.filter((a) => attached.has(a.id)),
          (a) => a.handle,
          20,
        ),
        ...fuzzyFilter(
          query,
          library.filter((a) => !attached.has(a.id)),
          (a) => a.handle,
          20,
        ),
      ].map((a) => ({ kind: "agent", key: `agent:${a.id}`, name: a.handle, description: a.description }));

      return [
        ...agentRows,
        ...fuzzyFilter(query, files.data?.paths ?? [], (p) => p, 30).map((path) => ({
          kind: "file" as const,
          key: path,
          path,
        })),
      ];
    }

    return slashEntries(session.commands, planId !== null, query).map((entry) => ({
      kind: "command" as const,
      key: entry.key,
      entry,
    }));
  }, [query, triggerKind, files.data, agents.data, attachmentsQuery.data, session.commands, planId]);

  const pickerStatus =
    triggerKind !== "mention"
      ? null
      : files.isPending
        ? "Loading files"
        : files.isError
          ? errorText(files.error)
          : rows.length === 0
            ? "No matching files."
            : null;

  const pickerOpen =
    trigger !== null &&
    triggerKey !== dismissed &&
    (rows.length > 0 || (triggerKind === "mention" && pickerStatus !== null));

  const activeKey = trigger ? `${triggerKey}:${trigger.query}` : "";
  const activeIndex = active.key === activeKey ? Math.min(active.index, Math.max(0, rows.length - 1)) : 0;

  const togglePlan = () => {
    const target = togglePlanTarget(session, previousMode.current);

    if (!target) return;

    if (!inPlan) previousMode.current = session.modeId;
    setMode.mutate({ workspaceId, sessionId, modeId: target });
  };

  const pick = (index: number) => {
    const row = rows[index];

    if (!row || !trigger) return;

    if (row.kind === "agent") {
      if (/^\s*\/agent\b/.test(draft)) return;
      const next = replaceTrigger(draft, caret, trigger, "");
      setDraft(`/agent ${row.name} ${next.text}`);
      pendingCaret.current = `/agent ${row.name} `.length + next.caret;
    } else if (row.kind === "file") {
      const next = replaceTrigger(draft, caret, trigger, "");
      setDraft(next.text);
      pendingCaret.current = next.caret;
      setMentions((m) => (m.some((x) => x.path === row.path) ? m : [...m, { path: row.path }]));
    } else if (row.entry.kind === "plan") {
      const next = replaceTrigger(draft, caret, trigger, "");
      setDraft(next.text);
      pendingCaret.current = next.caret;
      togglePlan();
    } else {
      const next = replaceTrigger(draft, caret, trigger, `/${row.entry.name} `);
      setDraft(next.text);
      pendingCaret.current = next.caret;
    }
  };

  const submit = (delivery: "queue" | "steer" = "queue") => {
    if (!sendable || sending.current || sendPending || requestAgent.isPending) return;
    sending.current = true;
    sentDraft.current = savedDraft;

    if (/^\s*\/agent\b/.test(draft)) {
      const request = /^\s*\/agent\s+([a-z][a-z0-9-]{1,31})(?:\s+([\s\S]*))?$/.exec(draft);

      if (!request || mentions.length || ready.length || reviewCommentIds.length) {
        sending.current = false;
        toast.error("Use /agent <handle> <text>, with one agent per message.");

        return;
      }

      const agent = agents.data?.find((a) => a.handle === request[1]);

      if (!agent) {
        sending.current = false;
        toast.error("No agent with that handle.");

        return;
      }

      requestAgent.mutate({ workspaceId, sessionId, agentId: agent.id, text: request[2] });

      return;
    }

    send.mutate({
      workspaceId,
      sessionId,
      text: draft.trim(),
      mentions: [...mentions],
      attachmentIds: ready.map((a) => a.attachmentId!),
      reviewCommentIds: [...reviewCommentIds],
      delivery,
    });
  };

  const stop = () => {
    if (running) cancel.mutate({ workspaceId, turnId: running.id });
  };

  useAction("stop", stop, { enabled: !!running });
  useAction("togglePlan", () => togglePlan(), { enabled: planId !== null && !pickersDisabled });
  useShortcuts(
    {
      send: () => {
        if (pickerOpen && rows.length > 0) {
          pick(activeIndex);

          return;
        }

        submit();
      },
      newLine: () => false,
      stop: () => {
        if (pickerOpen && triggerKey) {
          setDismissed(triggerKey);

          return;
        }

        if (!running) return false;
        stop();
      },
      togglePlan: () => {
        if (planId === null || pickersDisabled) return false;
        togglePlan();
      },
    },
    { target: textRef, allowPlainInEditable: true },
  );

  const addFiles = (list: ReadonlyArray<File>) => {
    const { ok, tooLarge } = splitBySize(list);

    if (tooLarge.length > 0) toast.error("Each file can be at most 10 MiB.");

    for (const file of ok) {
      const localId = crypto.randomUUID();
      const preview = isPreviewable(file.type) ? URL.createObjectURL(file) : undefined;
      startAttachmentUpload(localId, preview);
      setAttachments((a) => [
        ...a,
        {
          localId,
          name: file.name,
          mime: file.type,
          size: file.size,
          preview,
          status: "uploading",
          attachmentId: undefined,
        },
      ]);
      uploadAttachment(workspaceId, file)
        .then((r) => {
          finishAttachmentUpload(localId);

          if (preview) rememberAttachment(r.attachmentId, preview);
          setAttachments((a) =>
            a.map((x) =>
              x.localId === localId ? { ...x, status: "ready", attachmentId: r.attachmentId } : x,
            ),
          );
        })
        .catch((cause: unknown) => {
          finishAttachmentUpload(localId);

          if (preview) URL.revokeObjectURL(preview);
          toastError(cause);
          setAttachments((a) => a.map((x) => (x.localId === localId ? { ...x, status: "failed" } : x)));
        });
    }
  };

  const removeAttachment = (a: PendingAttachment) => {
    if (a.preview && a.attachmentId === undefined) URL.revokeObjectURL(a.preview);
    setAttachments((list) => list.filter((x) => x.localId !== a.localId));
  };

  useAction("attach", () => fileRef.current?.click());
  useAction("modelPicker", () => setModelOpen(true), {
    enabled: pickers.model !== undefined && !pickersDisabled,
  });

  const onConfig = (option: ConfigOption, value: string | boolean) =>
    setConfig.mutate({ workspaceId, sessionId, configId: option.id, value });

  const refocus = () => textRef.current?.focus();

  const moveQueued = (turnId: string, toIndex: number) => {
    const turnIds = reorderedQueue(store.getSnapshot(), sessionId, turnId, toIndex);
    reorder.mutate({ workspaceId, turnIds });
  };

  const label = agentLabel(session.agent);

  const loginText = invalid
    ? `Your ${label} login stopped working. Add it again.`
    : missing
      ? `Add your ${label} login in Settings.`
      : null;

  const issuesText = profileIssuesText(session);
  const hasChips = mentions.length > 0 || reviewCommentIds.length > 0 || attachments.length > 0;

  return (
    <div className="shrink-0">
      <EnvironmentProposalBanner workspaceId={workspaceId} />
      {loginText && <LoginBanner text={loginText} />}
      {issuesText && !dismissedProfileIssues.has(sessionId) && (
        <ProfileIssuesNotice
          text={issuesText}
          onDismiss={() => {
            dismissedProfileIssues.add(sessionId);
            rerender((n) => n + 1);
          }}
        />
      )}
      <div
        className="relative px-3 pt-2 pb-3"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null))
            setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(false);
          addFiles([...e.dataTransfer.files]);
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {(plan !== null || inPlan || queued.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Queued messages">
              {plan !== null && <PlanPill progress={plan} />}
              {inPlan && <PlanModeBadge />}
              {queued.map((t, i) => (
                <QueuedChip
                  key={t.id}
                  turn={t}
                  onSave={(text) => editQueued.mutate({ workspaceId, turnId: t.id, text })}
                  onDelete={() => deleteQueued.mutate({ workspaceId, turnId: t.id })}
                  onMove={(delta) => moveQueued(t.id, moveIndex(queued.length, i, delta))}
                  onDragStart={() => {
                    draggedTurn.current = t.id;
                  }}
                  onDrop={() => {
                    const from = draggedTurn.current;
                    draggedTurn.current = null;

                    if (from && from !== t.id) moveQueued(from, i);
                  }}
                />
              ))}
            </div>
          )}
          <div
            className={cn(
              "rounded-2xl border border-input bg-muted p-3 shadow-md",
              dragging && "border-ring bg-accent/40 ring-2 ring-ring/20",
            )}
          >
            {hasChips && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {reviewCommentIds.length > 0 && (
                  <ReviewChip count={reviewCommentIds.length} onRemove={() => setReviewCommentIds([])} />
                )}
                {mentions.map((m) => (
                  <MentionChip
                    key={m.path}
                    path={m.path}
                    onRemove={() => setMentions((list) => list.filter((x) => x.path !== m.path))}
                  />
                ))}
                {attachments.map((a) => (
                  <AttachmentChip key={a.localId} a={a} onRemove={() => removeAttachment(a)} />
                ))}
              </div>
            )}
            <div className="relative">
              <span
                className="pointer-events-none absolute top-0 right-0 hidden text-xs text-muted-foreground/70 sm:block"
                aria-hidden="true"
              >
                {formatBinding("focusComposer")} to focus
              </span>
              {sendPending && (
                <p role="status" className="pb-1 text-xs text-muted-foreground">
                  Saving message…
                </p>
              )}
              {pickerOpen && (
                <PickerList
                  id={pickerId}
                  rows={rows}
                  activeIndex={activeIndex}
                  status={pickerStatus}
                  onPick={pick}
                  onRetry={
                    triggerKind === "mention" && files.isError ? () => void files.refetch() : undefined
                  }
                />
              )}
              {/^\s*\/agent\s+([a-z][a-z0-9-]{1,31})/.exec(draft)?.[1] && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Remove agent"
                  onClick={() => setDraft(draft.replace(/^\s*\/agent\s+[a-z][a-z0-9-]{1,31}\s*/, ""))}
                >
                  @{/^\s*\/agent\s+([a-z][a-z0-9-]{1,31})/.exec(draft)?.[1]}
                </Button>
              )}
              <Textarea
                ref={textRef}
                value={draft}
                rows={1}
                placeholder={
                  workspaceBusy
                    ? `Queue a message for ${label}`
                    : sleeping
                      ? `Message ${label} to wake this workspace`
                      : "Ask to make changes, @mention files, run /commands"
                }
                aria-label="Message"
                aria-autocomplete="list"
                aria-expanded={pickerOpen}
                aria-controls={pickerOpen ? pickerId : undefined}
                aria-activedescendant={
                  pickerOpen && rows.length > 0 ? `${pickerId}-${activeIndex}` : undefined
                }
                onChange={(e) => {
                  const text = e.target.value;
                  const at = e.target.selectionStart;
                  setDraft(text);
                  setCaret(at);

                  if (dismissed !== null && dismissed !== triggerKeyOf(text, at)) setDismissed(null);
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyDown={(e) => {
                  if (!pickerOpen || rows.length === 0) return;

                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    setActive({ key: activeKey, index: (activeIndex + delta + rows.length) % rows.length });
                  } else if (e.key === "Tab" && !e.shiftKey) {
                    e.preventDefault();
                    pick(activeIndex);
                  }
                }}
                onPaste={(e) => {
                  const pasted = [...e.clipboardData.files];

                  if (pasted.length === 0) return;

                  if (!e.clipboardData.getData("text/plain")) e.preventDefault();
                  addFiles(pasted);
                }}
                className="max-h-72 min-h-16 resize-none rounded-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent sm:pr-28"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2">
              {pickers.model && (
                <ModelPicker
                  option={pickers.model}
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                  disabled={pickersDisabled}
                  onPick={(v) => onConfig(pickers.model!, v)}
                  onClosed={refocus}
                />
              )}
              {pickers.thoughtLevel && (
                <LevelPicker
                  option={pickers.thoughtLevel}
                  disabled={pickersDisabled}
                  onPick={(v) => onConfig(pickers.thoughtLevel!, v)}
                  onClosed={refocus}
                />
              )}
              <ModePicker
                session={session}
                modeOption={pickers.modeOption}
                disabled={pickersDisabled}
                onMode={(modeId) => setMode.mutate({ workspaceId, sessionId, modeId })}
                onConfig={onConfig}
                onClosed={refocus}
              />
              <OptionsMenu
                options={pickers.others}
                disabled={pickersDisabled}
                onConfig={onConfig}
                onClosed={refocus}
              />
              <div className="ml-auto flex items-center gap-2">
                <SimpleTooltip label={`Attach a file (${formatBinding("attach")})`}>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="rounded-lg text-muted-foreground"
                    aria-label="Attach a file"
                    onClick={() => fileRef.current?.click()}
                  >
                    <PlusIcon className="size-5" />
                  </Button>
                </SimpleTooltip>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    addFiles([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
                {usage && <ContextRing usage={usage} />}
                {running && (
                  <SimpleTooltip label="Stop (Esc)">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="rounded-lg"
                      aria-label="Stop"
                      onClick={stop}
                      disabled={cancel.isPending}
                    >
                      <SquareIcon className="fill-current" />
                    </Button>
                  </SimpleTooltip>
                )}
                <Button
                  size="icon"
                  className="rounded-lg disabled:bg-muted-foreground/25 disabled:text-muted-foreground disabled:opacity-100"
                  aria-label={workspaceBusy ? "Queue" : "Send"}
                  onClick={() => submit()}
                  disabled={!sendable || sendPending}
                >
                  <ArrowUpIcon className="size-4" />
                </Button>
                {running && session.steering === true && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => submit("steer")}
                    disabled={!sendable || sendPending}
                  >
                    Send now
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
