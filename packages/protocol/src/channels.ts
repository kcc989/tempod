import { Schema } from "effect";
import { CredentialProvider } from "./enums.ts";
import {
  ChangedFile,
  Item,
  PermissionRequest,
  ScriptRun,
  Session,
  Turn,
  WorkspaceDetail,
  WorkspaceSummary,
} from "./types.ts";

export const PROTOCOL_VERSION = 1 as const;

export const CloseCode = {
  replaced: 4001,
  tooMuchBuffered: 4008,
  badProtocolVersion: 4400,
  workspaceNotFound: 4404,
} as const;

const msg = <T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), ...fields });

// Workspace channel (02).
export const WsHello = msg("hello", {
  v: Schema.Literal(1),
  workspace: WorkspaceDetail,
  sessions: Schema.Array(Session),
  turns: Schema.Array(Turn),
  itemsRev: Schema.Number,
});
export const WsItems = msg("items", {
  items: Schema.Array(Item),
  itemsRev: Schema.Number,
  done: Schema.Boolean,
});
export const WsItemUpsert = msg("item.upsert", { item: Item, itemsRev: Schema.Number });
export const WsItemDelta = msg("item.delta", {
  itemId: Schema.String,
  append: Schema.Struct({ text: Schema.String }),
  itemsRev: Schema.Number,
});
export const WsWorkspace = msg("workspace", { workspace: WorkspaceDetail });
export const WsSession = msg("session", { session: Session });
export const WsTurn = msg("turn", { turn: Turn });
/** Additive: a queued turn was deleted. */
export const WsTurnDeleted = msg("turn.deleted", { turnId: Schema.String });
export const WsPermission = msg("permission", { request: PermissionRequest });
export const WsScriptOutput = msg("script.output", {
  runId: Schema.String,
  stream: Schema.Literals(["stdout", "stderr"]),
  data: Schema.String,
});
export const WsScriptRun = msg("script.run", { run: ScriptRun });
export const WsChanges = msg("changes", {
  files: Schema.Array(ChangedFile),
  additions: Schema.Number,
  deletions: Schema.Number,
});
export const WsCredentialInvalid = msg("credential.invalid", { provider: CredentialProvider });
export const WsError = msg("error", { code: Schema.String, message: Schema.String });
export const WsPong = msg("pong", {});

export const WorkspaceServerMessage = Schema.Union([
  WsHello,
  WsItems,
  WsItemUpsert,
  WsItemDelta,
  WsWorkspace,
  WsSession,
  WsTurn,
  WsTurnDeleted,
  WsPermission,
  WsScriptOutput,
  WsScriptRun,
  WsChanges,
  WsCredentialInvalid,
  WsError,
  WsPong,
]);
export type WorkspaceServerMessage = typeof WorkspaceServerMessage.Type;

export const ClientPing = msg("ping", {});
export type ClientPing = typeof ClientPing.Type;

// Hub channel (02).
export const HubHello = msg("hello", { v: Schema.Literal(1), workspaces: Schema.Array(WorkspaceSummary) });
export const HubWorkspace = msg("workspace", { summary: WorkspaceSummary });
export const HubWorkspaceRemoved = msg("workspace.removed", { workspaceId: Schema.String });
export const HubServerMessage = Schema.Union([HubHello, HubWorkspace, HubWorkspaceRemoved, WsPong]);
export type HubServerMessage = typeof HubServerMessage.Type;

// Terminal channel text frames (01, Terminal).
export const TerminalResize = msg("resize", { cols: Schema.Int, rows: Schema.Int });
export const TerminalReady = msg("ready", {});
export type TerminalResize = typeof TerminalResize.Type;

export const RECONNECT = { initialMs: 500, maxMs: 10_000, jitter: 0.2 } as const;

export const reconnectDelay = (attempt: number, random: () => number = Math.random): number => {
  const base = Math.min(RECONNECT.initialMs * 2 ** attempt, RECONNECT.maxMs);
  const jitter = base * RECONNECT.jitter * (random() * 2 - 1);
  return Math.round(base + jitter);
};
