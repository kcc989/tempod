import { errorMessage, type ErrorCode, type WorkspaceDetail } from "@tempo/protocol";
import { stepLabel } from "~/ui/lib/indicators";
import { isKnownErrorCode } from "./transcript-model";

/** Which workspace banners show (04, Empty, loading and error states). */

export type WorkspaceBanner =
  | {
      readonly kind: "progress";
      readonly title: string;
      /** setting_up: offer the Setup tab. */
      readonly setup: boolean;
    }
  | {
      readonly kind: "error";
      readonly code: ErrorCode;
      readonly message: string;
      readonly detail: string | null;
    }
  | { readonly kind: "setupFailed" }
  | { readonly kind: "sleeping" };

const PROGRESS_TITLE: Partial<Record<WorkspaceDetail["state"], string>> = {
  creating: "Creating the workspace",
  starting: "Starting the workspace",
  setting_up: "Running setup",
};

export const workspaceBanners = (
  ws: Pick<WorkspaceDetail, "state" | "op" | "errorCode" | "errorDetail" | "setupStatus" | "defaultAgent">,
): WorkspaceBanner[] => {
  const out: WorkspaceBanner[] = [];
  if (ws.state === "error") {
    const code: ErrorCode = ws.errorCode && isKnownErrorCode(ws.errorCode) ? ws.errorCode : "INTERNAL";
    out.push({ kind: "error", code, message: errorMessage(code, ws.defaultAgent), detail: ws.errorDetail });
  }
  const title = PROGRESS_TITLE[ws.state];
  if (title) {
    out.push({
      kind: "progress",
      title: ws.op?.step ? stepLabel(ws.op.step) : title,
      setup: ws.state === "setting_up",
    });
  }
  if (
    ws.setupStatus === "failed" &&
    ws.state !== "error" &&
    ws.state !== "archiving" &&
    ws.state !== "archived"
  ) {
    out.push({ kind: "setupFailed" });
  }
  if (ws.state === "sleeping") out.push({ kind: "sleeping" });
  return out;
};

/** Error codes the banners show, so toasts skip them (04, Toasts). */
export const bannerCodes = (banners: ReadonlyArray<WorkspaceBanner>): ErrorCode[] => {
  const codes: ErrorCode[] = [];
  for (const b of banners) {
    if (b.kind === "error") codes.push(b.code);
    if (b.kind === "setupFailed") codes.push("SETUP_FAILED");
  }
  return codes;
};
