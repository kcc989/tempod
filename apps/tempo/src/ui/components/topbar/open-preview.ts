import { toast } from "sonner";
import { call } from "~/ui/lib/api";
import { toastError } from "~/ui/lib/toast";

export const BROWSER_SESSION_ENDED = "Browser session ended.";

/**
 * The tab opens on the click, before `link` returns, so pop-up blockers allow it. It then goes to
 * the link; on an error it closes and the error toasts. A null link closes it and returns false.
 */
export const openInNewTab = async (link: () => Promise<string | null>): Promise<boolean> => {
  const tab = globalThis.open?.("", "_blank") ?? null;
  if (tab) tab.opener = null;
  try {
    const url = await link();
    if (url === null) {
      tab?.close();
      return false;
    }
    if (tab) tab.location.href = url;
    else globalThis.open?.(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    tab?.close();
    toastError(e);
  }
  return true;
};

/** 04 Top bar middle: a preview in a new browser tab, through its one-time entry link. */
export const openPreviewTab = async (workspaceId: string, port: number): Promise<void> => {
  await openInNewTab(async () => (await call("openPreview", { workspaceId, port })).url);
};

/** 04 Phone width: `Live` opens the Live View in a new browser tab. */
export const openLiveViewTab = async (workspaceId: string): Promise<void> => {
  const opened = await openInNewTab(async () => (await call("getBrowserLiveView", { workspaceId })).url);
  if (!opened) toast(BROWSER_SESSION_ENDED);
};

/** 04 Artifact tab and phone width: an HTML or PDF artifact in a new browser tab. */
export const openArtifactInBrowser = async (
  workspaceId: string,
  artifactId: string,
  version: number,
): Promise<void> => {
  await openInNewTab(async () => (await call("openArtifact", { workspaceId, artifactId, version })).url);
};
