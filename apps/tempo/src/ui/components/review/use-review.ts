import type { ChangedFile, DiffScope, WorkspaceState } from "@tempo/protocol";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { callKey, useCallMutation, useCallQuery } from "~/ui/hooks/useCall";
import { useHubWorkspace } from "~/ui/hooks/useHub";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useWorkspaceUiSelector } from "~/ui/hooks/useWorkspaceUi";
import { errorCode } from "~/ui/lib/toast";
import { changesView, isLive, type ChangesSource } from "./changes-model";
import { drafts } from "./diff-model";

const NOT_READY_RETRY_MS = 3_000;

/** Polls while a read call answers CONTAINER_NOT_READY (the call also starts a wake). */
export const retryWhileWaking = (query: { state: { error: Error | null } }): number | false =>
  query.state.error && errorCode(query.state.error) === "CONTAINER_NOT_READY" ? NOT_READY_RETRY_MS : false;

/** The workspace state from the channel, else from the hub. */
export function useWorkspaceStateValue(workspaceId: string): WorkspaceState | undefined {
  const detail = useWorkspaceSelector(workspaceId, (s) => s.workspace?.state);
  const summary = useHubWorkspace(workspaceId)?.state;
  return detail ?? summary;
}

/** True while read calls that need the container can run without waking it. */
export function useLive(workspaceId: string): boolean {
  return isLive(useWorkspaceStateValue(workspaceId));
}

export interface ChangesResult {
  readonly scope: DiffScope;
  readonly source: ChangesSource;
  readonly files: ReadonlyArray<ChangedFile>;
  readonly hasList: boolean;
  readonly live: boolean;
  readonly fetching: boolean;
  readonly error: Error | null;
  readonly refetch: () => void;
}

/**
 * getChanges in the shared scope, refetched on every `changes` message. Without a container it
 * shows the last known summary and does not call the server (a read call would wake it).
 */
export function useChanges(workspaceId: string): ChangesResult {
  const scope = useWorkspaceUiSelector(workspaceId, (s) => s.diffScope);
  const state = useWorkspaceStateValue(workspaceId);
  const live = isLive(state);
  const changesSeq = useWorkspaceSelector(workspaceId, (s) => s.changesSeq);
  const fromMessage = useWorkspaceSelector(workspaceId, (s) => s.changes);
  const fromDetail = useWorkspaceSelector(workspaceId, (s) => s.workspace?.changes ?? null);
  const lastKnown = fromMessage ?? fromDetail;
  const query = useCallQuery(
    "getChanges",
    { workspaceId, scope },
    { enabled: live, retry: false, placeholderData: keepPreviousData, refetchInterval: retryWhileWaking },
  );
  const { refetch } = query;
  useEffect(() => {
    if (live && changesSeq > 0) void refetch();
  }, [live, changesSeq, refetch]);
  const code = query.error ? errorCode(query.error) : null;
  const view = changesView({ state, scope, data: query.data, errorCode: code, lastKnown });
  return {
    scope,
    source: view.source,
    files: view.files,
    hasList: view.hasList,
    live,
    fetching: query.isFetching,
    error: query.error,
    refetch: () => void refetch(),
  };
}

type RefetchedOnChanges = "getFileDiff" | "listFiles" | "readFile";

/** The last `changes` seq handled per workspace and function, so several mounts invalidate once. */
const handledSeq = new Map<string, number>();

/** Refetches cached reads of workspace files when they change (every `changes` message). */
export function useInvalidateOnChanges(workspaceId: string, names: ReadonlyArray<RefetchedOnChanges>) {
  const queryClient = useQueryClient();
  const changesSeq = useWorkspaceSelector(workspaceId, (s) => s.changesSeq);
  const key = names.join(",");
  useEffect(() => {
    if (changesSeq === 0) return;
    for (const name of key.split(",")) {
      const k = `${workspaceId}\u0000${name}`;
      if (handledSeq.get(k) === changesSeq) continue;
      handledSeq.set(k, changesSeq);
      void queryClient.invalidateQueries({
        queryKey: callKey(name as RefetchedOnChanges),
        predicate: (q) =>
          (q.queryKey[2] as { workspaceId?: string } | undefined)?.workspaceId === workspaceId,
      });
    }
  }, [changesSeq, key, queryClient, workspaceId]);
}

/**
 * listReviewComments. Sending a prompt turns drafts into `sent` and has no channel message of
 * its own, so the list refetches whenever the number of turns changes.
 */
export function useReviewComments(workspaceId: string) {
  const query = useCallQuery("listReviewComments", { workspaceId }, { staleTime: 10_000 });
  const turnCount = useWorkspaceSelector(workspaceId, (s) => Object.keys(s.turns).length);
  const { refetch } = query;
  useEffect(() => {
    if (turnCount > 0) void refetch();
  }, [turnCount, refetch]);
  const draftList = useMemo(() => drafts(query.data), [query.data]);
  return { query, drafts: draftList };
}

export function useDeleteComment() {
  return useCallMutation("deleteReviewComment", { invalidates: ["listReviewComments"] });
}

export function useAddComment(onDone?: () => void) {
  return useCallMutation("addReviewComment", {
    invalidates: ["listReviewComments"],
    onSuccess: () => onDone?.(),
  });
}

/** listFiles while the container is up; refetched when files change. */
export function useFileList(workspaceId: string, enabled = true) {
  const live = useLive(workspaceId);
  useInvalidateOnChanges(workspaceId, LIST_FILES);
  const query = useCallQuery(
    "listFiles",
    { workspaceId },
    { enabled: enabled && live, staleTime: 30_000, retry: false, refetchInterval: retryWhileWaking },
  );
  return { query, live };
}

const LIST_FILES = ["listFiles"] as const;

const remembered = new Map<string, ReadonlySet<string>>();
const NOTHING: ReadonlySet<string> = new Set();

/** A set (open or folded folders) that outlives a hidden panel tab for this page load. */
export function useRememberedSet(
  key: string,
): [ReadonlySet<string>, (update: (cur: ReadonlySet<string>) => ReadonlySet<string>) => void] {
  const [value, setValue] = useState<ReadonlySet<string>>(() => remembered.get(key) ?? NOTHING);
  const set = useCallback(
    (update: (cur: ReadonlySet<string>) => ReadonlySet<string>) =>
      setValue((cur) => {
        const next = update(cur);
        remembered.set(key, next);
        return next;
      }),
    [key],
  );
  return [value, set];
}
