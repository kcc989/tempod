import { AddProjectDialog } from "~/ui/components/dialogs/AddProjectDialog";
import { Confirm } from "~/ui/components/dialogs/Confirm";
import { DiagnosticsDialog } from "~/ui/components/dialogs/DiagnosticsDialog";
import { NewWorkspaceDialog } from "~/ui/components/dialogs/NewWorkspaceDialog";
import { WorkspaceEnvironmentDialog } from "~/ui/components/dialogs/WorkspaceEnvironmentDialog";
import { CommandPalette } from "~/ui/components/sidebar/CommandPalette";

/** Every app-level dialog, mounted once. Each reads the dialog store and renders when open. */
export function DialogHost() {
  return (
    <>
      <CommandPalette />
      <NewWorkspaceDialog />
      <AddProjectDialog />
      <DiagnosticsDialog />
      <WorkspaceEnvironmentDialog />
      <Confirm />
    </>
  );
}
