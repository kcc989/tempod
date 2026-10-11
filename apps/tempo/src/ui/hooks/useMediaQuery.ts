import { useCallback, useSyncExternalStore } from "react";

/** True while the media query matches. False on the server. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const mql = globalThis.matchMedia?.(query);
      mql?.addEventListener("change", listener);
      return () => mql?.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

/** 04, Phone width: below 768 px the UI shows one pane at a time. */
export const PHONE_QUERY = "(max-width: 767.98px)";

/** 04, Diff tab: unified only below 1024 px. */
export const NARROW_QUERY = "(max-width: 1023.98px)";

export const useIsPhone = (): boolean => useMediaQuery(PHONE_QUERY);

export const useIsNarrow = (): boolean => useMediaQuery(NARROW_QUERY);
