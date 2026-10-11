import { call } from "~/ui/lib/api";
import { toastError } from "~/ui/lib/toast";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import type { WorkspaceEvent } from "~/ui/stores/workspace-state";
import {
  getWorkspaceStore,
  releaseWorkspaceStore,
  retainWorkspaceStore,
  type WorkspaceSnapshot,
  type WorkspaceStore,
} from "~/ui/stores/workspace-store";
import { usePageActive } from "./usePageActive";

/**
 * The cached store of an open workspace. Each caller keeps it connected while mounted; it closes
 * its socket a few seconds after the last caller unmounts.
 */
export function useWorkspaceStore(workspaceId: string): WorkspaceStore {
  const store = getWorkspaceStore(workspaceId);
  useEffect(() => {
    retainWorkspaceStore(store);
    return () => releaseWorkspaceStore(store);
  }, [store]);
  return store;
}

/** The live snapshot of one workspace channel (02, Workspace channel). */
export function useWorkspace(workspaceId: string): WorkspaceSnapshot {
  const store = useWorkspaceStore(workspaceId);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * One slice of the snapshot. `select` must return a stable value (a field or a primitive), not a
 * new object, or the component renders on every message.
 */
export function useWorkspaceSelector<S>(workspaceId: string, select: (s: WorkspaceSnapshot) => S): S {
  const store = useWorkspaceStore(workspaceId);
  const get = () => select(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, get, get);
}

/** Calls `listener` for channel events: turnEnded, error, credentialInvalid. */
export function useWorkspaceEvents(workspaceId: string, listener: (e: WorkspaceEvent) => void): void {
  const store = useWorkspaceStore(workspaceId);
  const onEvent = useEffectEvent(listener);
  useEffect(() => store.onEvent((e) => onEvent(e)), [store]);
}

const markViewed = (workspaceId: string) => {
  call("markViewed", { workspaceId }).catch(() => {
    // Best effort: the next view or turn end tries again.
  });
};

/**
 * Mount once per shown workspace (WorkspaceLayout does). 03, Viewed: calls markViewed when the view
 * is visible and focused, and again when a turn ends while it is. Channel `error` messages show as
 * toasts unless a banner shows them.
 */
export function useWorkspaceLifecycle(workspaceId: string): void {
  const active = usePageActive();
  const ready = useWorkspaceSelector(workspaceId, (s) => s.ready);

  useEffect(() => {
    if (active && ready) markViewed(workspaceId);
  }, [active, ready, workspaceId]);

  useWorkspaceEvents(workspaceId, (e) => {
    if (e.kind === "turnEnded" && active) markViewed(workspaceId);
    if (e.kind === "error") toastError({ code: e.code, message: e.message });
  });
}
