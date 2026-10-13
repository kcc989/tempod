import { Schema } from "effect";
import {
  AgentDefinition,
  AgentHandle,
  AgentSummary,
  AgentAttachment,
  AttachmentHooks,
  AttachmentOptions,
} from "./agent-library.ts";

export const AgentProposal = Schema.Struct({
  note: Schema.String,
  agent: Schema.optionalKey(AgentDefinition),
  attach: Schema.optionalKey(
    Schema.Struct({
      handle: AgentHandle,
      hooks: AttachmentHooks,
      autoSend: AttachmentOptions.fields.autoSend,
      maxRuns: AttachmentOptions.fields.maxRuns,
      timeout: AttachmentOptions.fields.timeout,
    }),
  ),
  detach: Schema.optionalKey(AgentHandle),
});

export type AgentProposal = typeof AgentProposal.Type;

export const AgentProposalRecord = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.Number,
  status: Schema.Literals(["pending", "applied", "rejected"]),
  proposal: AgentProposal,
});

export type AgentProposalRecord = typeof AgentProposalRecord.Type;

export const AgentLibraryToolResult = Schema.Struct({
  agents: Schema.Array(AgentSummary),
  attachments: Schema.Array(AgentAttachment),
});

export type AgentLibraryToolResult = typeof AgentLibraryToolResult.Type;
