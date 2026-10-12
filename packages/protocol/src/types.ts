import { Schema } from "effect";
import {
  AvailableCommand,
  Capabilities,
  ConfigOption,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionMode,
  ToolCallContent,
  ToolLocation,
  TurnUsage,
  Usage,
} from "./acp.ts";
import {
  AgentId,
  Attention,
  CheckpointReason,
  ChecksState,
  NoticeLevel,
  OpKind,
  OpStatus,
  PrState,
  ReviewSide,
  ReviewStatus,
  ScriptKind,
  ScriptRunStatus,
  SessionStatus,
  SetupStatus,
  TurnStatus,
  WorkspaceState,
} from "./enums.ts";
import { ErrorCodeSchema } from "./errors.ts";
import { Settings, SettingsLayer, SettingsSource } from "./settings.ts";

const N = Schema.NullOr;
const Ms = Schema.Number;

export const Project = Schema.Struct({
  id: Schema.String,
  installationId: Schema.Number,
  repoId: Schema.Number,
  owner: Schema.String,
  name: Schema.String,
  defaultBranch: Schema.String,
  settings: SettingsLayer,
  sortOrder: Schema.Number,
});
export type Project = typeof Project.Type;

export const WorkspaceSummary = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  state: WorkspaceState,
  attention: Attention,
  defaultAgent: AgentId,
  prNumber: N(Schema.Number),
  prState: N(PrState),
  checksState: N(ChecksState),
  pinned: Schema.Boolean,
  lastActivityAt: Ms,
  createdAt: Ms,
  archivedAt: N(Ms),
  rev: Schema.Number,
});
export type WorkspaceSummary = typeof WorkspaceSummary.Type;

export const OpProgress = Schema.Struct({
  kind: OpKind,
  status: OpStatus,
  step: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["pending", "running", "done", "failed", "skipped"]),
      ms: N(Schema.Number),
    }),
  ),
});
export type OpProgress = typeof OpProgress.Type;

export const ChangedFile = Schema.Struct({
  path: Schema.String,
  oldPath: Schema.optional(Schema.String),
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type ChangedFile = typeof ChangedFile.Type;

export const ChangesSummary = Schema.Struct({
  files: Schema.Array(ChangedFile),
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type ChangesSummary = typeof ChangesSummary.Type;

export const WorkspaceDetail = Schema.Struct({
  ...WorkspaceSummary.fields,
  errorCode: N(Schema.String),
  errorDetail: N(Schema.String),
  setupStatus: SetupStatus,
  pushed: Schema.Boolean,
  prTitle: Schema.optional(N(Schema.String)),
  ports: Schema.Array(Schema.Struct({ port: Schema.Number, url: Schema.String })),
  settings: Settings,
  runningTurnId: N(Schema.String),
  queue: Schema.Array(Schema.String),
  imageRef: N(Schema.String),
  op: N(OpProgress),
  /** Additive fields (see docs/IMPLEMENTATION_NOTES.md). */
  settingsWarnings: Schema.optional(Schema.Array(Schema.String)),
  settingsErrors: Schema.optional(Schema.Array(Schema.String)),
  settingsSources: Schema.optional(Schema.Record(Schema.String, SettingsSource)),
  changes: Schema.optional(N(ChangesSummary)),
  hasUnpushedCommits: Schema.optional(Schema.Boolean),
});
export type WorkspaceDetail = typeof WorkspaceDetail.Type;

export const Session = Schema.Struct({
  id: Schema.String,
  agent: AgentId,
  title: Schema.String,
  status: SessionStatus,
  modeId: N(Schema.String),
  modes: Schema.Array(SessionMode),
  configOptions: Schema.Array(ConfigOption),
  config: Schema.Record(Schema.String, Schema.Unknown),
  commands: Schema.Array(AvailableCommand),
  usage: Usage,
  sortOrder: Schema.Number,
  steering: Schema.optional(Schema.Boolean),
});
export type Session = typeof Session.Type;

export const Mention = Schema.Struct({ path: Schema.String });
export type Mention = typeof Mention.Type;

export const TurnPrompt = Schema.Struct({
  text: Schema.String,
  mentions: Schema.Array(Mention),
  attachmentIds: Schema.Array(Schema.String),
  reviewCommentIds: Schema.Array(Schema.String),
});
export type TurnPrompt = typeof TurnPrompt.Type;

export const Turn = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  seq: Schema.Number,
  status: TurnStatus,
  queuePos: N(Schema.Number),
  steeringPending: Schema.optional(Schema.Boolean),
  prompt: TurnPrompt,
  stopReason: N(Schema.String),
  errorCode: N(Schema.String),
  checkpointId: N(Schema.String),
  reverted: Schema.Boolean,
  queuedAt: Ms,
  startedAt: N(Ms),
  endedAt: N(Ms),
  usage: Schema.optional(TurnUsage),
});
export type Turn = typeof Turn.Type;

// Item content per kind (02, Item model).
export const Attachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
});
export type Attachment = typeof Attachment.Type;

export const UserMessageContent = Schema.Struct({
  text: Schema.String,
  mentions: Schema.Array(Mention),
  attachments: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })),
  reviewCommentIds: Schema.Array(Schema.String),
});
export const AgentMessageContent = Schema.Struct({
  text: Schema.String,
  blocks: Schema.optional(Schema.Array(ContentBlock)),
});
export const AgentThoughtContent = Schema.Struct({ text: Schema.String });
export const ToolCallItemContent = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.String,
  toolKind: Schema.optional(N(Schema.String)),
  locations: Schema.Array(ToolLocation),
  content: Schema.Array(ToolCallContent),
  rawInput: Schema.optional(Schema.Unknown),
  rawOutput: Schema.optional(Schema.Unknown),
});
export const PlanContent = Schema.Struct({ entries: Schema.Array(PlanEntry) });
export const PermissionContent = Schema.Struct({
  requestId: Schema.String,
  toolCallId: Schema.optional(N(Schema.String)),
  title: Schema.String,
  options: Schema.Array(PermissionOption),
  chosenOptionId: Schema.optional(N(Schema.String)),
});
export const NoticeContent = Schema.Struct({ level: NoticeLevel, text: Schema.String });
export const HandoffContent = Schema.Struct({ text: Schema.String });
export const RevertMarkerContent = Schema.Struct({ checkpointId: Schema.String, toTurnSeq: Schema.Number });
export const ErrorContent = Schema.Struct({ code: Schema.String, detail: Schema.optional(N(Schema.String)) });

export type UserMessageContent = typeof UserMessageContent.Type;
export type AgentMessageContent = typeof AgentMessageContent.Type;
export type ToolCallItemContent = typeof ToolCallItemContent.Type;
export type PlanContent = typeof PlanContent.Type;
export type PermissionContent = typeof PermissionContent.Type;
export type NoticeContent = typeof NoticeContent.Type;
export type RevertMarkerContent = typeof RevertMarkerContent.Type;
export type ErrorContent = typeof ErrorContent.Type;

export const ITEM_CONTENT = {
  user_message: UserMessageContent,
  agent_message: AgentMessageContent,
  agent_thought: AgentThoughtContent,
  tool_call: ToolCallItemContent,
  plan: PlanContent,
  permission: PermissionContent,
  notice: NoticeContent,
  handoff: HandoffContent,
  revert_marker: RevertMarkerContent,
  error: ErrorContent,
} as const;

const itemFields = {
  id: Schema.String,
  sessionId: Schema.String,
  turnId: N(Schema.String),
  status: Schema.Literals(["streaming", "pending", "in_progress", "completed", "failed", "cancelled"]),
  rev: Schema.Number,
  createdAt: Ms,
  updatedAt: Ms,
};

const itemOf = <K extends keyof typeof ITEM_CONTENT>(kind: K) =>
  Schema.Struct({ ...itemFields, kind: Schema.Literal(kind), content: ITEM_CONTENT[kind] });

export const Item = Schema.Union([
  itemOf("user_message"),
  itemOf("agent_message"),
  itemOf("agent_thought"),
  itemOf("tool_call"),
  itemOf("plan"),
  itemOf("permission"),
  itemOf("notice"),
  itemOf("handoff"),
  itemOf("revert_marker"),
  itemOf("error"),
]);
export type Item = typeof Item.Type;
export type ItemOf<K extends Item["kind"]> = Extract<Item, { kind: K }>;

export const ScriptRun = Schema.Struct({
  id: Schema.String,
  kind: ScriptKind,
  scriptId: N(Schema.String),
  command: Schema.String,
  status: ScriptRunStatus,
  exitCode: N(Schema.Number),
  signal: N(Schema.String),
  startedAt: Ms,
  endedAt: N(Ms),
});
export type ScriptRun = typeof ScriptRun.Type;

export const ReviewComment = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  lineStart: N(Schema.Number),
  lineEnd: N(Schema.Number),
  side: N(ReviewSide),
  body: Schema.String,
  status: ReviewStatus,
  sentTurnId: N(Schema.String),
  createdAt: Ms,
});
export type ReviewComment = typeof ReviewComment.Type;

export const PermissionRequest = Schema.Struct({
  requestId: Schema.String,
  sessionId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  title: Schema.String,
  options: Schema.Array(PermissionOption),
});
export type PermissionRequest = typeof PermissionRequest.Type;

export const CheckpointInfo = Schema.Struct({
  id: Schema.String,
  turnId: N(Schema.String),
  turnSeq: N(Schema.Number),
  reason: CheckpointReason,
  createdAt: Ms,
});
export type CheckpointInfo = typeof CheckpointInfo.Type;

export const CheckRun = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: N(Schema.String),
  url: Schema.String,
});
export type CheckRun = typeof CheckRun.Type;

export const CredentialState = Schema.Struct({ set: Schema.Boolean, updatedAt: N(Ms) });
export const CredentialStatus = Schema.Struct({
  claude: CredentialState,
  codex: Schema.Struct({ ...CredentialState.fields, lastRefresh: N(Ms) }),
  openrouter: CredentialState,
  anthropic: CredentialState,
  openai: CredentialState,
});
export type CredentialStatus = typeof CredentialStatus.Type;

export const Diagnostics = Schema.Struct({
  ops: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: OpKind,
      status: OpStatus,
      step: Schema.String,
      attempt: Schema.Number,
      errorCode: N(Schema.String),
      errorDetail: N(Schema.String),
      timings: Schema.Record(Schema.String, Schema.Number),
      createdAt: Ms,
      updatedAt: Ms,
    }),
  ),
  container: Schema.Struct({
    state: WorkspaceState,
    running: Schema.Boolean,
    instance: Schema.String,
    imageRef: N(Schema.String),
    snapshots: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        sizeBytes: Schema.Number,
        imageRef: Schema.String,
        createdAt: Ms,
        lastRestoredAt: N(Ms),
        unusable: Schema.Boolean,
      }),
    ),
    tempodVersion: N(Schema.String),
    incarnation: N(Schema.String),
  }),
  logs: Schema.Array(
    Schema.Struct({
      ts: Ms,
      level: Schema.String,
      msg: Schema.String,
      data: Schema.optional(Schema.Unknown),
    }),
  ),
  egress: Schema.Array(
    Schema.Struct({
      ts: Ms,
      method: Schema.String,
      host: Schema.String,
      path: Schema.String,
      status: Schema.Number,
      ms: Schema.Number,
      rule: Schema.Number,
    }),
  ),
  sessions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      agent: AgentId,
      acpSessionId: N(Schema.String),
      capabilities: Capabilities,
      live: Schema.Boolean,
    }),
  ),
});
export type Diagnostics = typeof Diagnostics.Type;

export const ErrorCodeField = ErrorCodeSchema;
