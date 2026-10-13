import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import type { ActionId, Binding } from "~/ui/lib/shortcuts";
import { actionsVersion, availableActions, registerAction, subscribeActions } from "~/ui/state/actions";

export interface UseActionOptions {
  /** False unregisters the handler. Default true. */
  readonly enabled?: boolean;
  /** Runs only when nothing else handles the action (app-wide defaults). */
  readonly fallback?: boolean;
}

/**
 * Registers a handler for an app action (⌥N, ⌥T, …) while mounted. The global key listener and
 * the command palette run it. The most recently mounted non-fallback handler wins.
 */
export function useAction(id: ActionId, handler: () => void, options: UseActionOptions = {}): void {
  const { enabled = true, fallback = false } = options;
  const run = useEffectEvent(handler);
  useEffect(() => {
    if (!enabled) return;

    return registerAction(id, () => run(), { fallback });
  }, [id, enabled, fallback]);
}

/** Global actions with an enabled handler, for the command palette. */
export function useAvailableActions(): Binding[] {
  useSyncExternalStore(subscribeActions, actionsVersion, actionsVersion);

  return availableActions();
}
