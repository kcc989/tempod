use std::collections::HashMap;
use tempo_client::state::workspace::{WorkspaceState, is_turn_ended};
use tempo_protocol as p;
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
    /// `revertable`: the item's turn has a checkpoint to revert to.
    Item {
        item: Box<Item>,
        dim: bool,
        revertable: bool,
    },
    Footer {
        turn: Box<Turn>,
    },
    Working {
        turn_id: String,
    },
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
            revertable: turn.is_some_and(|t| t.checkpoint_id.is_some()),
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

/// Same as the web `runningPlan`: entry counts of the running turn's latest plan, for the
/// `Plan 3/4` pill.
pub fn running_plan(state: &WorkspaceState, session_id: &str) -> Option<(usize, usize)> {
    let turn = running_turn(state, session_id)?;
    let plan = state
        .order
        .get(session_id)?
        .iter()
        .rev()
        .filter_map(|id| state.items.get(id))
        .filter(|item| item.turn_id.as_deref() == Some(turn.id.as_str()))
        .find_map(|item| match &item.content {
            ItemContent::Plan(plan) => Some(plan),
            _ => None,
        })?;
    let done = plan
        .entries
        .iter()
        .filter(|e| e.status == "completed")
        .count();
    (!plan.entries.is_empty()).then_some((done, plan.entries.len()))
}

/// Which credentials let an agent run (web `AGENT_PROVIDERS`).
pub fn agent_providers(agent: AgentId) -> &'static [p::CredentialProvider] {
    match agent {
        AgentId::Claude => &[
            p::CredentialProvider::Claude,
            p::CredentialProvider::Anthropic,
        ],
        AgentId::Codex => &[p::CredentialProvider::Codex, p::CredentialProvider::Openai],
        AgentId::Opencode | AgentId::Pi => &[p::CredentialProvider::Openrouter],
    }
}

/// The banner above the composer (04, Empty, loading and error states): the error code it shows
/// and its text. A login that stopped working wins over a missing one.
pub fn login_banner(
    agent: AgentId,
    credentials: Option<&CredentialStatus>,
    invalid: &[p::CredentialProvider],
) -> Option<(&'static str, String)> {
    let code = if invalid.iter().any(|p| agent_providers(agent).contains(p)) {
        "CREDENTIAL_INVALID"
    } else if credentials.is_some_and(|c| !has_login(agent, c)) {
        "CREDENTIAL_MISSING"
    } else {
        return None;
    };
    Some((code, crate::errors::error_message(code, Some(agent))))
}

/// Same as the web `STEP_LABELS` and `stepLabel`.
pub fn step_label(step: &str) -> String {
    let known = match step {
        "container.start" => "Starting container",
        "tempod.connect" => "Connecting",
        "repo.clone" => "Cloning repo",
        "repo.applyCheckpoint" => "Restoring checkpoint",
        "home.restore" => "Restoring home",
        "settings.read" => "Reading settings",
        "setup.run" => "Running setup",
        "sessions.markReload" => "Reloading sessions",
        "turns.check" => "Checking turns",
        "turns.cancel" => "Stopping turns",
        "script.archive" => "Running archive script",
        "git.checkpoint" => "Saving checkpoint",
        "bundle.upload" => "Uploading checkpoint",
        "home.backup" => "Backing up home",
        "tempod.shutdown" => "Stopping agents",
        "container.snapshot" => "Saving snapshot",
        "container.destroy" => "Stopping container",
        "github.deleteBranch" => "Deleting branch",
        "branch.check" => "Checking branch",
        "git.revert" => "Reverting files",
        "transcript.mark" => "Updating transcript",
        "git.commitAndPush" => "Committing and pushing",
        "events.prune" => "Pruning events",
        "r2.retention" => "Cleaning up storage",
        "egress.trim" => "Trimming egress log",
        _ => "",
    };
    if !known.is_empty() {
        return known.into();
    }
    let mut spaced = String::new();
    let mut previous = None;
    for c in step
        .chars()
        .map(|c| if c == '.' || c == '_' { ' ' } else { c })
    {
        if c.is_ascii_uppercase() && previous.is_some_and(|p: char| p.is_ascii_lowercase()) {
            spaced.push(' ');
        }
        spaced.push(c);
        previous = Some(c);
    }
    let words = spaced.to_lowercase();
    let mut chars = words.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => step.into(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StepRow {
    pub label: String,
    pub status: p::OpProgressStepsItemStatus,
    /// For example `4 s`; none while the step has not finished.
    pub time: Option<String>,
}

pub fn step_rows(op: &p::OpProgress) -> Vec<StepRow> {
    use p::OpProgressStepsItemStatus as S;
    op.steps
        .iter()
        .map(|s| StepRow {
            label: step_label(&s.name),
            status: s.status,
            time: s
                .ms
                .filter(|_| matches!(s.status, S::Done | S::Failed))
                .map(format_duration),
        })
        .collect()
}

/// The workspace banners (04, Empty, loading and error states), as the web `workspaceBanners`.
#[derive(Clone, Debug, PartialEq)]
pub enum WorkspaceBanner {
    /// `creating`, `starting`, `setting_up`: the op's steps as a checklist.
    Progress {
        title: &'static str,
        steps: Vec<StepRow>,
        setup: bool,
    },
    Error {
        code: String,
        message: String,
        detail: Option<String>,
    },
    SetupFailed,
    Sleeping,
}

pub fn workspace_banners(w: &p::WorkspaceDetail) -> Vec<WorkspaceBanner> {
    use p::WorkspaceState as S;
    let mut out = Vec::new();
    if w.state == S::Error {
        let code = w
            .error_code
            .as_deref()
            .filter(|c| c.parse::<p::ErrorCode>().is_ok())
            .unwrap_or("INTERNAL")
            .to_string();
        out.push(WorkspaceBanner::Error {
            message: crate::errors::error_message(&code, Some(w.default_agent)),
            code,
            detail: w.error_detail.clone(),
        });
    }
    let title = match w.state {
        S::Creating => Some("Creating the workspace"),
        S::Starting => Some("Starting the workspace"),
        S::SettingUp => Some("Running setup"),
        _ => None,
    };
    if let Some(title) = title {
        out.push(WorkspaceBanner::Progress {
            title,
            steps: w.op.as_ref().map(step_rows).unwrap_or_default(),
            setup: w.state == S::SettingUp,
        });
    }
    if w.setup_status == p::SetupStatus::Failed
        && !matches!(w.state, S::Error | S::Archiving | S::Archived)
    {
        out.push(WorkspaceBanner::SetupFailed);
    }
    if w.state == S::Sleeping {
        out.push(WorkspaceBanner::Sleeping);
    }
    out
}

/// Error codes the banners show, so toasts skip them (04, Toasts).
pub fn banner_codes(banners: &[WorkspaceBanner]) -> Vec<String> {
    banners
        .iter()
        .filter_map(|b| match b {
            WorkspaceBanner::Error { code, .. } => Some(code.clone()),
            WorkspaceBanner::SetupFailed => Some("SETUP_FAILED".into()),
            _ => None,
        })
        .collect()
}

/// The image types the attachment route serves inline (02, Attachments).
pub fn is_served_inline(mime: &str) -> bool {
    matches!(
        mime.to_ascii_lowercase().as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

/// Same as the web `formatRelative`, up to a month.
pub fn format_relative(at: f64, now: f64) -> String {
    let s = ((now - at).max(0.) / 1000.).floor();
    if s < 45. {
        return "just now".into();
    }
    let m = (s / 60.).round();
    if m < 60. {
        return format!("{m} min ago");
    }
    let h = (m / 60.).round();
    if h < 24. {
        return format!("{h} h ago");
    }
    let d = (h / 24.).round();
    if d == 1. {
        "yesterday".into()
    } else {
        format!("{d} days ago")
    }
}

/// Same as the web `formatDuration`.
pub fn format_duration(ms: f64) -> String {
    if ms < 1000. {
        return format!("{} ms", ms.max(0.).round());
    }
    let s = (ms / 1000.).round() as u64;
    if s < 60 {
        return format!("{s} s");
    }
    let (m, rest) = (s / 60, s % 60);
    if m < 60 {
        return if rest > 0 {
            format!("{m} min {rest} s")
        } else {
            format!("{m} min")
        };
    }
    format!("{} h {} min", m / 60, m % 60)
}
/// Same as the web `formatTokens`.
pub fn format_tokens(n: f64) -> String {
    if n < 1000. {
        format!("{}", n.round())
    } else if n < 1_000_000. {
        format!("{:.*}k", if n < 10_000. { 1 } else { 0 }, n / 1000.)
    } else {
        format!("{:.1}M", n / 1_000_000.)
    }
}
/// The turn footer (04, Transcript): duration, tokens when the agent sent usage, and how it ended when that is not plain success.
pub fn turn_footer(turn: &Turn) -> String {
    let duration = turn
        .started_at
        .zip(turn.ended_at)
        .map(|(start, end)| format_duration((end - start).max(0.)));
    let tokens = turn.usage.as_ref().map(|u| {
        format!(
            "{} tokens ({} in, {} out)",
            format_tokens(u.total_tokens),
            format_tokens(u.input_tokens),
            format_tokens(u.output_tokens)
        )
    });
    let outcome = match turn.status {
        TurnStatus::Cancelled => Some("Stopped"),
        TurnStatus::Failed => Some("Failed"),
        TurnStatus::Interrupted => Some("Interrupted"),
        _ => match turn.stop_reason.as_deref() {
            Some("max_tokens") => Some("Hit the token limit"),
            Some("max_turn_requests") => Some("Hit the request limit"),
            Some("refusal") => Some("The agent refused"),
            _ => None,
        },
    };
    [duration, tokens, outcome.map(String::from)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn turn_footer_matches_the_web_copy() {
        let mut turn = state().turns.into_values().next().unwrap();
        turn.status = TurnStatus::Completed;
        turn.stop_reason = Some("end_turn".into());
        turn.started_at = Some(1_000.);
        turn.ended_at = Some(13_000.);
        turn.usage = None;
        assert_eq!(turn_footer(&turn), "12 s");
        turn.usage = Some(tempo_protocol::TurnUsage {
            total_tokens: 15_300.,
            input_tokens: 12_000.,
            output_tokens: 3_300.,
            thought_tokens: None,
            cached_read_tokens: None,
            cached_write_tokens: None,
        });
        assert_eq!(turn_footer(&turn), "12 s · 15k tokens (12k in, 3.3k out)");
        turn.status = TurnStatus::Cancelled;
        turn.usage = None;
        assert_eq!(turn_footer(&turn), "12 s · Stopped");
        assert_eq!(format_duration(125_000.), "2 min 5 s");
        assert_eq!(format_tokens(999.), "999");
    }
    #[test]
    fn banners_follow_the_web_model() {
        let mut w = state().workspace.unwrap();
        w.state = p::WorkspaceState::Starting;
        w.setup_status = p::SetupStatus::None;
        w.op = Some(p::OpProgress {
            kind: p::OpKind::Wake,
            status: p::OpStatus::Running,
            step: "repo.clone".into(),
            steps: vec![
                p::OpProgressStepsItem {
                    name: "container.start".into(),
                    status: p::OpProgressStepsItemStatus::Done,
                    ms: Some(4_200.),
                },
                p::OpProgressStepsItem {
                    name: "repo.clone".into(),
                    status: p::OpProgressStepsItemStatus::Running,
                    ms: Some(900.),
                },
                p::OpProgressStepsItem {
                    name: "cache.warmUp_now".into(),
                    status: p::OpProgressStepsItemStatus::Pending,
                    ms: None,
                },
            ],
        });
        let WorkspaceBanner::Progress {
            title,
            steps,
            setup,
        } = &workspace_banners(&w)[0]
        else {
            panic!("progress");
        };
        assert_eq!((*title, *setup), ("Starting the workspace", false));
        let rows: Vec<_> = steps
            .iter()
            .map(|s| (s.label.as_str(), s.time.as_deref()))
            .collect();
        assert_eq!(
            rows,
            [
                ("Starting container", Some("4 s")),
                ("Cloning repo", None),
                ("Cache warm up now", None)
            ]
        );
        w.state = p::WorkspaceState::Error;
        w.error_code = Some("CLONE_FAILED".into());
        w.error_detail = Some("fatal: repository not found".into());
        w.setup_status = p::SetupStatus::Failed;
        let banners = workspace_banners(&w);
        assert_eq!(
            banners,
            [WorkspaceBanner::Error {
                code: "CLONE_FAILED".into(),
                message: "Could not clone the repo.".into(),
                detail: Some("fatal: repository not found".into()),
            }]
        );
        assert_eq!(banner_codes(&banners), ["CLONE_FAILED"]);
        w.error_code = Some("NOT_A_CODE".into());
        assert!(
            matches!(&workspace_banners(&w)[0], WorkspaceBanner::Error { code, message, .. }
            if code == "INTERNAL" && message == "Something went wrong.")
        );
        w.state = p::WorkspaceState::Sleeping;
        let banners = workspace_banners(&w);
        assert_eq!(
            banners,
            [WorkspaceBanner::SetupFailed, WorkspaceBanner::Sleeping]
        );
        assert_eq!(banner_codes(&banners), ["SETUP_FAILED"]);
        w.state = p::WorkspaceState::SettingUp;
        w.setup_status = p::SetupStatus::Running;
        assert!(matches!(
            &workspace_banners(&w)[..],
            [WorkspaceBanner::Progress {
                title: "Running setup",
                setup: true,
                ..
            }]
        ));
    }
    #[test]
    fn login_banner_prefers_an_invalid_login_and_names_the_agent() {
        let status: CredentialStatus = serde_json::from_str(r#"{"claude":{"set":false,"updatedAt":null},"anthropic":{"set":false,"updatedAt":null},"openai":{"set":true,"updatedAt":null},"openrouter":{"set":false,"updatedAt":null},"codex":{"set":false,"updatedAt":null,"lastRefresh":null}}"#).unwrap();
        assert_eq!(
            login_banner(AgentId::Claude, Some(&status), &[]),
            Some((
                "CREDENTIAL_MISSING",
                "Add your Claude login in Settings.".into()
            ))
        );
        assert_eq!(login_banner(AgentId::Codex, Some(&status), &[]), None);
        assert_eq!(login_banner(AgentId::Codex, None, &[]), None);
        assert_eq!(
            login_banner(
                AgentId::Codex,
                Some(&status),
                &[p::CredentialProvider::Openai]
            ),
            Some((
                "CREDENTIAL_INVALID",
                "Your Codex login stopped working. Add it again.".into()
            ))
        );
        assert_eq!(
            login_banner(AgentId::Pi, None, &[p::CredentialProvider::Openai]),
            None
        );
    }
    #[test]
    fn plan_pill_counts_only_the_running_turn() {
        let mut state = state();
        let session = state.sessions.keys().next().unwrap().clone();
        let mut turn = state.turns.values().next().unwrap().clone();
        turn.session_id = session.clone();
        turn.status = TurnStatus::Completed;
        state.turns.clear();
        state.turns.insert(turn.id.clone(), turn.clone());
        let mut item = state.items.values().next().unwrap().clone();
        item.id = "plan-item".into();
        item.session_id = session.clone();
        item.turn_id = Some(turn.id.clone());
        let entry = |status: &str| tempo_protocol::PlanEntry {
            content: "Step".into(),
            priority: "medium".into(),
            status: status.into(),
        };
        item.content = ItemContent::Plan(tempo_protocol::PlanContent {
            entries: vec![
                entry("completed"),
                entry("completed"),
                entry("completed"),
                entry("in_progress"),
            ],
        });
        state.items.insert(item.id.clone(), item.clone());
        state
            .order
            .entry(session.clone())
            .or_default()
            .push(item.id.clone());
        assert_eq!(running_plan(&state, &session), None);
        state.turns.get_mut(&turn.id).unwrap().status = TurnStatus::Running;
        assert_eq!(running_plan(&state, &session), Some((3, 4)));
    }
    #[test]
    fn small_formatters_match_the_web() {
        assert_eq!(step_label("home.restore"), "Restoring home");
        assert_eq!(step_label(""), "");
        assert!(is_served_inline("IMAGE/PNG") && !is_served_inline("image/avif"));
        assert_eq!(format_relative(0., 10_000.), "just now");
        assert_eq!(format_relative(0., 5. * 60_000.), "5 min ago");
        assert_eq!(format_relative(0., 3. * 3_600_000.), "3 h ago");
        assert_eq!(format_relative(0., 30. * 3_600_000.), "yesterday");
        assert_eq!(format_relative(0., 72. * 3_600_000.), "3 days ago");
    }
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
