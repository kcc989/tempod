import { useNavigate } from "@tanstack/react-router";
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
import { useHub } from "~/ui/hooks/useHub";
import { useDialog } from "~/ui/hooks/useWorkspaceUi";
import { isListed } from "~/ui/stores/hub-state";
import { formatCombo, isMacPlatform } from "~/ui/lib/shortcuts";
import { runAction } from "~/ui/state/actions";
import { closeDialog } from "~/ui/state/workspace-ui";

/** REGION A placeholder: ⌘K palette (04, Command palette). Opens on dialog kind "palette". */
export function CommandPalette() {
  const { open, onOpenChange } = useDialog("palette");
  const hub = useHub();
  const actions = useAvailableActions();
  const navigate = useNavigate();
  const mac = isMacPlatform();
  const workspaces = Object.values(hub.workspaces).filter(isListed);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to a workspace or run an action" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Workspaces">
          {workspaces.map((w) => (
            <CommandItem
              key={w.id}
              value={`${w.title} ${w.branch} ${w.slug} ${w.id}`}
              onSelect={() => {
                closeDialog("palette");
                void navigate({ to: "/w/$workspaceId", params: { workspaceId: w.id } });
              }}
            >
              <span className="truncate">{w.title}</span>
              <span className="truncate text-xs text-muted-foreground">{w.branch}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Actions">
          {actions
            .filter((a) => a.id !== "palette")
            .map((a) => (
              <CommandItem
                key={a.id}
                value={a.label}
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
      </CommandList>
    </CommandDialog>
  );
}
