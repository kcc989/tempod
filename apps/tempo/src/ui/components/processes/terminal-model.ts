import { Schema } from "effect";
import { CloseCode, type WorkspaceState } from "@tempo/protocol";

/** Terminal tabs and channel frames (01, Terminal; 02, Terminal channel). */

export type TerminalAvailability = "loading" | "connect" | "sleeping" | "archived";

/**
 * Opening a terminal wakes the workspace, so a sleeping one asks first, and a socket never
 * reconnects into a workspace that is going to sleep.
 */
export const terminalAvailability = (state: WorkspaceState | null): TerminalAvailability => {
  if (state === null) return "loading";

  if (state === "archived" || state === "archiving") return "archived";

  if (state === "sleeping" || state === "stopping") return "sleeping";

  return "connect";
};

export const TERMINAL_IDS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"] as const;

export type TerminalId = (typeof TERMINAL_IDS)[number];

export const isTerminalId = (s: string): s is TerminalId => /^t[1-9]$/.test(s);

/** The lowest id with no open tab, or null when all nine are open. */
export const nextTerminalId = (tabs: ReadonlyArray<string>): TerminalId | null =>
  TERMINAL_IDS.find((id) => !tabs.includes(id)) ?? null;

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(n) ? Math.floor(n) : min));

export const terminalSize = (cols: number, rows: number) => ({
  cols: clamp(cols, 10, 500),
  rows: clamp(rows, 5, 200),
});

export const terminalPath = (
  workspaceId: string,
  terminalId: TerminalId,
  cols: number,
  rows: number,
): string => {
  const size = terminalSize(cols, rows);

  return `/api/ws/terminal/${encodeURIComponent(workspaceId)}/${terminalId}?cols=${size.cols}&rows=${size.rows}`;
};

export const resizeFrame = (cols: number, rows: number): string =>
  JSON.stringify({ type: "resize", ...terminalSize(cols, rows) });

/** True for the server's one text frame, `{"type":"ready"}`. */
export const isReadyFrame = (data: string): boolean => {
  try {
    return Schema.is(Schema.Struct({ type: Schema.Literal("ready") }))(JSON.parse(data));
  } catch {
    return false;
  }
};

const encoder = new TextEncoder();

/** Keystrokes go as binary frames. */
export const encodeInput = (data: string): Uint8Array => encoder.encode(data);

/** xterm's onBinary gives one byte per char (mouse reports); send the bytes as they are. */
export const encodeBinary = (data: string): Uint8Array => {
  const out = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;

  return out;
};

export type TerminalClose = "exited" | "replaced" | "notFound" | "badVersion" | "reconnect";

/**
 * What to do when the socket closes. 1000 means the shell exited (the server closes with it when
 * tmux ends); 4001, 4400 and 4404 never reconnect (02); anything else reconnects.
 */
export const terminalCloseAction = (code: number): TerminalClose => {
  if (code === 1000) return "exited";

  if (code === CloseCode.replaced) return "replaced";

  if (code === CloseCode.workspaceNotFound) return "notFound";

  if (code === CloseCode.badProtocolVersion) return "badVersion";

  return "reconnect";
};

export const TERMINAL_CLOSE_TEXT: Record<Exclude<TerminalClose, "reconnect">, string> = {
  exited: "The shell exited.",
  replaced: "This terminal was opened somewhere else.",
  notFound: "Not found.",
  badVersion: "Reload Tempo to use this terminal.",
};
