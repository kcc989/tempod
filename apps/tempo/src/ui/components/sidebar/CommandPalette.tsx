import { useNavigate } from "@tanstack/react-router";
import { defaultFilter } from "cmdk";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "~/ui/components/ui/command";
import { useAvailableActions } from "~/ui/hooks/useActions";
import { useIsPhone } from "~/ui/hooks/useMediaQuery";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { formatCombo, isMacPlatform } from "~/ui/lib/shortcuts";
import { runAction } from "~/ui/state/actions";
import { closeDialog, setPhonePane } from "~/ui/state/workspace-ui";
import { StatusIcon } from "./indicators";
import { useSidebarOrder } from "./navigation";

/** Items carry an internal id as their value; only the keywords are searched. */
const paletteFilter = (value: string, search: string, keywords?: string[]): number =>
  defaultFilter(keywords?.length ? keywords.join(" ") : value, search);

/**
 * 04, Command palette (⌘K): jump to any workspace by title, branch or slug; run any action that
 * has a shortcut.
 */
export function CommandPalette() {
  const { open, onOpenChange } = useDialog("palette");
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a workspace or run an action."
      commandProps={{ filter: paletteFilter }}
    >
      {open && <PaletteBody />}
    </CommandDialog>
  );
}

function PaletteBody() {
  const order = useSidebarOrder();
  const actions = useAvailableActions();
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const mac = isMacPlatform();

  return (
    <>
      <CommandInput placeholder="Jump to a workspace or run an action" />
      <CommandList className="max-h-[min(400px,60dvh)]">
        <CommandEmpty>No results.</CommandEmpty>
        {order.all.length > 0 && (
          <CommandGroup heading="Workspaces">
            {order.all.map((w) => (
              <CommandItem
                key={w.id}
                value={`workspace:${w.id}`}
                keywords={[w.title, w.branch, w.slug]}
                onSelect={() => {
                  closeDialog("palette");
                  if (isPhone) setPhonePane("chat");
                  closeDialog("settings");
                  void navigate({ to: "/w/$workspaceId", params: { workspaceId: w.id } });
                }}
              >
                <StatusIcon workspace={w} />
                <span className="min-w-0 truncate">{w.title}</span>
                <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {w.branch} · {w.slug}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {actions.some((a) => a.id !== "palette") && (
          <CommandGroup heading="Actions">
            {actions
              .filter((a) => a.id !== "palette")
              .map((a) => (
                <CommandItem
                  key={a.id}
                  value={`action:${a.id}`}
                  keywords={[a.label]}
                  onSelect={() => {
                    closeDialog("palette");
                    runAction(a.id);
                  }}
                >
                  {a.label}
                  <CommandShortcut>{formatCombo(a.key, mac)}</CommandShortcut>
                </CommandItem>
              ))}
          </CommandGroup>
        )}
      </CommandList>
    </>
  );
}
