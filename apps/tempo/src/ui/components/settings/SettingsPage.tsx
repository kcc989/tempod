import {
  ArrowLeftIcon,
  BellIcon,
  FolderGit2Icon,
  KeyboardIcon,
  KeyRoundIcon,
  MonitorIcon,
  PaletteIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SECTIONS, sectionPage } from "~/ui/components/dialogs/settings-model";
import { AppearanceTab } from "~/ui/components/dialogs/settings/AppearanceTab";
import { DevicesTab } from "~/ui/components/dialogs/settings/DevicesTab";
import { LoginsTab } from "~/ui/components/dialogs/settings/LoginsTab";
import { NotificationsTab } from "~/ui/components/dialogs/settings/NotificationsTab";
import { ProjectTab } from "~/ui/components/dialogs/settings/ProjectTab";
import { useOpenWorkspaceDetail } from "~/ui/components/dialogs/settings/useOpenWorkspace";
import { ShortcutsTab } from "~/ui/components/dialogs/settings/ShortcutsTab";
import { Button } from "~/ui/components/ui/button";
import { Input } from "~/ui/components/ui/input";
import { useProjects } from "~/ui/hooks/useProjects";
import { useSettings } from "~/ui/hooks/useWorkspaceUi";
import { cn } from "~/ui/lib/utils";
import { closeDialog, openDialog, type SettingsTab } from "~/ui/state/workspace-ui";

const PERSONAL = [
  {
    id: "general",
    label: "General",
    description: "Notifications and sound for this browser.",
    icon: BellIcon,
  },
  { id: "logins", label: "Logins", description: "Manage agent logins and API keys.", icon: KeyRoundIcon },
  {
    id: "appearance",
    label: "Appearance",
    description: "Make Tempo feel at home on your device.",
    icon: PaletteIcon,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    description: "Keyboard shortcuts for working in Tempo.",
    icon: KeyboardIcon,
  },
  { id: "devices", label: "Devices", description: "Manage devices signed in to Tempo.", icon: MonitorIcon },
] as const;
const PROJECT_SECTIONS = [...new Set(SECTIONS.map(sectionPage)), "Secrets", "General"];

export function SettingsPage() {
  const settings = useSettings();
  const projects = useProjects();
  const workspace = useOpenWorkspaceDetail();
  const [search, setSearch] = useState("");
  const [section, setSection] = useState("Agent");
  const heading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const tab = settings?.tab === "notifications" ? "general" : (settings?.tab ?? "general");
  const project =
    projects.data?.find((p) => p.id === settings?.projectId) ??
    projects.data?.find((p) => p.id === workspace?.projectId) ??
    projects.data?.[0];
  const personal = PERSONAL.find((p) => p.id === tab);
  const title =
    tab === "project" ? (section === "Agent" ? "Agents" : section) : (personal?.label ?? "Settings");
  const query = search.trim().toLowerCase();
  const matches = (label: string) => label.toLowerCase().includes(query);
  const go = (next: SettingsTab, projectId = settings?.projectId) =>
    openDialog({ kind: "settings", tab: next, ...(projectId ? { projectId } : {}) });

  useEffect(() => {
    const previous = document.activeElement;
    heading.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [tab, settings?.projectId, section]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col md:flex-row"
      data-settings-page
      onKeyDown={(e) => {
        if (e.defaultPrevented || e.nativeEvent.isComposing) return;
        if (e.code === "Escape") {
          e.preventDefault();
          closeDialog("settings");
        }
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
          if (e.code === "KeyF") {
            e.preventDefault();
            searchInput.current?.focus();
          }
          if (e.code === "Enter") {
            e.preventDefault();
            const form = e.target instanceof HTMLElement ? e.target.closest("form") : null;
            form?.requestSubmit();
          }
        }
      }}
    >
      <aside
        aria-label="Settings navigation"
        className="flex shrink-0 flex-col border-b bg-sidebar p-3 text-sidebar-foreground md:w-64 md:border-r md:border-b-0"
      >
        <Button variant="ghost" className="mb-4 w-fit gap-2" onClick={() => closeDialog("settings")}>
          <ArrowLeftIcon aria-hidden /> Back
        </Button>
        <p className="mb-4 px-2 text-base font-semibold">Settings</p>
        <div className="relative mb-5">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
          />
          <Input
            ref={searchInput}
            aria-label="Search settings"
            placeholder="Search settings"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <nav className="max-h-56 space-y-6 overflow-y-auto md:max-h-none md:flex-1" aria-label="Settings">
          <div>
            <p className="mb-2 px-2 text-xs text-muted-foreground">Personal</p>
            {PERSONAL.filter((p) => matches(`${p.label} ${p.description}`)).map(
              ({ id, label, icon: Icon }) => (
                <NavItem key={id} active={tab === id} onClick={() => go(id)}>
                  <Icon aria-hidden className="size-4" />
                  {label}
                </NavItem>
              ),
            )}
          </div>
          <div>
            <p className="mb-2 px-2 text-xs text-muted-foreground">Projects</p>
            {projects.isPending && <p className="px-2 text-xs text-muted-foreground">Loading projects…</p>}
            {projects.isError && (
              <Button variant="ghost" size="sm" onClick={() => void projects.refetch()}>
                Retry loading projects
              </Button>
            )}
            {projects.data?.length === 0 && (
              <NavItem active={tab === "project"} onClick={() => go("project")}>
                Project settings
              </NavItem>
            )}
            {projects.data
              ?.filter((p) => matches(`${p.owner}/${p.name}`) || PROJECT_SECTIONS.some(matches))
              .map((p) => (
                <div key={p.id}>
                  <NavItem
                    active={tab === "project" && project?.id === p.id}
                    onClick={() => go("project", p.id)}
                  >
                    <FolderGit2Icon aria-hidden className="size-4 shrink-0" />
                    <span className="truncate" title={`${p.owner}/${p.name}`}>
                      {p.owner}/{p.name}
                    </span>
                  </NavItem>
                  {tab === "project" && project?.id === p.id && (
                    <div className="my-1 ml-4 border-l pl-2">
                      {PROJECT_SECTIONS.filter((s) => matches(s) || matches(`${p.owner}/${p.name}`)).map(
                        (s) => (
                          <NavItem key={s} active={section === s} onClick={() => setSection(s)}>
                            {s === "Agent" ? "Agents" : s}
                          </NavItem>
                        ),
                      )}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </nav>
      </aside>
      <main
        aria-labelledby="settings-heading"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-8 md:px-12 md:py-12"
      >
        <div className="max-w-4xl">
          {tab === "project" && project && (
            <p className="mb-2 text-sm text-muted-foreground">
              {project.owner}/{project.name}
            </p>
          )}
          <h1
            ref={heading}
            id="settings-heading"
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none"
          >
            {title}
          </h1>
          <p className="mt-2 mb-8 text-sm text-muted-foreground">
            {tab === "project" ? "Configure this project and its workspaces." : personal?.description}
          </p>
          {tab === "general" && <NotificationsTab />}
          {tab === "logins" && <LoginsTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "shortcuts" && <ShortcutsTab />}
          {tab === "devices" && <DevicesTab />}
          {tab === "project" && (
            <ProjectTab
              projectId={project?.id}
              onProjectChange={(id) => go("project", id)}
              section={section}
              onSectionChange={setSection}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function NavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}
