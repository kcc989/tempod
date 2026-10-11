import { useSyncExternalStore } from "react";

const isActive = (): boolean => {
  const doc = globalThis.document;
  if (!doc) return false;
  return doc.visibilityState === "visible" && doc.hasFocus();
};

const subscribe = (listener: () => void): (() => void) => {
  globalThis.document?.addEventListener("visibilitychange", listener);
  globalThis.addEventListener?.("focus", listener);
  globalThis.addEventListener?.("blur", listener);
  return () => {
    globalThis.document?.removeEventListener("visibilitychange", listener);
    globalThis.removeEventListener?.("focus", listener);
    globalThis.removeEventListener?.("blur", listener);
  };
};

/** True while the Tempo tab is visible and has focus. */
export function usePageActive(): boolean {
  return useSyncExternalStore(subscribe, isActive, () => false);
}

/** True while the Tempo tab is visible (focused or not). */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => globalThis.document?.visibilityState === "visible",
    () => false,
  );
}
