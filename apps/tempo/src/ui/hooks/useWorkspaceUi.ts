import { useCallback, useSyncExternalStore } from "react";
import { useStore, useStoreSelector } from "~/ui/lib/store";
import {
  closeDialog,
  dialogStore,
  layoutStore,
  settingsStore,
  openDialog,
  workspaceUiStore,
  type ConfirmRequest,
  type DialogKind,
  type DialogOf,
  type DialogState,
  type LayoutState,
  type WorkspaceUiState,
} from "~/ui/state/workspace-ui";

/** Tabs, composer insertions, diff scope and panel tabs of one workspace. */
export function useWorkspaceUi(workspaceId: string): WorkspaceUiState {
  return useStore(workspaceUiStore(workspaceId));
}

/** One slice of the workspace UI state; `select` must return a stable value. */
export function useWorkspaceUiSelector<S>(workspaceId: string, select: (s: WorkspaceUiState) => S): S {
  return useStoreSelector(workspaceUiStore(workspaceId), select);
}

/** Sidebar, right side and bottom panel visibility, and the phone pane. */
export function useLayout(): LayoutState {
  return useStore(layoutStore());
}

export function useDialogState(): DialogState | null {
  return useStoreSelector(dialogStore, (s) => s.dialog);
}

/**
 * Wires a dialog component to the dialog store: `open` and `onOpenChange` go straight to Radix
 * Dialog; `args` is the open request (project, tab, workspace…).
 */
export function useDialog<K extends DialogKind>(
  kind: K,
): {
  readonly open: boolean;
  readonly args: DialogOf<K> | null;
  readonly onOpenChange: (open: boolean) => void;
} {
  const dialog = useStoreSelector(dialogStore, (s) => s.dialog);
  const args = dialog?.kind === kind ? (dialog as DialogOf<K>) : null;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeDialog(kind);
      else if (dialogStore.getSnapshot().dialog?.kind !== kind) openDialog({ kind } as DialogState);
    },
    [kind],
  );
  return { open: args !== null, args, onOpenChange };
}

export function useConfirmRequest(): ConfirmRequest | null {
  return useSyncExternalStore(
    dialogStore.subscribe,
    () => dialogStore.getSnapshot().confirm,
    () => null,
  );
}

export function useSettings(): DialogOf<"settings"> | null {
  return useStore(settingsStore);
}
