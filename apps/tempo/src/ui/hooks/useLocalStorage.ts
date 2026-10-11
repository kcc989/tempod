import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readString, writeJson } from "~/ui/lib/storage";

const listeners = new Set<() => void>();
const volatile = new Map<string, { raw: string; stored: string | null }>();

const read = (key: string): string | null => {
  const stored = readString(key);
  const pending = volatile.get(key);
  if (!pending) return stored;
  if (stored === pending.stored) return pending.raw;
  volatile.delete(key);
  return stored;
};

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
    () => read(key),
    () => null,
  );
  const value = useMemo(() => parse(raw, fallback, guard), [raw, fallback, guard]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = parse(read(key), fallback, guard);
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      writeJson(key, v);
      const raw = JSON.stringify(v);
      const stored = readString(key);
      // A blocked or full storage area must not make the controlled composer discard typing.
      if (stored !== raw) volatile.set(key, { raw, stored });
      else volatile.delete(key);
      for (const l of listeners) l();
    },
    [key, fallback, guard],
  );
  return [value, set];
}
