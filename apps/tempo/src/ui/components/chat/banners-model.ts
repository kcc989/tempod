import { errorMessage, type ErrorCode, type OpProgress, type WorkspaceDetail } from "@tempo/protocol";
import { formatDuration } from "~/ui/lib/format";
import { stepLabel } from "~/ui/lib/indicators";
import { isKnownErrorCode } from "./transcript-model";

/** Which workspace banners show (04, Empty, loading and error states). */

export type WorkspaceBanner =
  | {
      readonly kind: "progress";
      readonly title: string;
      readonly steps: ReadonlyArray<StepRow>;
      /** setting_up: offer the Setup tab. */
      readonly setup: boolean;
    }
  | {
      readonly kind: "error";
      readonly code: ErrorCode;
      readonly message: string;
      readonly detail: string | null;
    }
  | { readonly kind: "setupFailed" };

export interface StepRow {
  readonly key: string;
  readonly label: string;
  readonly status: OpProgress["steps"][number]["status"];
  /** For example `4 s`; null while the step has not finished. */
  readonly time: string | null;
}

export const stepRows = (op: OpProgress): StepRow[] =>
  op.steps.map((s, i) => ({
    key: `${i}:${s.name}`,
    label: stepLabel(s.name),
    status: s.status,
    time: s.ms !== null && (s.status === "done" || s.status === "failed") ? formatDuration(s.ms) : null,
  }));

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
      title,
      steps: ws.op ? stepRows(ws.op) : [],
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
