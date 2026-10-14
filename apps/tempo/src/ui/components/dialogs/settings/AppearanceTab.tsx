import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "~/ui/components/ui/toggle-group";
import { useTheme } from "~/ui/hooks/useTheme";
import { isThemePreference } from "~/ui/lib/theme";
import { isTranscriptDetail, setTranscriptDetail, useTranscriptDetail } from "~/ui/lib/transcript-detail";

/** Settings → Appearance (04): theme and transcript detail, kept per browser. */
export function AppearanceTab() {
  const { preference, setPreference } = useTheme();
  const detail = useTranscriptDetail();

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-6 border-t py-6">
        <div>
          <span id="theme-label" className="text-sm font-medium">
            Theme
          </span>
          <p className="mt-2 text-xs text-muted-foreground">System follows your device.</p>
        </div>
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
      </div>
      <div className="flex flex-wrap items-start justify-between gap-6 border-t py-6">
        <div>
          <span id="detail-label" className="text-sm font-medium">
            Transcript detail
          </span>
          <p className="mt-2 text-xs text-muted-foreground">
            Default folds each turn's reads and commands into one row. Detailed shows every step.
          </p>
        </div>
        <ToggleGroup
          type="single"
          aria-labelledby="detail-label"
          value={detail}
          onValueChange={(v) => isTranscriptDetail(v) && setTranscriptDetail(v)}
        >
          <ToggleGroupItem value="default" className="px-3">
            Default
          </ToggleGroupItem>
          <ToggleGroupItem value="detailed" className="px-3">
            Detailed
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </>
  );
}
