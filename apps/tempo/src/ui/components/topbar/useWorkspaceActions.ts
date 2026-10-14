import { useApiCall } from "~/ui/hooks/useCall";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { PrimaryActionKind } from "~/ui/lib/indicators";
import { toast } from "sonner";
import { invalidateCalls, useCallMutation } from "~/ui/hooks/useCall";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";

import { workspaceUrl } from "~/ui/lib/links";
import { toastError } from "~/ui/lib/toast";
import { CONFIRM_TEXT, confirm, setPhonePane, showRightTab } from "~/ui/state/workspace-ui";
import { requestCommit } from "./commit-request";

/** 04, Confirmations: archive has no confirmation; an Undo toast shows for 8 s. */
export const UNDO_MS = 8_000;

export const openExternal = (url: string): void => {
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
};

export const copyText = async (text: string, done: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Copy failed.");
  }
};

/**
 * Workspace actions shared by the top bar, the sidebar hover card and the right-click menu. Server
 * errors toast with the error-table message.
 */
export function useWorkspaceActions(workspaceId: string) {
  const call = useApiCall();

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isPhone = useIsPhone();

  const commit = useCallMutation("commitAndPush", {
    onSuccess: () => toast.success("Committed and pushed."),
  });

  const createPr = useCallMutation("createPullRequest", {
    onSuccess: (pr) =>
      toast.success(`Created PR #${pr.number}.`, {
        action: { label: "Open", onClick: () => openExternal(pr.url) },
      }),
  });

  const merge = useCallMutation("mergePullRequest", { onSuccess: () => toast.success("Merged.") });
  const wake = useCallMutation("wakeWorkspace");
  const sleep = useCallMutation("sleepWorkspace");
  const resetPreview = useCallMutation("rotatePreviewKey");
  const pin = useCallMutation("setPinned");
  const rename = useCallMutation("renameWorkspace");
  const renameBranch = useCallMutation("renameBranch");

  const archive = useCallMutation("archiveWorkspace", {
    invalidates: ["listWorkspaces"],
    onSuccess: () =>
      toast("Workspace archived.", {
        id: `archive:${workspaceId}`,
        duration: UNDO_MS,
        action: {
          label: "Undo",
          onClick: () => {
            call("restoreWorkspace", { workspaceId })
              .then(() => invalidateCalls(queryClient, "listWorkspaces"))
              .catch((cause: unknown) => toastError(cause));
          },
        },
      }),
  });

  const input = { workspaceId };

  const open = () => {
    if (isPhone) setPhonePane("chat");

    return navigate({ to: "/w/$workspaceId", params: { workspaceId } });
  };

  /** Phones have no Checks tab (04, Phone width), so they get the GitHub checks page. */
  const viewChecks = (checksUrl?: string) => {
    if (isPhone && checksUrl) openExternal(checksUrl);
    else showRightTab(workspaceId, "checks");
  };

  return {
    open,
    commit: (message: string) => commit.mutate({ workspaceId, message }),
    createPr: () => createPr.mutate({ workspaceId, title: "", body: "", draft: false }),
    merge: () => merge.mutate({ workspaceId, method: "squash" }),
    viewChecks,
    wake: () => wake.mutate(input),
    sleep: () => sleep.mutate(input),
    archive: () => archive.mutate(input),
    setPinned: (pinned: boolean) => pin.mutate({ workspaceId, pinned }),
    rename: (title: string) => rename.mutate({ workspaceId, title }),
    renameBranch: (branch: string) => renameBranch.mutate({ workspaceId, branch }),
    resetPreviewAccess: async () => {
      if (await confirm(CONFIRM_TEXT.resetPreviewAccess())) resetPreview.mutate(input);
    },
    copyLink: () => copyText(workspaceUrl(workspaceId), "Link copied."),
    copyBranch: (branch: string) => copyText(branch, "Branch name copied."),
    /** From outside the workspace view: Commit and push opens the workspace, then its popover. */
    runPrimaryElsewhere: async (kind: PrimaryActionKind, checksUrl?: string) => {
      switch (kind) {
        case "commitPush":
          requestCommit(workspaceId);
          await open();

          return;
        case "viewChecks":
          if (!isPhone) await open();
          viewChecks(checksUrl);

          return;
        case "createPr":
          createPr.mutate({ workspaceId, title: "", body: "", draft: false });

          return;
        case "merge":
          merge.mutate({ workspaceId, method: "squash" });

          return;
        case "archive":
          archive.mutate(input);

          return;
      }
    },
    pending: {
      commit: commit.isPending,
      createPr: createPr.isPending,
      merge: merge.isPending,
      archive: archive.isPending,
      power: wake.isPending || sleep.isPending,
    },
  };
}

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;
