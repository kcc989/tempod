import { Store } from "~/ui/lib/store";

/**
 * A request to open the Commit and push popover of one workspace (⌥Y, or the sidebar hover card
 * before the workspace's top bar mounts). A request that nobody takes expires.
 */
export const COMMIT_REQUEST_TTL_MS = 10_000;

export const commitRequestStore = new Store<{ readonly workspaceId: string | null }>({ workspaceId: null });

let expiry: ReturnType<typeof setTimeout> | null = null;

export const requestCommit = (workspaceId: string): void => {
  if (expiry !== null) clearTimeout(expiry);
  commitRequestStore.set({ workspaceId });
  expiry = setTimeout(() => clearCommitRequest(workspaceId), COMMIT_REQUEST_TTL_MS);
};

export const isCommitRequested = (workspaceId: string): boolean =>
  commitRequestStore.getSnapshot().workspaceId === workspaceId;

export const clearCommitRequest = (workspaceId: string): void => {
  if (isCommitRequested(workspaceId)) commitRequestStore.set({ workspaceId: null });
};

/** True once per request for this workspace. */
export const takeCommitRequest = (workspaceId: string): boolean => {
  if (!isCommitRequested(workspaceId)) return false;
  clearCommitRequest(workspaceId);

  return true;
};
