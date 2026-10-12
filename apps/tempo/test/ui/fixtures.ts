import {
  DEFAULT_SETTINGS,
  type Item,
  type Session,
  type Turn,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "@tempo/protocol";

export const summary = (over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id: "w1",
  projectId: "p1",
  slug: "lisbon",
  title: "Lisbon",
  branch: "tempo/lisbon",
  baseBranch: "main",
  state: "ready",
  attention: "none",
  defaultAgent: "claude",
  prNumber: null,
  prState: null,
  checksState: null,
  pinned: false,
  lastActivityAt: 1000,
  createdAt: 1000,
  archivedAt: null,
  rev: 1,
  ...over,
});

export const detail = (over: Partial<WorkspaceDetail> = {}): WorkspaceDetail => ({
  ...summary(),
  errorCode: null,
  errorDetail: null,
  setupStatus: "succeeded",
  pushed: false,
  ports: [],
  browserActive: false,
  settings: DEFAULT_SETTINGS,
  runningTurnId: null,
  queue: [],
  imageRef: null,
  op: null,
  ...over,
});

export const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  agent: "claude",
  title: "Chat",
  status: "idle",
  modeId: null,
  modes: [],
  configOptions: [],
  config: {},
  commands: [],
  usage: {},
  sortOrder: 0,
  ...over,
});

export const turn = (over: Partial<Turn> = {}): Turn => ({
  id: "t1",
  sessionId: "s1",
  seq: 1,
  status: "running",
  queuePos: null,
  prompt: { text: "Do it", mentions: [], attachmentIds: [], reviewCommentIds: [] },
  stopReason: null,
  errorCode: null,
  checkpointId: null,
  reverted: false,
  queuedAt: 1000,
  startedAt: 1000,
  endedAt: null,
  ...over,
});

export const agentMessage = (id: string, text: string, over: Partial<Item> = {}): Item =>
  ({
    id,
    sessionId: "s1",
    turnId: "t1",
    kind: "agent_message",
    status: "streaming",
    content: { text },
    rev: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  }) as Item;

export const userMessage = (id: string, text: string, over: Partial<Item> = {}): Item =>
  ({
    id,
    sessionId: "s1",
    turnId: "t1",
    kind: "user_message",
    status: "completed",
    content: { text, mentions: [], attachments: [], reviewCommentIds: [] },
    rev: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  }) as Item;
