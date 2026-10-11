import { useEffect } from "react";
import { getHubStore } from "~/ui/stores/hub-store";
import { openWorkspaceStores } from "~/ui/stores/workspace-store";

/** Reconnect every live socket at once when the browser comes back online or the tab is shown. */
export function useReconnectRules(): void {
  useEffect(() => {
    const now = () => {
      getHubStore().reconnectNow();
      for (const s of openWorkspaceStores()) s.reconnectNow();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") now();
    };
    window.addEventListener("online", now);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", now);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
