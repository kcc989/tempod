import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useAction } from "~/ui/hooks/useActions";
import { useHub } from "~/ui/hooks/useHub";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { useProjects } from "~/ui/hooks/useProjects";
import { sidebarSections } from "~/ui/stores/hub-state";
import { setPhonePane } from "~/ui/state/workspace-ui";
import {
  COLLAPSED_KEY,
  DEFAULT_SORT,
  NO_COLLAPSED,
  SORT_KEY,
  fullOrder,
  isSortMode,
  isStringList,
  nextNeedingYou,
  stepWorkspace,
  visibleOrder,
} from "./sidebar-logic";

/** The workspaces in sidebar order (same sort and collapsed sections as the sidebar). */
export function useSidebarOrder() {
  const hub = useHub();
  const projects = useProjects();
  const [sort] = useLocalStorage(SORT_KEY, DEFAULT_SORT, isSortMode);
  const [collapsed] = useLocalStorage(COLLAPSED_KEY, NO_COLLAPSED, isStringList);

  return useMemo(() => {
    const sections = sidebarSections(hub.workspaces, projects.data ?? [], sort);

    return { visible: visibleOrder(sections, collapsed), all: fullOrder(sections) };
  }, [hub.workspaces, projects.data, sort, collapsed]);
}

/**
 * ⌥1–⌥9, ⌥↓/⌥↑ and ⌥G. Mounted app-wide (GlobalChrome) so they also work while the sidebar is
 * hidden with ⌘B.
 */
export function useWorkspaceNavigation(): void {
  const order = useSidebarOrder();
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const params = useParams({ strict: false });
  const current = params.workspaceId ?? null;

  const go = (workspaceId: string | null) => {
    if (!workspaceId) return;

    if (isPhone) setPhonePane("chat");
    void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
  };

  const count = order.visible.length;
  const goNth = (n: number) => go(order.visible[n - 1]?.id ?? null);
  useAction("workspace1", () => goNth(1), { enabled: count >= 1 });
  useAction("workspace2", () => goNth(2), { enabled: count >= 2 });
  useAction("workspace3", () => goNth(3), { enabled: count >= 3 });
  useAction("workspace4", () => goNth(4), { enabled: count >= 4 });
  useAction("workspace5", () => goNth(5), { enabled: count >= 5 });
  useAction("workspace6", () => goNth(6), { enabled: count >= 6 });
  useAction("workspace7", () => goNth(7), { enabled: count >= 7 });
  useAction("workspace8", () => goNth(8), { enabled: count >= 8 });
  useAction("workspace9", () => goNth(9), { enabled: count >= 9 });

  const ids = order.visible.map((w) => w.id);
  useAction("nextWorkspace", () => go(stepWorkspace(ids, current, 1)), { enabled: ids.length > 0 });
  useAction("prevWorkspace", () => go(stepWorkspace(ids, current, -1)), { enabled: ids.length > 0 });
  useAction("nextNeedsYou", () => go(nextNeedingYou(order.all, current)), {
    enabled: nextNeedingYou(order.all, current) !== null,
  });
}
