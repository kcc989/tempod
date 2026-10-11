import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/components/ui/tabs";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { openDialog, type SettingsTab } from "~/ui/state/workspace-ui";
import { AppearanceTab } from "./settings/AppearanceTab";
import { DevicesTab } from "./settings/DevicesTab";
import { LoginsTab } from "./settings/LoginsTab";
import { NotificationsTab } from "./settings/NotificationsTab";
import { ProjectTab } from "./settings/ProjectTab";
import { ShortcutsTab } from "./settings/ShortcutsTab";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "logins", label: "Logins" },
  { id: "project", label: "Project" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "devices", label: "Devices" },
];

const isSettingsTab = (v: string): v is SettingsTab => TABS.some((t) => t.id === v);

/** ⌘Enter submits the form that holds the focus (each tab has its own forms). */
const submitFocusedForm = () => {
  const el = globalThis.document?.activeElement;
  const form = el instanceof HTMLElement ? el.closest("form") : null;
  form?.requestSubmit();
};

/** 04, Settings (⌥,). Args: the tab and the project for the Project tab. */
export function SettingsDialog() {
  const { open, args, onOpenChange } = useDialog("settings");
  const tab = args?.tab ?? "logins";
  const projectId = args?.projectId;
  const go = (next: SettingsTab, nextProject: string | undefined = projectId) =>
    openDialog({ kind: "settings", tab: next, ...(nextProject ? { projectId: nextProject } : {}) });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(44rem,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl"
        onSubmitShortcut={submitFocusedForm}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">Logins, project settings and preferences.</DialogDescription>
        </DialogHeader>
        {open && (
          <Tabs value={tab} onValueChange={(v) => isSettingsTab(v) && go(v)} className="min-h-0 gap-3">
            <TabsList
              variant="line"
              aria-label="Settings"
              className="w-full shrink-0 justify-start overflow-x-auto"
            >
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <TabsContent value="logins">
                <LoginsTab />
              </TabsContent>
              <TabsContent value="project">
                <ProjectTab projectId={projectId} onProjectChange={(id) => go("project", id)} />
              </TabsContent>
              <TabsContent value="appearance">
                <AppearanceTab />
              </TabsContent>
              <TabsContent value="notifications">
                <NotificationsTab />
              </TabsContent>
              <TabsContent value="shortcuts">
                <ShortcutsTab />
              </TabsContent>
              <TabsContent value="devices">
                <DevicesTab />
              </TabsContent>
            </div>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
