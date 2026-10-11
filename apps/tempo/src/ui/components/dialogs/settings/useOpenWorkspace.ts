import { useRouterState } from "@tanstack/react-router";
import type { WorkspaceDetail } from "@tempo/protocol";
import { useCallback, useSyncExternalStore } from "react";
import { peekWorkspaceStore } from "~/ui/stores/workspace-store";

const WORKSPACE_PATH = /^\/w\/([^/]+)/;

/** The workspace the page shows, from the URL. */
export function useOpenWorkspaceId(): string | null {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const m = WORKSPACE_PATH.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * The open workspace's detail from its live store, without opening a socket of its own: the
 * workspace view already holds one.
 */
export function useOpenWorkspaceDetail(): WorkspaceDetail | null {
  const id = useOpenWorkspaceId();
  const store = id ? peekWorkspaceStore(id) : undefined;
  const subscribe = useCallback((l: () => void) => (store ? store.subscribe(l) : () => {}), [store]);
  const get = () => store?.getSnapshot().workspace ?? null;
  return useSyncExternalStore(subscribe, get, () => null);
}
