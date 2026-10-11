import { useState } from "react";
import {
  DEFAULT_NOTIFY_PREFS,
  isNotifyPrefs,
  notificationPermission,
  NOTIFY_PREFS_KEY,
  type PermissionState,
} from "~/ui/components/sidebar/notify";
import { Button } from "~/ui/components/ui/button";
import { Label } from "~/ui/components/ui/label";
import { Switch } from "~/ui/components/ui/switch";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";

const PERMISSION_TEXT: Record<PermissionState, string> = {
  granted: "This browser allows notifications from Tempo.",
  default: "This browser has not been asked yet.",
  denied: "This browser blocks notifications from Tempo. Allow them in its site settings.",
  unsupported: "This browser cannot show notifications.",
};

/**
 * Settings → Notifications (04). Permission is asked only here, never on page load. Notifications
 * are sent only while the Tempo tab is hidden.
 */
export function NotificationsTab() {
  const [prefs, setPrefs] = useLocalStorage(NOTIFY_PREFS_KEY, DEFAULT_NOTIFY_PREFS, isNotifyPrefs);
  const [permission, setPermission] = useState<PermissionState>(notificationPermission);

  const ask = async () => {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(notificationPermission());
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <Switch
            id="notify-enabled"
            checked={prefs.enabled}
            disabled={permission === "unsupported"}
            onCheckedChange={(on) => {
              setPrefs((p) => ({ ...p, enabled: on }));
              if (on && permission === "default") void ask();
            }}
          />
          <Label htmlFor="notify-enabled">Browser notifications</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          When a turn ends, or a workspace waits for you or needs attention, while the Tempo tab is hidden.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {PERMISSION_TEXT[permission]}
          </p>
          {permission === "default" && (
            <Button size="sm" variant="outline" onClick={() => void ask()}>
              Allow notifications
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="notify-sound"
          checked={prefs.sound}
          disabled={!prefs.enabled || permission === "unsupported"}
          onCheckedChange={(on) => setPrefs((p) => ({ ...p, sound: on }))}
        />
        <Label htmlFor="notify-sound">Sound</Label>
      </div>
    </div>
  );
}
