import { Match } from "effect";
import { RadioIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { CenterTabProps } from "~/ui/components/chat/tab-kinds";
import { EmptyState } from "~/ui/components/shell/States";
import { BROWSER_SESSION_ENDED } from "~/ui/components/topbar/open-preview";
import { Button } from "~/ui/components/ui/button";
import { SimpleTooltip } from "~/ui/components/ui/tooltip";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { useApiCall } from "~/ui/hooks/useCall";
import { errorText } from "~/ui/lib/toast";
import { PREVIEW_SANDBOX } from "./browser-model";

/**
 * 04, Browser tabs: Browser Run Live View. The link lets anyone control the browser, so it lives
 * only in this component's state; each open and each Reload asks getBrowserLiveView for a new one.
 */
export function LiveViewTab({ workspaceId, seq }: CenterTabProps<"liveView">) {
  return <LiveView key={seq} workspaceId={workspaceId} />;
}

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "ended" }
  | { readonly kind: "failed"; readonly message: string };

function LiveView({ workspaceId }: { workspaceId: string }) {
  const call = useApiCall();
  const active = useWorkspaceSelector(workspaceId, (s) => s.workspace?.browserActive ?? null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  if (active === false && view.kind !== "ended") setView({ kind: "ended" });

  useEffect(() => {
    let live = true;
    call("getBrowserLiveView", { workspaceId }).then(
      ({ url }) => {
        if (live) setView(url === null ? { kind: "ended" } : { kind: "ready", url });
      },
      (cause: unknown) => {
        if (live) setView({ kind: "failed", message: errorText(cause) });
      },
    );

    return () => {
      live = false;
    };
  }, [workspaceId, attempt, call]);

  const reload = () => {
    setView({ kind: "loading" });
    setAttempt((a) => a + 1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <SimpleTooltip label="Reload">
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Reload" onClick={reload}>
            <RotateCwIcon />
          </Button>
        </SimpleTooltip>
      </div>
      {Match.value(view).pipe(
        Match.when({ kind: "ready" }, (view) => (
          <iframe
            title="Live View"
            src={view.url}
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 border-0 bg-background"
          />
        )),
        Match.when({ kind: "ended" }, () => (
          <EmptyState className="min-h-0 flex-1" icon={RadioIcon} title={BROWSER_SESSION_ENDED} />
        )),
        Match.when({ kind: "failed" }, (view) => (
          <EmptyState className="min-h-0 flex-1" icon={RadioIcon} title={view.message} />
        )),
        Match.orElse(() => <div aria-busy="true" className="min-h-0 flex-1 bg-background" />),
      )}
    </div>
  );
}
