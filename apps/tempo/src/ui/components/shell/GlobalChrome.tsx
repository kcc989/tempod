import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";
import { useWorkspaceNavigation } from "~/ui/components/sidebar/navigation";
import {
  DEFAULT_NOTIFY_PREFS,
  NOTIFY_PREFS_KEY,
  isNotifyPrefs,
  notificationFor,
  notificationPermission,
  shouldNotify,
} from "~/ui/components/sidebar/notify";
import { useHub } from "~/ui/hooks/useHub";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { countsForTitle, titleFor } from "~/ui/lib/indicators";
import { getHubStore } from "~/ui/stores/hub-store";
import { isListed, type NotifyEvent } from "~/ui/stores/hub-state";
import { setPhonePane } from "~/ui/state/workspace-ui";

/**
 * App-wide effects with no layout slot: the tab title `(<n>) Tempo`, browser notifications while
 * the tab is hidden (04, Indicators and notifications) and the workspace switching shortcuts.
 */
export function GlobalChrome() {
  const hub = useHub();
  const n = countsForTitle(Object.values(hub.workspaces).filter(isListed));
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    document.title = titleFor(n);
  }, [n, path]);
  useBrowserNotifications();
  useWorkspaceNavigation();
  return null;
}

function useBrowserNotifications(): void {
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const [prefs] = useLocalStorage(NOTIFY_PREFS_KEY, DEFAULT_NOTIFY_PREFS, isNotifyPrefs);

  const onEvent = useEffectEvent((e: NotifyEvent) => {
    const ok = shouldNotify({
      hidden: document.visibilityState === "hidden",
      permission: notificationPermission(),
      prefs,
    });
    if (!ok) return;
    const content = notificationFor(e);
    try {
      const notification = new Notification(content.title, {
        body: content.body,
        tag: content.tag,
        silent: !prefs.sound,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
        if (isPhone) setPhonePane("chat");
        void navigate({ to: "/w/$workspaceId", params: { workspaceId: content.workspaceId } });
      };
    } catch {
      // Some mobile browsers allow notifications only from a service worker.
    }
  });

  useEffect(() => getHubStore().onNotify((e) => onEvent(e)), []);
}
