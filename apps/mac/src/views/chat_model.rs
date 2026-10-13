use std::collections::HashMap;
use tempo_client::state::workspace::{WorkspaceState, is_turn_ended};
use tempo_protocol::{
    AgentId, CredentialStatus, Item, ItemContent, PermissionOption, Session, SessionStatus, Turn,
    TurnStatus,
};

pub const AGENTS: [AgentId; 4] = [
    AgentId::Claude,
    AgentId::Codex,
    AgentId::Opencode,
    AgentId::Pi,
];
pub fn agent_label(agent: AgentId) -> &'static str {
    match agent {
        AgentId::Claude => "Claude Code",
        AgentId::Codex => "Codex",
        AgentId::Opencode => "OpenCode",
        AgentId::Pi => "Pi",
    }
}
pub fn has_login(agent: AgentId, status: &CredentialStatus) -> bool {
    match agent {
        AgentId::Claude => status.claude.set || status.anthropic.set,
        AgentId::Codex => status.codex.set || status.openai.set,
        AgentId::Opencode | AgentId::Pi => status.openrouter.set,
    }
}
pub fn session_title(session: &Session) -> String {
    if session.title.trim().is_empty() {
        agent_label(session.agent).into()
    } else {
        session.title.clone()
    }
}
pub fn workspace_progress(workspace: &tempo_protocol::WorkspaceDetail) -> Option<String> {
    let fallback = match workspace.state {
        tempo_protocol::WorkspaceState::Creating => "Creating the workspace",
        tempo_protocol::WorkspaceState::Starting => "Starting the workspace",
        tempo_protocol::WorkspaceState::SettingUp => "Running setup",
        _ => return None,
    };
    let step = workspace
        .op
        .as_ref()
        .map(|op| op.step.as_str())
        .unwrap_or("");
    let label = match step {
        "" => fallback,
        "container.start" => "Starting container",
        "tempod.connect" => "Connecting",
        "repo.clone" => "Cloning repo",
        "repo.applyCheckpoint" => "Restoring checkpoint",
        "home.restore" => "Restoring home",
        "settings.read" => "Reading settings",
        "setup.run" => "Running setup",
        "sessions.markReload" => "Reloading sessions",
        _ => step,
    };
    Some(label.into())
}

pub fn sessions(state: &WorkspaceState, closed: bool) -> Vec<&Session> {
    let mut sessions: Vec<_> = state
        .sessions
        .values()
        .filter(|s| (s.status == SessionStatus::Closed) == closed)
        .collect();
    sessions.sort_by(|a, b| {
        a.sort_order
            .total_cmp(&b.sort_order)
            .then_with(|| a.id.cmp(&b.id))
    });
    if closed {
        sessions.reverse();
    }
    sessions
}
pub fn running_turn<'a>(state: &'a WorkspaceState, session_id: &str) -> Option<&'a Turn> {
    state
        .turns
        .values()
        .find(|t| t.session_id == session_id && t.status == TurnStatus::Running)
}
pub fn queued_turns<'a>(state: &'a WorkspaceState, session_id: &str) -> Vec<&'a Turn> {
    let mut turns: Vec<_> = state
        .turns
        .values()
        .filter(|t| t.session_id == session_id && t.status == TurnStatus::Queued)
        .collect();
    turns.sort_by(|a, b| {
        a.queue_pos
            .unwrap_or(f64::INFINITY)
            .total_cmp(&b.queue_pos.unwrap_or(f64::INFINITY))
            .then_with(|| a.queued_at.total_cmp(&b.queued_at))
    });
    turns
}
pub fn first_permission_option<'a>(
    options: &'a [PermissionOption],
    kind: &str,
) -> Option<&'a PermissionOption> {
    options
        .iter()
        .find(|o| o.kind == kind || o.kind.starts_with(&format!("{kind}_")))
}
pub fn plan_target(session: &Session, previous: Option<&str>) -> Option<String> {
    let (plan, default) = match session.agent {
        AgentId::Claude => ("plan", "bypassPermissions"),
        AgentId::Codex => ("read-only", "agent-full-access"),
        AgentId::Opencode => ("plan", "build"),
        AgentId::Pi => return None,
    };
    let offered = |id: &str| session.modes.is_empty() || session.modes.iter().any(|m| m.id == id);
    if !offered(plan) {
        return None;
    }
    if session.mode_id.as_deref() != Some(plan) {
        return Some(plan.into());
    }
    previous
        .filter(|p| *p != plan && offered(p))
        .or_else(|| offered(default).then_some(default))
        .map(str::to_string)
        .or_else(|| {
            session
                .modes
                .iter()
                .find(|m| m.id != plan)
                .map(|m| m.id.clone())
        })
}

#[derive(Clone, Debug, PartialEq)]
pub enum RowContent {
    Item { item: Box<Item>, dim: bool },
    Footer { turn: Box<Turn> },
    Working { turn_id: String },
}
impl RowContent {
    pub fn id(&self) -> String {
        match self {
            Self::Item { item, .. } => item.id.clone(),
            Self::Footer { turn } => format!("footer:{}", turn.id),
            Self::Working { turn_id } => format!("working:{turn_id}"),
        }
    }
}

pub fn transcript_rows(state: &WorkspaceState, session_id: &str) -> Vec<RowContent> {
    let mut placed = Vec::new();
    for (index, id) in state
        .order
        .get(session_id)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let Some(item) = state.items.get(id) else {
            continue;
        };
        let turn = item.turn_id.as_deref().and_then(|id| state.turns.get(id));
        let user = matches!(item.content, ItemContent::UserMessage(_));
        if user
            && ((item.turn_id.is_some() && turn.is_none())
                || turn.is_some_and(|t| t.status == TurnStatus::Queued))
        {
            continue;
        }
        let at = if user {
            turn.and_then(|t| t.started_at).unwrap_or(item.created_at)
        } else {
            item.created_at
        };
        placed.push((item, at, !user, index));
    }
    placed.sort_by(|a, b| {
        a.1.total_cmp(&b.1)
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a.3.cmp(&b.3))
    });
    let mut last = HashMap::new();
    for (index, (item, ..)) in placed.iter().enumerate() {
        if let Some(turn_id) = &item.turn_id {
            last.insert(turn_id.as_str(), index);
        }
    }
    let mut rows = Vec::new();
    let mut working = None;
    for (index, (item, ..)) in placed.into_iter().enumerate() {
        let turn = item.turn_id.as_deref().and_then(|id| state.turns.get(id));
        rows.push(RowContent::Item {
            item: Box::new(item.clone()),
            dim: turn.is_some_and(|t| t.reverted),
        });
        if let Some(turn) = turn
            && last.get(turn.id.as_str()) == Some(&index)
        {
            if is_turn_ended(turn.status) {
                rows.push(RowContent::Footer {
                    turn: Box::new(turn.clone()),
                });
            } else if turn.status == TurnStatus::Running {
                working = Some(turn.id.clone());
            }
        }
    }
    if let Some(turn_id) = working {
        rows.push(RowContent::Working { turn_id });
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> WorkspaceState {
        let mut state = WorkspaceState::new();
        for line in include_str!(
            "../../../../packages/protocol/fixtures/channel/workspace-queue-and-scripts.jsonl"
        )
        .lines()
        {
            state.apply(serde_json::from_str(line).unwrap());
        }
        state
    }
    #[test]
    fn queued_prompts_stay_out_of_the_transcript() {
        let state = state();
        for session in state.sessions.values() {
            let rows = transcript_rows(&state, &session.id);
            for row in rows {
                if let RowContent::Item { item, .. } = row
                    && matches!(item.content, ItemContent::UserMessage(_))
                {
                    assert!(item.turn_id.as_ref().is_none_or(|id| {
                        state
                            .turns
                            .get(id)
                            .is_some_and(|t| t.status != TurnStatus::Queued)
                    }));
                }
            }
        }
        assert!(!state.items.is_empty());
    }
    #[test]
    fn plan_toggle_uses_reported_modes_and_returns_to_previous_mode() {
        let mut session = state().sessions.into_values().next().unwrap();
        session.agent = AgentId::Codex;
        session.modes.clear();
        session.mode_id = Some("agent".into());
        assert_eq!(plan_target(&session, None).as_deref(), Some("read-only"));
        session.mode_id = Some("read-only".into());
        assert_eq!(
            plan_target(&session, Some("agent")).as_deref(),
            Some("agent")
        );
        session.agent = AgentId::Pi;
        assert_eq!(plan_target(&session, None), None);
    }
}
