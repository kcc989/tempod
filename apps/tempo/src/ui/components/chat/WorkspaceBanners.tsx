import {
  AlertCircleIcon,
  CheckIcon,
  CircleIcon,
  MinusIcon,
  MoonIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/ui/components/ui/button";
import { Spinner } from "~/ui/components/ui/spinner";
import { useBanner } from "~/ui/hooks/useBanner";
import { useCallMutation } from "~/ui/hooks/useCall";
import { useWorkspaceSelector } from "~/ui/hooks/useWorkspace";
import { call } from "~/ui/lib/api";
import { toastError } from "~/ui/lib/toast";
import { cn } from "~/ui/lib/utils";
import { showBottomTab } from "~/ui/state/workspace-ui";
import { bannerCodes, workspaceBanners, type StepRow, type WorkspaceBanner } from "./banners-model";

export interface WorkspaceBannersProps {
  readonly workspaceId: string;
}

/**
 * Banners above the center tabs (04, Empty, loading and error states): the op checklist while the
 * workspace is created or started, error, setup failed and sleeping.
 */
export function WorkspaceBanners({ workspaceId }: WorkspaceBannersProps) {
  const workspace = useWorkspaceSelector(workspaceId, (s) => s.workspace);
  const banners = useMemo(() => (workspace ? workspaceBanners(workspace) : []), [workspace]);
  const codes = bannerCodes(banners);
  useBanner(codes, codes.length > 0);

  const state = workspace?.state;
  const lastState = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state === "setting_up" && lastState.current !== "setting_up") showBottomTab(workspaceId, "setup");
    lastState.current = state;
  }, [state, workspaceId]);

  if (banners.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col">
      {banners.map((b) => (
        <Banner key={b.kind} workspaceId={workspaceId} banner={b} />
      ))}
    </div>
  );
}

function Banner({ workspaceId, banner }: { workspaceId: string; banner: WorkspaceBanner }) {
  switch (banner.kind) {
    case "progress":
      return (
        <ProgressBanner
          workspaceId={workspaceId}
          title={banner.title}
          steps={banner.steps}
          setup={banner.setup}
        />
      );
    case "error":
      return <ErrorBanner workspaceId={workspaceId} message={banner.message} detail={banner.detail} />;
    case "setupFailed":
      return <SetupFailedBanner workspaceId={workspaceId} />;
    case "sleeping":
      return (
        <div
          role="status"
          className="flex items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-sm text-muted-foreground"
        >
          <MoonIcon className="size-3.5 shrink-0" />
          Sleeping. Sending a message wakes it.
        </div>
      );
  }
}

function StepIcon({ status }: { status: StepRow["status"] }) {
  switch (status) {
    case "done":
      return <CheckIcon aria-label="Done" className="size-3.5 shrink-0 text-success" />;
    case "running":
      return <Spinner aria-label="Running" className="text-primary" />;
    case "failed":
      return <XIcon aria-label="Failed" className="size-3.5 shrink-0 text-destructive" />;
    case "skipped":
      return <MinusIcon aria-label="Skipped" className="size-3.5 shrink-0 text-muted-foreground" />;
    case "pending":
      return <CircleIcon aria-label="Waiting" className="size-3.5 shrink-0 text-muted-foreground/60" />;
  }
}

/** creating, starting, setting_up: the op's steps as a checklist, each with its time. */
function ProgressBanner({
  workspaceId,
  title,
  steps,
  setup,
}: {
  workspaceId: string;
  title: string;
  steps: ReadonlyArray<StepRow>;
  setup: boolean;
}) {
  return (
    <div role="status" aria-label={title} className="border-b px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <Spinner aria-hidden className="text-primary" />
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">Prompts you send now wait in the queue.</span>
        {setup && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => showBottomTab(workspaceId, "setup")}
          >
            Open Setup tab
          </Button>
        )}
      </div>
      {steps.length > 0 && (
        <ol className="mt-1.5 grid max-w-md gap-0.5 pl-5.5">
          {steps.map((s) => (
            <li
              key={s.key}
              className={cn(
                "flex items-center gap-2 text-xs",
                s.status === "pending" || s.status === "skipped"
                  ? "text-muted-foreground"
                  : "text-foreground",
              )}
            >
              <StepIcon status={s.status} />
              <span className="flex-1">{s.label}</span>
              {s.time && <span className="text-muted-foreground tabular-nums">{s.time}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** error: the UI message, Retry (wakeWorkspace), Details (error_detail) and Archive. */
function ErrorBanner({
  workspaceId,
  message,
  detail,
}: {
  workspaceId: string;
  message: string;
  detail: string | null;
}) {
  const [open, setOpen] = useState(false);
  const wake = useCallMutation("wakeWorkspace");
  const archive = useCallMutation("archiveWorkspace", {
    onSuccess: () => {
      toast("Archived.", {
        duration: 8000,
        action: {
          label: "Undo",
          onClick: () => {
            call("restoreWorkspace", { workspaceId }).catch((e: unknown) => toastError(e));
          },
        },
      });
    },
  });
  return (
    <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <AlertCircleIcon className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">{message}</span>
        <div className="flex items-center gap-1">
          <Button size="sm" onClick={() => wake.mutate({ workspaceId })} disabled={wake.isPending}>
            Retry
          </Button>
          {detail && (
            <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              Details
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => archive.mutate({ workspaceId })}
            disabled={archive.isPending}
          >
            Archive
          </Button>
        </div>
      </div>
      {open && detail && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap">
          {detail}
        </pre>
      )}
    </div>
  );
}

/** setup_status = 'failed': Rerun setup, Continue anyway, View output. */
function SetupFailedBanner({ workspaceId }: { workspaceId: string }) {
  const rerun = useCallMutation("rerunSetup", { onSuccess: () => showBottomTab(workspaceId, "setup") });
  const skip = useCallMutation("continueAfterSetupFailure");
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-sm"
    >
      <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">Setup failed.</span>
      <div className="flex items-center gap-1">
        <Button size="sm" onClick={() => rerun.mutate({ workspaceId })} disabled={rerun.isPending}>
          Rerun setup
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => skip.mutate({ workspaceId })}
          disabled={skip.isPending}
        >
          Continue anyway
        </Button>
        <Button size="sm" variant="ghost" onClick={() => showBottomTab(workspaceId, "setup")}>
          View output
        </Button>
      </div>
    </div>
  );
}
