/**
 * localStorage, used only for layout, sort order, viewed marks, composer drafts and per-browser
 * preferences (04, Storage in the browser). Every access is wrapped in try/catch.
 */
const PREFIX = "tempo:";

export const readString = (key: string): string | null => {
  try {
    return globalThis.localStorage?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
};

export const writeString = (key: string, value: string | null): void => {
  try {
    if (value === null) globalThis.localStorage?.removeItem(PREFIX + key);
    else globalThis.localStorage?.setItem(PREFIX + key, value);
  } catch {
    // Storage full or blocked: the preference is simply not kept.
  }
};

export const readJson = <T>(key: string, fallback: T, guard?: (u: unknown) => u is T): T => {
  const raw = readString(key);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (guard && !guard(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
};

export const writeJson = (key: string, value: unknown): void => {
  try {
    writeString(key, JSON.stringify(value));
  } catch {
    // Not serialisable: ignore.
  }
};

/** A Storage-shaped adapter for libraries that persist layouts themselves. */
export const safeLayoutStorage = {
  getItem: (key: string) => readString(`layout:${key}`),
  setItem: (key: string, value: string) => writeString(`layout:${key}`, value),
};
