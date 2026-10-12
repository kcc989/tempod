import { BINDINGS, type ActionId, type Binding } from "~/ui/lib/shortcuts";

/**
 * App actions by id from the 04 shortcut table. Regions register handlers; the global key
 * listener and the command palette run them. The most recent registration of an id wins, so a
 * nested view can override an outer one while it is mounted. A `fallback` registration runs only
 * when no other one exists (React mounts children before parents, so order alone is not enough).
 */
export type ActionHandler = () => unknown;

interface Entry {
  readonly handler: ActionHandler;
  readonly enabled: () => boolean;
  readonly fallback: boolean;
}

const registry = new Map<ActionId, Entry[]>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version++;
  for (const l of listeners) l();
};

export const registerAction = (
  id: ActionId,
  handler: ActionHandler,
  opts: { readonly enabled?: () => boolean; readonly fallback?: boolean } = {},
): (() => void) => {
  const entry: Entry = { handler, enabled: opts.enabled ?? (() => true), fallback: opts.fallback ?? false };
  const list = registry.get(id) ?? [];
  registry.set(id, [...list, entry]);
  emit();
  return () => {
    const cur = registry.get(id) ?? [];
    const next = cur.filter((e) => e !== entry);
    if (next.length === 0) registry.delete(id);
    else registry.set(id, next);
    emit();
  };
};

const current = (id: ActionId): Entry | undefined => {
  const list = registry.get(id) ?? [];
  return list.findLast((e) => !e.fallback) ?? list[list.length - 1];
};

export const hasAction = (id: ActionId): boolean => {
  const e = current(id);
  return e !== undefined && e.enabled();
};

/** Runs the action; false when nothing handles it right now. */
export const runAction = (id: ActionId): boolean => {
  const e = current(id);
  if (!e || !e.enabled()) return false;
  void e.handler();
  return true;
};

/** Keys that only make sense typed in place (04: the palette runs actions, not text edits or card answers). */
const NOT_IN_PALETTE: ReadonlySet<ActionId> = new Set([
  "send",
  "newLine",
  "permissionAllow",
  "permissionReject",
]);

/** Bindings that have an enabled handler, in table order (for the command palette). */
export const availableActions = (): Binding[] =>
  BINDINGS.filter((b) => !NOT_IN_PALETTE.has(b.id) && hasAction(b.id));

export const subscribeActions = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const actionsVersion = (): number => version;

/** Tests only. */
export const resetActions = (): void => {
  registry.clear();
  emit();
};
