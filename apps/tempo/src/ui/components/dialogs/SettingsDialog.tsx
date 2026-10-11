import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/ui/components/ui/dialog";
import { Label } from "~/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useTheme } from "~/ui/hooks/useTheme";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { isMacPlatform, formatRow, SHORTCUT_ROWS } from "~/ui/lib/shortcuts";
import { isThemePreference } from "~/ui/lib/theme";
import { openDialog, type SettingsTab } from "~/ui/state/workspace-ui";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "logins", label: "Logins" },
  { id: "project", label: "Project" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "devices", label: "Devices" },
];

/** REGION D placeholder: Settings (⌥,). Args: tab and projectId. */
export function SettingsDialog() {
  const { open, args, onOpenChange } = useDialog("settings");
  const tab = args?.tab ?? "logins";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(v) => openDialog({ kind: "settings", tab: v as SettingsTab, ...(args?.projectId ? { projectId: args.projectId } : {}) })}
        >
          <TabsList variant="line" className="w-full justify-start">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="appearance">
            <Appearance />
          </TabsContent>
          <TabsContent value="shortcuts">
            <Shortcuts />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Appearance() {
  const { preference, setPreference } = useTheme();
  return (
    <div className="flex items-center gap-3">
      <Label htmlFor="theme">Theme</Label>
      <Select value={preference} onValueChange={(v) => isThemePreference(v) && setPreference(v)}>
        <SelectTrigger id="theme">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">System</SelectItem>
          <SelectItem value="light">Light</SelectItem>
          <SelectItem value="dark">Dark</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function Shortcuts() {
  const mac = isMacPlatform();
  return (
    <table className="w-full text-sm">
      <tbody>
        {SHORTCUT_ROWS.map((r) => (
          <tr key={r.action} className="border-b last:border-0">
            <td className="py-1">{r.action}</td>
            <td className="py-1 text-right font-mono text-xs text-muted-foreground">{formatRow(r, mac)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
