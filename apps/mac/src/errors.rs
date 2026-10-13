//! The UI message for each error code (02, Error codes). Same text as `errorMessage` in `packages/protocol`.

pub fn error_text(code: &str) -> &'static str {
    match code {
        "AGENT_INVALID" => "The agent is not valid.",
        "AGENT_LIMIT" => "You have the most agents allowed. Delete one first.",
        "AGENT_NAME_TAKEN" => "Another agent has this name or handle.",
        "ATTACHMENT_INVALID" => "The agent's hooks or limits are not valid.",
        "UNAUTHENTICATED" => "Sign in to continue.",
        "FORBIDDEN" => "This Tempo belongs to someone else.",
        "NOT_FOUND" => "Not found.",
        "VALIDATION_FAILED" => "Check the highlighted fields.",
        "PROJECT_EXISTS" => "This repo is already a project.",
        "PROJECT_HAS_WORKSPACES" => "Archive this project's workspaces first.",
        "REPO_NOT_ACCESSIBLE" => "Install the GitHub App on this repo.",
        "BRANCH_IN_USE" => "Another workspace uses this branch.",
        "BRANCH_INVALID" => "That branch name is not valid.",
        "BRANCH_ALREADY_PUSHED" => "You can't rename a branch after it is pushed.",
        "WORKSPACE_ARCHIVED" => "Restore this workspace first.",
        "WORKSPACE_NOT_ARCHIVED" => "Archive this workspace first.",
        "WORKSPACE_BUSY" => "Wait for the current step to finish.",
        "SESSION_BUSY" => "Wait for the agent to finish, or stop it.",
        "TURN_NOT_ACTIVE" => "Nothing to stop.",
        "TURN_NOT_QUEUED" => "That message was already sent.",
        "CONTAINER_START_FAILED" => "The container did not start. Retry.",
        "CONTAINER_NOT_READY" => "The workspace is waking up. Try again in a moment.",
        "TEMPOD_UNREACHABLE" => "Lost contact with the workspace. Reconnecting.",
        "TEMPOD_TIMEOUT" => "The workspace did not answer in time.",
        "UNKNOWN_OP" => "This workspace needs a restart for that action.",
        "CLONE_FAILED" => "Could not clone the repo.",
        "SETUP_FAILED" => "Setup failed. See the Setup tab.",
        "CREDENTIAL_MISSING" => "Add your <agent> login in Settings.",
        "CREDENTIAL_INVALID" => "Your <agent> login stopped working. Add it again.",
        "AGENT_START_FAILED" => "The agent did not start.",
        "AGENT_CRASHED" => "The agent stopped unexpectedly.",
        "NOTHING_TO_COMMIT" => "Nothing to commit.",
        "PUSH_REJECTED" => "Push was rejected. Pull or rebase first.",
        "NOT_PUSHED" => "Push the branch first.",
        "PR_EXISTS" => "A pull request already exists.",
        "PR_NOT_MERGEABLE" => "This pull request can't be merged yet.",
        "GITHUB_API_ERROR" => "GitHub returned an error.",
        "FILE_TOO_LARGE" => "This file is too large to show.",
        "PATH_OUTSIDE_WORKSPACE" => "That path is outside the workspace.",
        "CHECKPOINT_NOT_FOUND" => "That checkpoint no longer exists.",
        "ARTIFACT_NOT_READY" => "This artifact is still being saved. Try again in a moment.",
        "ENVIRONMENT_EXISTS" => "An environment with this name already exists.",
        "MODEL_REQUIRED" => "Set a default model for this agent in Settings → Project.",
        "SETTINGS_INVALID" => "Settings are not valid.",
        "CUSTOM_AGENT_EXISTS" => "You already have an agent with this name.",
        "CUSTOM_AGENT_LIMIT" => "You have the most custom agents allowed. Delete one first.",
        "ARTIFACTS_ERROR" => "Could not reach agent storage. Try again.",
        "EGRESS_BLOCKED" => "(Shown only in the egress log.)",
        "EVENT_INVALID" => "(Logged only.)",
        "RUN_LIMIT" => "This agent ran the most times allowed for this change.",
        "RUN_NO_AGENT" => "No agent can run this. Add a login in Settings.",
        "RUN_TURN_FAILED" => "The agent stopped before it finished.",
        "RUN_RESULT_MISSING" => "The agent did not report a result.",
        "RUN_ACCESS_VIOLATION" => "The agent changed protected login files.",
        "RUN_TIMED_OUT" => "The agent ran out of time.",
        "RUN_NOT_RUNNING" => "The run is not running.",
        "RUN_NOT_COMPLETED" => "The run has no result yet.",
        "RUN_ALREADY_SENT" => "This result is already in the chat.",
        "RUN_NO_CHAT" => "This run has no chat to send to.",
        "ROLE_NOT_FOUND" => "No role with that name.",
        "ROLE_NOT_REQUESTABLE" => "This role can't be started by hand.",
        "ROLE_INVALID" => "The role file is not valid.",
        "ROLE_LIMIT" => "A role limit stopped this run.",
        "ROLE_NO_AGENT" => "No agent can run this role. Add a login in Settings.",
        "ROLE_TURN_FAILED" => "The role's agent stopped before it finished.",
        "ROLE_RESULT_MISSING" => "The role did not report a result.",
        "ROLE_RESULT_INVALID" => "The role's result was not valid.",
        "ROLE_ACCESS_VIOLATION" => "This read-only role changed files.",
        "ROLE_TIMED_OUT" => "The role ran out of time.",
        _ => "Something went wrong.",
    }
}

/// Agent names as the web `AGENT_LABELS` (used only inside error text).
pub fn agent_error_label(agent: tempo_protocol::AgentId) -> &'static str {
    match agent {
        tempo_protocol::AgentId::Claude => "Claude",
        tempo_protocol::AgentId::Codex => "Codex",
        tempo_protocol::AgentId::Opencode => "OpenCode",
        tempo_protocol::AgentId::Pi => "Pi",
    }
}

/// The message for `code`, with `<agent>` filled in, or dropped when no agent is known.
pub fn error_message(code: &str, agent: Option<tempo_protocol::AgentId>) -> String {
    let text = error_text(code);
    match agent {
        Some(agent) => text.replace("<agent>", agent_error_label(agent)),
        None => text.replace("<agent> ", ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempo_protocol::AgentId;

    #[test]
    fn messages_match_the_error_table() {
        assert_eq!(
            error_message("CLONE_FAILED", None),
            "Could not clone the repo."
        );
        assert_eq!(
            error_message("CREDENTIAL_INVALID", Some(AgentId::Codex)),
            "Your Codex login stopped working. Add it again."
        );
        assert_eq!(
            error_message("CREDENTIAL_MISSING", None),
            "Add your login in Settings."
        );
        assert_eq!(
            error_message("MODEL_REQUIRED", Some(AgentId::Pi)),
            "Set a default model for this agent in Settings → Project."
        );
        assert_eq!(
            error_message("SOMETHING_NEW", None),
            "Something went wrong."
        );
    }

    #[test]
    fn every_code_in_the_typescript_table_has_its_text() {
        let ts = include_str!("../../../packages/protocol/src/errors.ts");
        let table = ts.split("ERROR_MESSAGES = {").nth(1).unwrap();
        let table = table.split("} as const").next().unwrap();
        for line in table.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let (code, text) = line.split_once(": ").unwrap();
            let text = text.trim_end_matches(',').trim_matches('"');
            assert_eq!(error_text(code), text, "{code}");
        }
    }
}
