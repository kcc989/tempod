import { useEffect } from "react";
import { isEditableTarget, isMacPlatform, isPlainCombo, matchGlobal } from "~/ui/lib/shortcuts";
import { runAction } from "~/ui/state/actions";

const MODAL = ["dialog-content", "alert-dialog-content", "sheet-content"]
  .map((slot) => `[data-slot="${slot}"][data-state="open"]`)
  .join(", ");

const modalOpen = (): boolean => document.querySelector(MODAL) !== null;

/**
 * The one window key listener for global actions (04, Keyboard shortcuts). It runs the registered
 * handler and calls preventDefault only when something handled the key. While a modal is open,
 * only the command palette key works.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const binding = matchGlobal(e, mac);
      if (!binding) return;
      if (isPlainCombo(binding.key) && isEditableTarget(e.target)) return;
      if (binding.id !== "palette" && modalOpen()) return;
      if (runAction(binding.id)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
