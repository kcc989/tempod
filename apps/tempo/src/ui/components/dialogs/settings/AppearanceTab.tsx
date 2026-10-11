import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "~/ui/components/ui/toggle-group";
import { useTheme } from "~/ui/hooks/useTheme";
import { isThemePreference } from "~/ui/lib/theme";

/** Settings → Appearance (04): system, light or dark, kept per browser. */
export function AppearanceTab() {
  const { preference, setPreference } = useTheme();
  return (
    <div className="grid gap-2">
      <span id="theme-label" className="text-sm font-medium">
        Theme
      </span>
      <ToggleGroup
        type="single"
        aria-labelledby="theme-label"
        value={preference}
        onValueChange={(v) => isThemePreference(v) && setPreference(v)}
      >
        <ToggleGroupItem value="system" className="gap-1.5 px-3">
          <MonitorIcon aria-hidden />
          System
        </ToggleGroupItem>
        <ToggleGroupItem value="light" className="gap-1.5 px-3">
          <SunIcon aria-hidden />
          Light
        </ToggleGroupItem>
        <ToggleGroupItem value="dark" className="gap-1.5 px-3">
          <MoonIcon aria-hidden />
          Dark
        </ToggleGroupItem>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">System follows your device.</p>
    </div>
  );
}
