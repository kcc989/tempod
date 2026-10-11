import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useHub } from "~/ui/hooks/useHub";
import { countsForTitle, titleFor } from "~/ui/lib/indicators";
import { isListed } from "~/ui/stores/hub-state";

/**
 * REGION A placeholder: app-wide effects with no layout slot. Today: the tab title `(<n>) Tempo`
 * (04, Tab title). Browser notifications belong here too.
 */
export function GlobalChrome() {
  const hub = useHub();
  const n = countsForTitle(Object.values(hub.workspaces).filter(isListed));
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    document.title = titleFor(n);
  }, [n, path]);
  return null;
}
