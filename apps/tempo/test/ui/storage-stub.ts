/** A Map-backed localStorage for node tests. */
export const installLocalStorage = (): Map<string, string> => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return data;
};

export const removeLocalStorage = (): void => {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
};
