import { Schema } from "effect";

export const AGENT_IDS = ["claude", "codex", "opencode", "pi"] as const;

export const AgentId = Schema.Literals(AGENT_IDS);

export type AgentId = typeof AgentId.Type;

export const WORKSPACE_STATES = [
  "creating",
  "starting",
  "setting_up",
  "ready",
  "working",
  "stopping",
  "sleeping",
  "archiving",
  "archived",
  "error",
] as const;

export const WorkspaceState = Schema.Literals(WORKSPACE_STATES);

export type WorkspaceState = typeof WorkspaceState.Type;

export const ATTENTIONS = ["none", "unread", "needs_input", "error"] as const;

export const Attention = Schema.Literals(ATTENTIONS);

export type Attention = typeof Attention.Type;

export const PR_STATES = ["open", "draft", "merged", "closed"] as const;

export const PrState = Schema.Literals(PR_STATES);

export type PrState = typeof PrState.Type;

export const PROJECT_VISIBILITIES = ["public", "private"] as const;

export const ProjectVisibility = Schema.Literals(PROJECT_VISIBILITIES);

export type ProjectVisibility = typeof ProjectVisibility.Type;

export const IssueState = Schema.Literals(["open", "closed"]);

export type IssueState = typeof IssueState.Type;

export const CiTrigger = Schema.Literals(["push", "manual", "rerun"]);

export type CiTrigger = typeof CiTrigger.Type;

export const CiStatus = Schema.Literals(["queued", "running", "completed"]);

export type CiStatus = typeof CiStatus.Type;

export const CiRunConclusion = Schema.Literals(["success", "failure", "cancelled"]);

export type CiRunConclusion = typeof CiRunConclusion.Type;

export const CiJobConclusion = Schema.Literals(["success", "failure", "cancelled", "timed_out", "skipped"]);

export type CiJobConclusion = typeof CiJobConclusion.Type;

export const DEPLOY_TOOL_KINDS = ["alchemy", "cloudflare-config"] as const;

export const DeployTool = Schema.Literals(DEPLOY_TOOL_KINDS);

export type DeployTool = typeof DeployTool.Type;

export const DEPLOY_PERMISSIONS = [
  "workers",
  "kv",
  "d1",
  "r2",
  "queues",
  "vectorize",
  "hyperdrive",
  "secrets_store",
  "routes",
] as const;

export const DeployPermission = Schema.Literals(DEPLOY_PERMISSIONS);

export type DeployPermission = typeof DeployPermission.Type;

export const DeployTrigger = Schema.Literals(["manual", "agent", "auto", "redeploy"]);

export type DeployTrigger = typeof DeployTrigger.Type;

export const DeployStatus = Schema.Literals(["queued", "running", "completed"]);

export type DeployStatus = typeof DeployStatus.Type;

export const DeployConclusion = Schema.Literals(["success", "failure", "cancelled", "timed_out"]);

export type DeployConclusion = typeof DeployConclusion.Type;

export const DEPLOY_ROLLOUTS = ["full", "gradual"] as const;

export const DeployRolloutKind = Schema.Literals(DEPLOY_ROLLOUTS);

export type DeployRolloutKind = typeof DeployRolloutKind.Type;

export const DeployRolloutPhase = Schema.Literals(["canary", "promoted", "full", "rolled_back"]);

export type DeployRolloutPhase = typeof DeployRolloutPhase.Type;

export const CHECKS_STATES = ["pending", "success", "failure"] as const;

export const ChecksState = Schema.Literals(CHECKS_STATES);

export type ChecksState = typeof ChecksState.Type;

export const SETUP_STATUSES = ["none", "running", "succeeded", "failed", "skipped"] as const;

export const SetupStatus = Schema.Literals(SETUP_STATUSES);

export type SetupStatus = typeof SetupStatus.Type;

export const OP_KINDS = [
  "create",
  "wake",
  "sleep",
  "archive",
  "restore",
  "revert",
  "commit_push",
  "merge_pr",
  "housekeeping",
] as const;

export const OpKind = Schema.Literals(OP_KINDS);

export type OpKind = typeof OpKind.Type;

export const OP_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;

export const OpStatus = Schema.Literals(OP_STATUSES);

export type OpStatus = typeof OpStatus.Type;

export const SESSION_STATUSES = ["starting", "idle", "running", "closed"] as const;

export const SessionStatus = Schema.Literals(SESSION_STATUSES);

export type SessionStatus = typeof SessionStatus.Type;

export const TURN_STATUSES = [
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
] as const;

export const TurnStatus = Schema.Literals(TURN_STATUSES);

export type TurnStatus = typeof TurnStatus.Type;

export const ITEM_KINDS = [
  "user_message",
  "agent_message",
  "agent_thought",
  "tool_call",
  "plan",
  "permission",
  "notice",
  "handoff",
  "revert_marker",
  "error",
  "artifact",
  "run",
  "agent_proposal",
] as const;

export const ItemKind = Schema.Literals(ITEM_KINDS);

export type ItemKind = typeof ItemKind.Type;

export const ITEM_STATUSES = [
  "streaming",
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;

export const ItemStatus = Schema.Literals(ITEM_STATUSES);

export type ItemStatus = typeof ItemStatus.Type;

export const CHECKPOINT_REASONS = [
  "run_pin",
  "turn_end",
  "pre_revert",
  "pre_sleep",
  "pre_archive",
  "sigterm",
] as const;

export const CheckpointReason = Schema.Literals(CHECKPOINT_REASONS);

export type CheckpointReason = typeof CheckpointReason.Type;

export const SCRIPT_KINDS = ["setup", "run", "archive"] as const;

export const ScriptKind = Schema.Literals(SCRIPT_KINDS);

export type ScriptKind = typeof ScriptKind.Type;

export const SCRIPT_RUN_STATUSES = ["running", "exited", "killed", "failed_to_start", "timed_out"] as const;

export const ScriptRunStatus = Schema.Literals(SCRIPT_RUN_STATUSES);

export type ScriptRunStatus = typeof ScriptRunStatus.Type;

export const REVIEW_SIDES = ["old", "new"] as const;

export const ReviewSide = Schema.Literals(REVIEW_SIDES);

export type ReviewSide = typeof ReviewSide.Type;

export const REVIEW_STATUSES = ["draft", "sent"] as const;

export const ReviewStatus = Schema.Literals(REVIEW_STATUSES);

export type ReviewStatus = typeof ReviewStatus.Type;

export const PERMISSION_STATUSES = ["pending", "answered", "cancelled"] as const;

export const PermissionStatus = Schema.Literals(PERMISSION_STATUSES);

export type PermissionStatus = typeof PermissionStatus.Type;

export const DiffScope = Schema.Literals(["branch", "uncommitted"]);

export type DiffScope = typeof DiffScope.Type;

export const MergeMethod = Schema.Literals(["squash", "merge", "rebase"]);

export type MergeMethod = typeof MergeMethod.Type;

export const ApiKeyProvider = Schema.Literals(["openrouter", "anthropic", "openai"]);

export type ApiKeyProvider = typeof ApiKeyProvider.Type;

export const CredentialProvider = Schema.Literals(["claude", "codex", "openrouter", "anthropic", "openai"]);

export type CredentialProvider = typeof CredentialProvider.Type;

export const InstanceName = Schema.Literals(["standard-2", "standard-3", "standard-4"]);

export type InstanceName = typeof InstanceName.Type;

export const EgressPolicy = Schema.Literals(["open", "allowlist"]);

export type EgressPolicy = typeof EgressPolicy.Type;

/** getDiagnostics `egressStatus` (02): `blocked` means TempoOutbound rule 0, 7 or 10. */
export const EGRESS_STATUS_FILTERS = ["all", "blocked", "2xx", "3xx", "4xx", "5xx"] as const;

export const EgressStatusFilter = Schema.Literals(EGRESS_STATUS_FILTERS);

export type EgressStatusFilter = typeof EgressStatusFilter.Type;

/** TempoOutbound rules that refuse a request (01 and 05: rule 0 app host, 7 placeholder, 10 not allowed). */
export const EGRESS_BLOCK_RULES = [0, 7, 10] as const;

export const RunMode = Schema.Literals(["concurrent", "nonconcurrent"]);

export type RunMode = typeof RunMode.Type;

export const LogLevel = Schema.Literals(["debug", "info", "warn", "error"]);

export type LogLevel = typeof LogLevel.Type;

export const NoticeLevel = Schema.Literals(["info", "warning", "error"]);

export type NoticeLevel = typeof NoticeLevel.Type;
