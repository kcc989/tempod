import { useSyncExternalStore } from "react";

/** A minimal external store read with useSyncExternalStore. State is replaced, never mutated. */
export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private state: T) {}

  getSnapshot = (): T => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(next: T | ((prev: T) => T)): void {
    const value = typeof next === "function" ? (next as (prev: T) => T)(this.state) : next;
    if (Object.is(value, this.state)) return;
    this.state = value;
    for (const l of this.listeners) l();
  }

  update(patch: Partial<T>): void {
    this.set((prev) => ({ ...prev, ...patch }));
  }
}

export const useStore = <T,>(store: Store<T>): T => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

/** Reads one slice. The selector must return a stable value (a field, not a new object). */
export const useStoreSelector = <T, S>(store: Store<T>, select: (state: T) => S): S => {
  const get = () => select(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, get, get);
};
