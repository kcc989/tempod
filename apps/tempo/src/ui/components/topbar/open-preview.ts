import { call } from "~/ui/lib/api";
import { toastError } from "~/ui/lib/toast";

/**
 * 04 Top bar middle: the tab opens on the click, before openPreview returns, so pop-up blockers
 * allow it. It then goes to the one-time entry link; on an error it closes and the error toasts.
 */
export const openPreviewTab = async (workspaceId: string, port: number): Promise<void> => {
  const tab = globalThis.open?.("", "_blank") ?? null;
  if (tab) tab.opener = null;
  try {
    const { url } = await call("openPreview", { workspaceId, port });
    if (tab) tab.location.href = url;
    else globalThis.open?.(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    tab?.close();
    toastError(e);
  }
};
