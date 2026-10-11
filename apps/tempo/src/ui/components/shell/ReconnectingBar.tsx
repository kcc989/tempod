import { useStore } from "~/ui/lib/store";
import { connectionMonitor } from "~/ui/stores/connection";

/** 04: a thin bar at the top while a live socket has been down for over 2 s. */
export function ReconnectingBar() {
  const { reconnecting } = useStore(connectionMonitor);
  if (!reconnecting) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-5 shrink-0 items-center justify-center border-b bg-warning/15 text-xs text-foreground"
    >
      Reconnecting…
    </div>
  );
}
