import type { WorkspaceSummary } from "@tempo/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { getHubStore, type HubSnapshot } from "~/ui/stores/hub-store";

/** The hub channel snapshot (every workspace summary). Starts the hub socket if needed. */
export function useHub(): HubSnapshot {
  const hub = getHubStore();
  useEffect(() => hub.start(), [hub]);
  return useSyncExternalStore(hub.subscribe, hub.getSnapshot, hub.getSnapshot);
}

/** One workspace's summary from the hub, or undefined. */
export function useHubWorkspace(workspaceId: string | null | undefined): WorkspaceSummary | undefined {
  const hub = getHubStore();
  useEffect(() => hub.start(), [hub]);
  const get = () => (workspaceId ? hub.getSnapshot().workspaces[workspaceId] : undefined);
  return useSyncExternalStore(hub.subscribe, get, get);
}

/** Keeps the hub socket open while the signed-in app is mounted. */
export function useHubConnection(): void {
  useEffect(() => {
    const hub = getHubStore();
    hub.start();
    return () => hub.stop();
  }, []);
}
