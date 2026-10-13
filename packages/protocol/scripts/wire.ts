import { Schema, SchemaAST } from "effect";
import * as P from "../src/index.ts";

/**
 * Every wire type the native client sees (07, Shared types), by the name its JSON Schema file and
 * Rust type get. tempod's protocol is left out: only the WorkspaceDO speaks it.
 */
export const SHARED = {
  AgentId: P.AgentId,
  WorkspaceState: P.WorkspaceState,
  Attention: P.Attention,
  PrState: P.PrState,
  ChecksState: P.ChecksState,
  SetupStatus: P.SetupStatus,
  OpKind: P.OpKind,
  OpStatus: P.OpStatus,
  SessionStatus: P.SessionStatus,
  TurnStatus: P.TurnStatus,
  ItemKind: P.ItemKind,
  ItemStatus: P.ItemStatus,
  CheckpointReason: P.CheckpointReason,
  ScriptKind: P.ScriptKind,
  ScriptRunStatus: P.ScriptRunStatus,
  ReviewSide: P.ReviewSide,
  ReviewStatus: P.ReviewStatus,
  PermissionStatus: P.PermissionStatus,
  DiffScope: P.DiffScope,
  MergeMethod: P.MergeMethod,
  ApiKeyProvider: P.ApiKeyProvider,
  CredentialProvider: P.CredentialProvider,
  InstanceName: P.InstanceName,
  EgressPolicy: P.EgressPolicy,
  EgressStatusFilter: P.EgressStatusFilter,
  RunMode: P.RunMode,
  LogLevel: P.LogLevel,
  NoticeLevel: P.NoticeLevel,
  ErrorCode: P.ErrorCodeSchema,
  ErrorBody: P.ErrorBody,

  SessionMode: P.SessionMode,
  ConfigSelectOption: P.ConfigSelectOption,
  ConfigSelectGroup: P.ConfigSelectGroup,
  ConfigOption: P.ConfigOption,
  AvailableCommand: P.AvailableCommand,
  PermissionOption: P.PermissionOption,
  PlanEntry: P.PlanEntry,
  ToolLocation: P.ToolLocation,
  ContentBlock: P.ContentBlock,
  Usage: P.Usage,
  Attachment: P.Attachment,
  Capabilities: P.Capabilities,
  McpTransport: P.McpTransport,
  McpEnvVar: P.McpEnvVar,
  McpHeader: P.McpHeader,
  McpServer: P.McpServer,
  McpHeaderInput: P.McpHeaderInput,
  McpServerInput: P.McpServerInput,

  RunScript: P.RunScript,
  CustomInstance: P.CustomInstance,
  Instance: P.Instance,
  Settings: P.Settings,
  SettingsLayer: P.SettingsLayer,
  SettingsSource: P.SettingsSource,
  SettingsReadResult: P.SettingsReadResult,

  McpStdioServer: P.McpStdioServer,
  McpRemoteServer: P.McpRemoteServer,
  McpServerDef: P.McpServerDef,
  CustomAgentDefinition: P.CustomAgentDefinition,
  CustomAgent: P.CustomAgent,
  CustomAgentSummary: P.CustomAgentSummary,
  ProfileIssue: P.ProfileIssue,
  SessionCustomAgent: P.SessionCustomAgent,

  Project: P.Project,
  ConversationSummary: P.ConversationSummary,
  ConversationArtifact: P.ConversationArtifact,
  WorkspaceSummary: P.WorkspaceSummary,
  OpProgress: P.OpProgress,
  ChangedFile: P.ChangedFile,
  ChangesSummary: P.ChangesSummary,
  WorkspaceDetail: P.WorkspaceDetail,
  Session: P.Session,
  AgentModelOptions: P.AgentModelOptions,
  Mention: P.Mention,
  TurnPrompt: P.TurnPrompt,
  Turn: P.Turn,
  UserMessageContent: P.UserMessageContent,
  AgentMessageContent: P.AgentMessageContent,
  AgentThoughtContent: P.AgentThoughtContent,
  ToolCallItemContent: P.ToolCallItemContent,
  PlanContent: P.PlanContent,
  PermissionContent: P.PermissionContent,
  NoticeContent: P.NoticeContent,
  HandoffContent: P.HandoffContent,
  RevertMarkerContent: P.RevertMarkerContent,
  ErrorContent: P.ErrorContent,
  ArtifactKind: P.ArtifactKind,
  ArtifactStatus: P.ArtifactStatus,
  ArtifactItemContent: P.ArtifactItemContent,
  Artifact: P.Artifact,
  Item: P.Item,
  ScriptRun: P.ScriptRun,
  ScriptRunWithLog: P.ScriptRunWithLog,
  ReviewComment: P.ReviewComment,
  PermissionRequest: P.PermissionRequest,
  CheckpointInfo: P.CheckpointInfo,
  CheckRun: P.CheckRun,
  CredentialState: P.CredentialState,
  CredentialStatus: P.CredentialStatus,
  Diagnostics: P.Diagnostics,
  NewSource: P.NewSource,
  ApiMeta: P.ApiMeta,
  AppSetupStatus: P.AppSetupStatus,
  SecretBinding: P.SecretBinding,
  InjectorInput: P.InjectorInput,
  Injector: P.Injector,
  EnvironmentSecret: P.EnvironmentSecret,
  Environment: P.Environment,
  EnvironmentProposal: P.EnvironmentProposal,
  PendingEnvironmentProposal: P.PendingEnvironmentProposal,
} as const satisfies Record<string, Schema.Top>;

export const WORKSPACE_CHANNEL = {
  WsHello: P.WsHello,
  WsItems: P.WsItems,
  WsItemUpsert: P.WsItemUpsert,
  WsItemDelta: P.WsItemDelta,
  WsWorkspace: P.WsWorkspace,
  WsSession: P.WsSession,
  WsTurn: P.WsTurn,
  WsTurnDeleted: P.WsTurnDeleted,
  WsPermission: P.WsPermission,
  WsScriptOutput: P.WsScriptOutput,
  WsScriptRun: P.WsScriptRun,
  WsChanges: P.WsChanges,
  WsCredentialInvalid: P.WsCredentialInvalid,
  WsError: P.WsError,
  WsPong: P.WsPong,
  WorkspaceServerMessage: P.WorkspaceServerMessage,
  ClientPing: P.ClientPing,
} as const satisfies Record<string, Schema.Top>;

export const HUB_CHANNEL = {
  HubHello: P.HubHello,
  HubWorkspace: P.HubWorkspace,
  HubWorkspaceRemoved: P.HubWorkspaceRemoved,
  HubServerMessage: P.HubServerMessage,
} as const satisfies Record<string, Schema.Top>;

export const TERMINAL_CHANNEL = {
  TerminalResize: P.TerminalResize,
  TerminalReady: P.TerminalReady,
} as const satisfies Record<string, Schema.Top>;

const pascal = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

const isEmptyStruct = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Objects" && ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0;

/** How an API function's input or output maps to a wire type. */
export type TypeRef =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "array"; readonly name: string };

export interface ApiFunction {
  readonly name: P.FnName;
  readonly method: "GET" | "POST";
  readonly input: TypeRef;
  readonly output: TypeRef;
}

const byAst = new Map<SchemaAST.AST, string>();
const wire: Array<readonly [string, Schema.Top]> = [];

const register = (name: string, schema: Schema.Top): void => {
  if (wire.some(([n]) => n === name)) throw new Error(`duplicate wire type name ${name}`);
  wire.push([name, schema]);
  if (!byAst.has(schema.ast)) byAst.set(schema.ast, name);
};

for (const group of [SHARED, WORKSPACE_CHANNEL, HUB_CHANNEL, TERMINAL_CHANNEL]) {
  for (const [name, schema] of Object.entries(group)) register(name, schema);
}

const resolve = (fn: string, suffix: "In" | "Out", schema: Schema.Top): TypeRef => {
  const named = byAst.get(schema.ast);
  if (named) return { kind: "named", name: named };
  if (isEmptyStruct(schema.ast)) {
    if (!byAst.has(schema.ast)) register("Empty", schema);
    return { kind: "named", name: "Empty" };
  }
  const ast = schema.ast;
  if (ast._tag === "Arrays" && ast.elements.length === 0 && ast.rest.length === 1) {
    const item = ast.rest[0]!;
    const itemName = byAst.get(item);
    if (itemName) return { kind: "array", name: itemName };
    const name = `${pascal(fn)}Item`;
    register(name, Schema.make(item));
    return { kind: "array", name };
  }
  const name = `${pascal(fn)}${suffix}`;
  register(name, schema);
  return { kind: "named", name };
};

export const API_FUNCTIONS: ReadonlyArray<ApiFunction> = P.FN_NAMES.map((name) => {
  const f = P.API[name];
  return {
    name,
    method: f.method,
    input: resolve(name, "In", f.input),
    output: resolve(name, "Out", f.output),
  };
});

/** Every wire type in a stable order: shared types, channels, then API inputs and outputs. */
export const WIRE_TYPES: ReadonlyArray<readonly [string, Schema.Top]> = wire;

export const wireType = (name: string): Schema.Top => {
  const found = wire.find(([n]) => n === name);
  if (!found) throw new Error(`unknown wire type ${name}`);
  return found[1];
};

/** The registered name of a schema node, used to turn shared types into references. */
export const nameOfAst = (ast: SchemaAST.AST): string | undefined => byAst.get(ast);
