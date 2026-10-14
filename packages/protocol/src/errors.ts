import { Schema } from "effect";

export const ERROR_MESSAGES = {
  AGENT_INVALID: "The agent is not valid.",
  AGENT_LIMIT: "You have the most agents allowed. Delete one first.",
  AGENT_NAME_TAKEN: "Another agent has this name or handle.",
  ATTACHMENT_INVALID: "The agent's hooks or limits are not valid.",
  UNAUTHENTICATED: "Sign in to continue.",
  FORBIDDEN: "This Tempo belongs to someone else.",
  NOT_FOUND: "Not found.",
  VALIDATION_FAILED: "Check the highlighted fields.",
  PROJECT_EXISTS: "This repo is already a project.",
  PROJECT_HAS_WORKSPACES: "Archive this project's workspaces first.",
  REPO_NOT_ACCESSIBLE: "This repository is not accessible.",
  ARTIFACTS_NOT_CONFIGURED: "Configure the Cloudflare Artifacts binding to host repositories.",
  ARTIFACTS_API_ERROR: "Cloudflare Artifacts could not complete the request.",
  BRANCH_IN_USE: "Another workspace uses this branch.",
  BRANCH_INVALID: "That branch name is not valid.",
  BRANCH_ALREADY_PUSHED: "You can't rename a branch after it is pushed.",
  WORKSPACE_ARCHIVED: "Restore this workspace first.",
  WORKSPACE_NOT_ARCHIVED: "Archive this workspace first.",
  WORKSPACE_BUSY: "Wait for the current step to finish.",
  SESSION_BUSY: "Wait for the agent to finish, or stop it.",
  TURN_NOT_ACTIVE: "Nothing to stop.",
  TURN_NOT_QUEUED: "That message was already sent.",
  CONTAINER_START_FAILED: "The container did not start. Retry.",
  CONTAINER_NOT_READY: "The workspace is waking up. Try again in a moment.",
  TEMPOD_UNREACHABLE: "Lost contact with the workspace. Reconnecting.",
  TEMPOD_TIMEOUT: "The workspace did not answer in time.",
  UNKNOWN_OP: "This workspace needs a restart for that action.",
  CLONE_FAILED: "Could not clone the repo.",
  SETUP_FAILED: "Setup failed. See the Setup tab.",
  CREDENTIAL_MISSING: "Add your <agent> login in Settings.",
  CREDENTIAL_INVALID: "Your <agent> login stopped working. Add it again.",
  AGENT_START_FAILED: "The agent did not start.",
  AGENT_CRASHED: "The agent stopped unexpectedly.",
  NOTHING_TO_COMMIT: "Nothing to commit.",
  PUSH_REJECTED: "Push was rejected. Pull or rebase first.",
  NOT_PUSHED: "Push the branch first.",
  PR_EXISTS: "A pull request already exists.",
  PR_NOT_MERGEABLE: "This pull request can't be merged yet.",
  CI_PIPELINE_INVALID: "The CI pipeline is not valid.",
  CI_PIPELINE_CHANGED: "The CI pipeline changed. Reload it and try again.",
  CI_NOT_CONFIGURED: "Add a CI pipeline for this repository first.",
  GITHUB_API_ERROR: "GitHub returned an error.",
  FILE_TOO_LARGE: "This file is too large to show.",
  PATH_OUTSIDE_WORKSPACE: "That path is outside the workspace.",
  CHECKPOINT_NOT_FOUND: "That checkpoint no longer exists.",
  ARTIFACT_NOT_READY: "This artifact is still being saved. Try again in a moment.",
  MODEL_REQUIRED: "Set a default model for this agent in Settings → Project.",
  SETTINGS_INVALID: "Settings are not valid.",
  ENVIRONMENT_EXISTS: "An environment with this name already exists.",
  EGRESS_BLOCKED: "(Shown only in the egress log.)",
  EVENT_INVALID: "(Logged only.)",
  RUN_LIMIT: "This agent ran the most times allowed for this change.",
  RUN_NO_AGENT: "No agent can run this. Add a login in Settings.",
  RUN_TURN_FAILED: "The agent stopped before it finished.",
  RUN_RESULT_MISSING: "The agent did not report a result.",
  RUN_ACCESS_VIOLATION: "The agent changed protected login files.",
  RUN_TIMED_OUT: "The agent ran out of time.",
  RUN_NOT_RUNNING: "The run is not running.",
  RUN_NOT_COMPLETED: "The run has no result yet.",
  RUN_ALREADY_SENT: "This result is already in the chat.",
  RUN_NO_CHAT: "This run has no chat to send to.",
  INTERNAL: "Something went wrong.",
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

// SAFETY: ERROR_MESSAGES is a closed literal whose enumerable keys are exactly the ErrorCode union.
export const ERROR_CODES = Object.keys(ERROR_MESSAGES) as ReadonlyArray<ErrorCode>;

export const ErrorCodeSchema = Schema.Literals(ERROR_CODES);

export const ErrorBody = Schema.Struct({
  code: ErrorCodeSchema,
  message: Schema.String,
  detail: Schema.optional(Schema.String),
});

export type ErrorBody = typeof ErrorBody.Type;

export const AGENT_LABELS = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi" } as const;

export const errorMessage = (code: ErrorCode, agent?: keyof typeof AGENT_LABELS): string => {
  const text: string = ERROR_MESSAGES[code];

  return agent ? text.replace("<agent>", AGENT_LABELS[agent]) : text.replace("<agent> ", "");
};

/** The one error type that crosses every boundary (server functions, DO RPC, tempod). */
export class TempoError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  constructor(code: ErrorCode, message?: string, detail?: string) {
    super(message ?? errorMessage(code));
    this.name = "TempoError";
    this.code = code;
    this.detail = detail;
  }
  toBody(): ErrorBody {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
  static fromBody(body: ErrorBody): TempoError {
    return new TempoError(body.code, body.message, body.detail);
  }
  static is(u: unknown): u is TempoError {
    return u instanceof TempoError;
  }
}

/** Result envelope used where thrown errors would lose their code (DO RPC, server functions). */
export type Result<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: ErrorBody };

export const ok = <A>(value: A): Result<A> => ({ ok: true, value });

export const err = (error: ErrorBody): Result<never> => ({ ok: false, error });

export const toErrorBody = (cause: unknown): ErrorBody => {
  if (cause instanceof TempoError) return cause.toBody();

  if (isErrorBody(cause)) return cause;

  return { code: "INTERNAL", message: errorMessage("INTERNAL") };
};

export const isErrorBody = Schema.is(ErrorBody);

export const unwrap = <A>(result: Result<A>): A => {
  if (result.ok) return result.value;
  throw TempoError.fromBody(result.error);
};

export const capture = async <A>(f: () => Promise<A> | A): Promise<Result<A>> => {
  try {
    return ok(await f());
  } catch (cause) {
    return err(toErrorBody(cause));
  }
};
