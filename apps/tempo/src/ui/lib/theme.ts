import { readString, writeString } from "./storage";
import { Store } from "./store";

/** Settings → Appearance (04): system, light or dark. Kept per browser. */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export const isThemePreference = (u: unknown): u is ThemePreference => u === "system" || u === "light" || u === "dark";

export const readThemePreference = (): ThemePreference => {
  const raw = readString(THEME_KEY);
  return isThemePreference(raw) ? raw : "system";
};

export const resolveTheme = (pref: ThemePreference, systemDark: boolean): ResolvedTheme =>
  pref === "system" ? (systemDark ? "dark" : "light") : pref;

const systemPrefersDark = (): boolean => {
  try {
    return globalThis.matchMedia?.(DARK_QUERY).matches ?? false;
  } catch {
    return false;
  }
};

export interface ThemeState {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
}

export const themeStore = new Store<ThemeState>({ preference: "system", resolved: "light" });

export const applyThemeClass = (resolved: ResolvedTheme): void => {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
};

const refresh = (preference: ThemePreference = themeStore.getSnapshot().preference): void => {
  const resolved = resolveTheme(preference, systemPrefersDark());
  themeStore.set((prev) => (prev.preference === preference && prev.resolved === resolved ? prev : { preference, resolved }));
  applyThemeClass(resolved);
};

export const setThemePreference = (preference: ThemePreference): void => {
  writeString(THEME_KEY, preference === "system" ? null : preference);
  refresh(preference);
};

/** Reads the saved preference, applies it, and follows system and other-tab changes. */
export const startThemeSync = (): (() => void) => {
  refresh(readThemePreference());
  const mql = (() => {
    try {
      return globalThis.matchMedia?.(DARK_QUERY) ?? null;
    } catch {
      return null;
    }
  })();
  const onSystem = () => refresh();
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.endsWith(THEME_KEY)) refresh(readThemePreference());
  };
  mql?.addEventListener("change", onSystem);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    mql?.removeEventListener("change", onSystem);
    globalThis.removeEventListener?.("storage", onStorage);
  };
};

/** Runs before first paint so a dark page never flashes light. Must match readThemePreference. */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem("tempo:${THEME_KEY}");var d=p==="dark"||(p!=="light"&&window.matchMedia("${DARK_QUERY}").matches);var r=document.documentElement;if(d)r.classList.add("dark");r.style.colorScheme=d?"dark":"light";}catch(e){}})()`;
