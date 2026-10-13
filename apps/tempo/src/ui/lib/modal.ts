const MODAL = ["dialog-content", "alert-dialog-content", "sheet-content"]
  .map((slot) => `[data-slot="${slot}"][data-state="open"]`)
  .join(", ");

export const modalOpen = (): boolean => globalThis.document?.querySelector(MODAL) != null;
