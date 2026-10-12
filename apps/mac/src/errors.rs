//! The UI message for each error code (02, Error codes). Same text as `errorMessage` in `packages/protocol`.

pub fn error_text(code: &str) -> &'static str {
    match code {
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
        "MODEL_REQUIRED" => "Set a default model for this agent in Settings → Project.",
        "SETTINGS_INVALID" => "Settings are not valid.",
        "EGRESS_BLOCKED" => "(Shown only in the egress log.)",
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
