import { useEffect, useEffectEvent, type RefObject } from "react";
import { isEditableTarget, isMacPlatform, matchAction, type ActionId } from "~/ui/lib/shortcuts";

/** Return false to let the event through (no preventDefault). */
export type ShortcutHandler = (e: KeyboardEvent) => void | false;

export interface ShortcutOptions {
  /** Listen on this element instead of window. */
  readonly target?: RefObject<HTMLElement | null>;
  readonly enabled?: boolean;
  /** Let plain keys (J, K, Enter) fire from text fields. Use for handlers scoped to an input. */
  readonly allowPlainInEditable?: boolean;
}

/**
 * Binds actions from the 04 table to handlers. Matches KeyboardEvent.code with exact modifiers;
 * ⌘ is Meta on macOS and Ctrl elsewhere; every handled key calls preventDefault.
 */
export function useShortcuts(handlers: Partial<Record<ActionId, ShortcutHandler>>, options: ShortcutOptions = {}): void {
  const { target, enabled = true, allowPlainInEditable = false } = options;

  const onKey = useEffectEvent((e: KeyboardEvent, mac: boolean) => {
    if (e.defaultPrevented || e.isComposing) return;
    const id = matchAction(e, Object.keys(handlers) as ActionId[], mac, {
      editable: isEditableTarget(e.target),
      allowPlainInEditable,
    });
    if (!id) return;
    const result = handlers[id]?.(e);
    if (result !== false) e.preventDefault();
  });

  useEffect(() => {
    if (!enabled) return;
    const el: HTMLElement | Window | null = target ? target.current : window;
    if (!el) return;
    const mac = isMacPlatform();
    const listener = (ev: Event) => onKey(ev as KeyboardEvent, mac);
    el.addEventListener("keydown", listener);
    return () => el.removeEventListener("keydown", listener);
  }, [target, enabled]);
}
