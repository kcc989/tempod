import type { WorkspaceSummary } from "@tempo/protocol";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { getHubStore, type HubSnapshot, type HubStore } from "~/ui/stores/hub-store";

/** An externally managed hub for replay views and alternate channel transports. */
export const HubStoreContext = createContext<HubStore | null>(null);

/** The hub channel snapshot (every workspace summary). Starts the hub socket if needed. */
export function useHub(): HubSnapshot {
  const provided = useContext(HubStoreContext);
  const hub = provided ?? getHubStore();
  useEffect(() => {
    if (!provided) hub.start();
  }, [hub, provided]);

  return useSyncExternalStore(hub.subscribe, hub.getSnapshot, hub.getSnapshot);
}

/** One workspace's summary from the hub, or undefined. */
export function useHubWorkspace(workspaceId: string | null | undefined): WorkspaceSummary | undefined {
  const provided = useContext(HubStoreContext);
  const hub = provided ?? getHubStore();
  useEffect(() => {
    if (!provided) hub.start();
  }, [hub, provided]);
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
