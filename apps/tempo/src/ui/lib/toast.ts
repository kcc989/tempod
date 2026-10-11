import { ERROR_MESSAGES, TempoError, isErrorBody, type ErrorCode } from "@tempo/protocol";
import { toast } from "sonner";

/** The error code of anything a server call can throw. Unknown errors count as INTERNAL. */
export const errorCode = (e: unknown): ErrorCode => {
  if (e instanceof TempoError) return e.code;
  if (isErrorBody(e)) return e.code;
  return "INTERNAL";
};

/** The UI message from the error table (02). The server fills in `<agent>` where it applies. */
export const errorText = (e: unknown): string => {
  if (e instanceof TempoError || isErrorBody(e)) return e.message || ERROR_MESSAGES[e.code];
  return ERROR_MESSAGES.INTERNAL;
};

export const errorDetail = (e: unknown): string | undefined =>
  e instanceof TempoError || isErrorBody(e) ? (e.detail ?? undefined) : undefined;

const banners = new Map<ErrorCode, number>();

/**
 * 04: toasts never show for errors already shown as banners. A banner registers the codes it
 * shows while it is on screen; the returned function unregisters them.
 */
export const showBanner = (codes: ReadonlyArray<ErrorCode>): (() => void) => {
  for (const c of codes) banners.set(c, (banners.get(c) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const c of codes) {
      const n = (banners.get(c) ?? 1) - 1;
      if (n <= 0) banners.delete(c);
      else banners.set(c, n);
    }
  };
};

export const isBannerShown = (code: ErrorCode): boolean => (banners.get(code) ?? 0) > 0;

const unauthenticatedListeners = new Set<() => void>();

/** The app layout listens here and sends the user to /login. */
export const onUnauthenticated = (listener: () => void): (() => void) => {
  unauthenticatedListeners.add(listener);
  return () => {
    unauthenticatedListeners.delete(listener);
  };
};

export interface ToastErrorOptions {
  /** Extra codes the caller shows some other way. */
  readonly skip?: ReadonlyArray<ErrorCode>;
}

/** Shows a server-function error as a toast with its error-table message. Returns false when skipped. */
export const toastError = (e: unknown, opts: ToastErrorOptions = {}): boolean => {
  const code = errorCode(e);
  if (code === "UNAUTHENTICATED") {
    for (const l of unauthenticatedListeners) l();
    if (unauthenticatedListeners.size > 0) return false;
  }
  if (isBannerShown(code) || opts.skip?.includes(code)) return false;
  toast.error(errorText(e), { id: `error:${code}` });
  return true;
};
