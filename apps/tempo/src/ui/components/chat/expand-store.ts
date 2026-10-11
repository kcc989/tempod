import { Store, useStoreSelector } from "~/ui/lib/store";

/**
 * Open or closed tool-call rows per session (⌃O expands or collapses all). Kept outside the rows
 * so the state survives virtualization.
 */
interface SessionExpand {
  readonly all: boolean;
  readonly overrides: Readonly<Record<string, boolean>>;
}

const store = new Store<Readonly<Record<string, SessionExpand>>>({});

const empty: SessionExpand = { all: false, overrides: {} };

export const isExpanded = (
  s: Readonly<Record<string, SessionExpand>>,
  sessionId: string,
  itemId: string,
): boolean => {
  const e = s[sessionId] ?? empty;
  return e.overrides[itemId] ?? e.all;
};

/** ⌃O: expands every tool call of the session, or collapses them all when they were expanded. */
export const toggleExpandAll = (sessionId: string): void =>
  store.set((s) => ({ ...s, [sessionId]: { all: !(s[sessionId] ?? empty).all, overrides: {} } }));

export const toggleExpanded = (sessionId: string, itemId: string): void =>
  store.set((s) => {
    const e = s[sessionId] ?? empty;
    return {
      ...s,
      [sessionId]: { ...e, overrides: { ...e.overrides, [itemId]: !isExpanded(s, sessionId, itemId) } },
    };
  });

export const getExpandState = () => store.getSnapshot();

export const useExpanded = (sessionId: string, itemId: string): boolean =>
  useStoreSelector(store, (s) => isExpanded(s, sessionId, itemId));

/** Tests only. */
export const resetExpand = (): void => store.set({});
