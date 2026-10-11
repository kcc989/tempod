import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readString, writeJson } from "~/ui/lib/storage";

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  globalThis.addEventListener?.("storage", listener);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", listener);
  };
};

const parse = <T>(raw: string | null, fallback: T, guard?: (u: unknown) => u is T): T => {
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return guard && !guard(v) ? fallback : (v as T);
  } catch {
    return fallback;
  }
};

/**
 * A JSON value in localStorage (key prefixed with "tempo:"), shared by every component and tab
 * that uses the same key. Reads and writes never throw. Pass a stable `fallback` and `guard`
 * (module constants), or the value changes identity on every render. 04 limits browser storage to layout, sort
 * order, viewed marks, composer drafts and per-browser preferences.
 */
export function useLocalStorage<T>(
  key: string,
  fallback: T,
  guard?: (u: unknown) => u is T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => readString(key),
    () => null,
  );
  const value = useMemo(() => parse(raw, fallback, guard), [raw, fallback, guard]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = parse(readString(key), fallback, guard);
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      writeJson(key, v);
      for (const l of listeners) l();
    },
    [key, fallback, guard],
  );
  return [value, set];
}
