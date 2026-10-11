import { useStore } from "~/ui/lib/store";
import { setThemePreference, themeStore, type ThemeState } from "~/ui/lib/theme";

/** Settings → Appearance. `resolved` is the theme in use after following the system. */
export function useTheme(): ThemeState & { setPreference: typeof setThemePreference } {
  const state = useStore(themeStore);
  return { ...state, setPreference: setThemePreference };
}
