pub use crate::storage::TranscriptDetail;
use std::collections::{HashMap, HashSet};
use tempo_client::state::workspace::{WorkspaceState, is_turn_ended};
use tempo_protocol as p;
use tempo_protocol::{
    AgentId, CredentialStatus, Item, ItemContent, ItemStatus, PermissionOption, Session,
    SessionStatus, ToolCallItemContent, Turn, TurnStatus,
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
pub fn new_chat_agents(credentials: Option<&CredentialStatus>) -> Vec<AgentId> {
    AGENTS
        .into_iter()
        .filter(|agent| credentials.is_some_and(|c| has_login(*agent, c)))
        .collect()
}
pub const NO_LOGIN_HINT: &str = "Add login in Settings";
pub const NO_MODEL_HINT: &str = "Set a model in Settings → Project";
pub const LOADING_LOGINS_HINT: &str = "Loading logins…";

/// OpenCode and Pi need `agent.models.<agent>` to start (01, Agents: Model choice).
pub fn needs_model(agent: AgentId, settings: &p::Settings) -> bool {
    let models = &settings.agent.models;
    match agent {
        AgentId::Claude | AgentId::Codex => false,
        AgentId::Opencode => models.opencode.is_empty(),
        AgentId::Pi => models.pi.is_empty(),
    }
}

/// Why New chat shows `agent` disabled (04, Tabs), or `None` when it can start.
pub fn new_chat_hint(
    agent: AgentId,
    credentials: Option<&CredentialStatus>,
    settings: Option<&p::Settings>,
) -> Option<&'static str> {
    match credentials {
        None => Some(LOADING_LOGINS_HINT),
        Some(c) if !has_login(agent, c) => Some(NO_LOGIN_HINT),
        _ if settings.is_some_and(|s| needs_model(agent, s)) => Some(NO_MODEL_HINT),
        _ => None,
    }
}
pub fn session_title(session: &Session) -> String {
    if !session.title.trim().is_empty() {
        session.title.clone()
    } else if let Some(name) = &session.agent_name {
        name.clone()
    } else {
        agent_label(session.agent).into()
    }
}
/// A chat from a library agent names its base agent (04, Tabs).
pub fn session_tooltip(session: &Session) -> Option<String> {
    session
        .agent_name
        .as_ref()
        .map(|c| format!("{} · {}", c, agent_label(session.agent)))
}
pub fn sessions(state: &WorkspaceState, closed: bool) -> Vec<&Session> {
    let mut sessions: Vec<_> = state
        .sessions
        .values()
        .filter(|s| s.run_id.is_none() && (s.status == SessionStatus::Closed) == closed)
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
pub fn is_initial_prompt(turn: &Turn) -> bool {
    turn.seq == 1. && turn.status == TurnStatus::Queued && turn.steering_pending != Some(true)
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
pub fn reordered_queue(state: &WorkspaceState, dragged: &str, before: &str) -> Option<Vec<String>> {
    let mut turns: Vec<_> = state
        .turns
        .values()
        .filter(|turn| turn.status == TurnStatus::Queued)
        .collect();
    turns.sort_by(|a, b| {
        a.queue_pos
            .unwrap_or(f64::INFINITY)
            .total_cmp(&b.queue_pos.unwrap_or(f64::INFINITY))
            .then_with(|| a.queued_at.total_cmp(&b.queued_at))
    });
    let mut movable: Vec<_> = turns
        .iter()
        .filter(|turn| !is_initial_prompt(turn))
        .map(|turn| turn.id.clone())
        .collect();
    if dragged == before || !movable.iter().any(|id| id == dragged) {
        return None;
    }
    movable.retain(|id| id != dragged);
    let index = movable.iter().position(|id| id == before)?;
    movable.insert(index, dragged.into());
    let mut moved = movable.into_iter();
    Some(
        turns
            .into_iter()
            .map(|turn| {
                if is_initial_prompt(turn) {
                    turn.id.clone()
                } else {
                    moved.next().unwrap()
                }
            })
            .collect(),
    )
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
        AgentId::Claude => ("plan", "auto"),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Read,
    Search,
    List,
}

/// Work types (04, Center).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkType {
    Explore,
    Edit,
    Run,
    Web,
    SubAgent,
    Other,
}

fn strip_cd(command: &str) -> &str {
    let Some(rest) = command.strip_prefix("cd") else {
        return command;
    };
    if !rest.starts_with(char::is_whitespace) {
        return command;
    }
    let rest = rest.trim_start();
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ';' || c == '&')
        .unwrap_or(rest.len());
    if end == 0 {
        return command;
    }
    let after = rest[end..].trim_start();
    after
        .strip_prefix("&&")
        .or_else(|| after.strip_prefix(';'))
        .map(str::trim_start)
        .unwrap_or(command)
}

/// The verb and label of a single read, search or list command (04, Tool call labels).
pub fn command_intent(command: &str) -> Option<(Verb, String)> {
    let command = strip_cd(command.trim());
    if command.contains([';', '\n']) || command.contains("&&") || command.contains("||") {
        return None;
    }
    let mut pipes = command.split('|');
    let head = pipes.next().unwrap_or("");
    if !pipes.all(|p| {
        let word = p.split_whitespace().next();
        word == Some("head") || word == Some("tail")
    }) {
        return None;
    }
    let mut words = head.split_whitespace();
    let word = words.next()?;
    let mut args: Vec<&str> = words.collect();
    let verb = match word {
        "sed" if args.first() == Some(&"-n") => {
            args.remove(0);
            Verb::Read
        }
        "cat" | "head" | "tail" | "less" | "nl" | "wc" => Verb::Read,
        "rg" | "grep" | "find" | "fd" | "ag" => Verb::Search,
        "ls" | "tree" => Verb::List,
        _ => return None,
    };
    let name = match verb {
        Verb::Read => "Read",
        Verb::Search => "Search",
        Verb::List => "List",
    };
    Some((
        verb,
        std::iter::once(name)
            .chain(args)
            .collect::<Vec<_>>()
            .join(" "),
    ))
}

fn input_str<'a>(tool: &'a ToolCallItemContent, key: &str) -> Option<&'a str> {
    tool.raw_input.as_ref()?.get(key)?.as_str()
}

fn command(tool: &ToolCallItemContent) -> &str {
    input_str(tool, "command")
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or(&tool.title)
}

fn execute_intent(tool: &ToolCallItemContent) -> Option<(Verb, String)> {
    (tool.tool_kind.as_deref() == Some("execute"))
        .then(|| command_intent(command(tool)))
        .flatten()
}

pub fn work_type(tool: &ToolCallItemContent) -> WorkType {
    match tool.tool_kind.as_deref() {
        Some("read" | "search") => WorkType::Explore,
        Some("edit" | "delete" | "move") => WorkType::Edit,
        Some("execute") if execute_intent(tool).is_some() => WorkType::Explore,
        Some("execute") => WorkType::Run,
        Some("fetch") => WorkType::Web,
        Some("think")
            if input_str(tool, "subagent_type").is_some()
                || (input_str(tool, "prompt").is_some()
                    && input_str(tool, "description").is_some()) =>
        {
            WorkType::SubAgent
        }
        _ => WorkType::Other,
    }
}

/// The row label and whether it shows in monospace (04, Tool call labels).
pub fn tool_label(tool: &ToolCallItemContent) -> (String, bool) {
    if tool.tool_kind.as_deref() != Some("execute") {
        return (tool.title.clone(), false);
    }
    if let Some(description) = input_str(tool, "description")
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        return (description.into(), false);
    }
    match execute_intent(tool) {
        Some((_, label)) => (label, false),
        None => (tool.title.clone(), true),
    }
}

fn is_search(tool: &ToolCallItemContent) -> bool {
    tool.tool_kind.as_deref() == Some("search")
        || matches!(execute_intent(tool), Some((Verb::Search, _)))
}

fn diff_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .collect()
}

const MAX_LCS_CELLS: usize = 4_000_000;

/// Lines added and removed by a minimal line diff.
pub fn line_counts(old: &str, new: &str) -> (usize, usize) {
    let (a, b) = (diff_lines(old), diff_lines(new));
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let (a, b) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    if a.len() * b.len() > MAX_LCS_CELLS {
        return (b.len(), a.len());
    }
    let mut row = vec![0usize; b.len() + 1];
    for x in a {
        let mut diagonal = 0;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if x == y {
                diagonal + 1
            } else {
                above.max(row[j])
            };
            diagonal = above;
        }
    }
    let common = row[b.len()];
    (b.len() - common, a.len() - common)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditCounts {
    pub path: String,
    pub added: usize,
    pub removed: usize,
}

impl EditCounts {
    pub fn file_name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }
}

/// File and `+`/`−` counts of an edit call, from its diff content (04, Edit rows).
pub fn edit_counts(tool: &ToolCallItemContent) -> EditCounts {
    let mut counts = EditCounts {
        path: String::new(),
        added: 0,
        removed: 0,
    };
    for block in &tool.content {
        if block.type_ != "diff" {
            continue;
        }
        let text = |key| block.extra.get(key).and_then(|v| v.as_str()).unwrap_or("");
        if counts.path.is_empty() {
            counts.path = text("path").into();
        }
        let (added, removed) = line_counts(text("oldText"), text("newText"));
        counts.added += added;
        counts.removed += removed;
    }
    if counts.path.is_empty()
        && let Some(location) = tool.locations.first()
    {
        counts.path = location.path.clone();
    }
    counts
}

/// The house duration format: `450 ms`, `48 s`, `3 min 12 s`, `1 h 5 min`.
pub fn format_duration(ms: f64) -> String {
    let ms = ms.max(0.);
    if ms < 1000. {
        return format!("{} ms", ms.round() as u64);
    }
    let s = (ms / 1000.).round() as u64;
    match (s / 3600, s / 60 % 60, s % 60) {
        (0, 0, s) => format!("{s} s"),
        (0, m, 0) => format!("{m} min"),
        (0, m, s) => format!("{m} min {s} s"),
        (h, m, _) => format!("{h} h {m} min"),
    }
}

fn count(n: usize, one: &str, many: &str) -> Option<String> {
    match n {
        0 => None,
        1 => Some(one.into()),
        n => Some(many.replace("<n>", &n.to_string())),
    }
}

/// The collapsed text of a work row (04, Work row).
pub fn work_summary(folded: &[Item], duration_ms: Option<f64>) -> String {
    let mut paths = HashSet::new();
    let (mut files, mut searches, mut commands, mut pages, mut agents, mut tools, mut thoughts) =
        (0, 0, 0, 0, 0, 0, 0);
    for item in folded {
        match &item.content {
            ItemContent::AgentThought(_) => thoughts += 1,
            ItemContent::ToolCall(tool) => match work_type(tool) {
                WorkType::Explore if is_search(tool) => searches += 1,
                WorkType::Explore if tool.locations.is_empty() => files += 1,
                WorkType::Explore => paths.extend(tool.locations.iter().map(|l| &l.path)),
                WorkType::Run => commands += 1,
                WorkType::Web => pages += 1,
                WorkType::SubAgent => agents += 1,
                WorkType::Edit | WorkType::Other => tools += 1,
            },
            _ => {}
        }
    }
    files += paths.len();
    let mut parts: Vec<String> = [
        count(files, "explored 1 file", "explored <n> files"),
        count(searches, "1 search", "<n> searches"),
        count(commands, "ran 1 command", "ran <n> commands"),
        count(pages, "fetched 1 page", "fetched <n> pages"),
        count(agents, "ran 1 agent", "ran <n> agents"),
        count(tools, "used 1 tool", "used <n> tools"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if parts.is_empty()
        && let Some(part) = count(thoughts, "thought 1 time", "thought <n> times")
    {
        parts.push(part);
    }
    parts.extend(duration_ms.map(format_duration));
    let text = parts.join(" · ");
    let mut chars = text.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// 04 Plan proposals: a tool call whose `rawInput.plan` is a non-empty string.
pub fn plan_proposal_text(tool: &tempo_protocol::ToolCallItemContent) -> Option<String> {
    tool.raw_input
        .as_ref()
        .and_then(|raw| raw.get("plan"))
        .and_then(|plan| plan.as_str())
        .filter(|plan| !plan.trim().is_empty())
        .map(str::to_string)
}

/// True when Default detail folds the item into its turn's work row.
pub fn folds_into_work(item: &Item, last_message: Option<&str>) -> bool {
    match &item.content {
        ItemContent::AgentThought(_) => true,
        ItemContent::AgentMessage(_) => last_message != Some(item.id.as_str()),
        ItemContent::ToolCall(tool) => {
            !matches!(item.status, ItemStatus::Failed | ItemStatus::Cancelled)
                && work_type(tool) != WorkType::Edit
                && plan_proposal_text(tool).is_none()
        }
        _ => false,
    }
}

/// The label of the newest call in a running work row, or `Thinking` after a thought.
pub fn current_step(folded: &[Item]) -> Option<String> {
    folded.iter().rev().find_map(|item| match &item.content {
        ItemContent::ToolCall(tool) => Some(tool_label(tool).0),
        ItemContent::AgentThought(_) => Some("Thinking".into()),
        _ => None,
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
    Work {
        turn: Box<Turn>,
        items: Vec<Item>,
        dim: bool,
    },
    Footer {
        turn: Box<Turn>,
        work_row: bool,
    },
    Working {
        turn_id: String,
    },
    Startup {
        title: String,
        setup: bool,
    },
}
impl RowContent {
    pub fn id(&self) -> String {
        match self {
            Self::Item { item, .. } => item.id.clone(),
            Self::Work { turn, .. } => format!("work:{}", turn.id),
            Self::Footer { turn, .. } => format!("footer:{}", turn.id),
            Self::Working { turn_id } => format!("working:{turn_id}"),
            Self::Startup { .. } => "workspace-startup".into(),
        }
    }
}

pub fn transcript_rows(
    state: &WorkspaceState,
    session_id: &str,
    detail: TranscriptDetail,
) -> Vec<RowContent> {
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
                || turn.is_some_and(|t| t.status == TurnStatus::Queued && !is_initial_prompt(t)))
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
    let mut placed: Vec<&Item> = placed.into_iter().map(|p| p.0).collect();
    // A plan proposal's permission shows right under its card (04, Plan proposals).
    let plans: HashMap<&str, &str> = placed
        .iter()
        .filter_map(|item| match &item.content {
            ItemContent::ToolCall(tool) if plan_proposal_text(tool).is_some() => {
                Some((tool.tool_call_id.as_str(), item.id.as_str()))
            }
            _ => None,
        })
        .collect();
    let moved: Vec<(String, &Item)> = placed
        .iter()
        .filter_map(|item| match &item.content {
            ItemContent::Permission(p) => p
                .tool_call_id
                .as_deref()
                .and_then(|t| plans.get(t))
                .map(|plan| (plan.to_string(), *item)),
            _ => None,
        })
        .collect();
    for (plan, permission) in moved {
        placed.retain(|i| i.id != permission.id);
        if let Some(at) = placed.iter().position(|i| i.id == plan) {
            placed.insert(at + 1, permission);
        }
    }
    let turn_of = |item: &Item| item.turn_id.as_deref().and_then(|id| state.turns.get(id));
    let mut last = HashMap::new();
    let mut last_message = HashMap::new();
    for (index, item) in placed.iter().enumerate() {
        if let Some(turn_id) = &item.turn_id {
            last.insert(turn_id.as_str(), index);
            if matches!(item.content, ItemContent::AgentMessage(_)) {
                last_message.insert(turn_id.as_str(), item.id.as_str());
            }
        }
    }
    let default = detail == TranscriptDetail::Default;
    let folded = |item: &Item| {
        default
            && turn_of(item).is_some()
            && folds_into_work(
                item,
                item.turn_id
                    .as_deref()
                    .and_then(|t| last_message.get(t).copied()),
            )
    };
    let mut work: HashMap<&str, Vec<Item>> = HashMap::new();
    for item in &placed {
        if folded(item)
            && let Some(turn_id) = &item.turn_id
        {
            work.entry(turn_id.as_str())
                .or_default()
                .push((*item).clone());
        }
    }
    let mut work_placed = HashSet::new();
    let mut with_work = HashSet::new();
    let mut rows = Vec::new();
    let mut working = None;
    for (index, item) in placed.iter().enumerate() {
        let turn = turn_of(item);
        let user = matches!(item.content, ItemContent::UserMessage(_));
        let mut place_work = |rows: &mut Vec<RowContent>| {
            if let Some(turn) = turn
                && default
                && work_placed.insert(turn.id.clone())
            {
                let items = work.remove(turn.id.as_str()).unwrap_or_default();
                if !items.is_empty() || turn.status == TurnStatus::Running {
                    with_work.insert(turn.id.clone());
                    rows.push(RowContent::Work {
                        turn: Box::new(turn.clone()),
                        items,
                        dim: turn.reverted,
                    });
                }
            }
        };
        if !user {
            place_work(&mut rows);
        }
        if !folded(item) {
            rows.push(RowContent::Item {
                item: Box::new((*item).clone()),
                dim: turn.is_some_and(|t| t.reverted),
                revertable: turn.is_some_and(|t| t.checkpoint_id.is_some()),
            });
        }
        if let Some(turn) = turn
            && last.get(turn.id.as_str()) == Some(&index)
        {
            place_work(&mut rows);
            if is_turn_ended(turn.status) {
                rows.push(RowContent::Footer {
                    turn: Box::new(turn.clone()),
                    work_row: with_work.contains(&turn.id),
                });
            } else if turn.status == TurnStatus::Running && !default {
                working = Some(turn.id.clone());
            }
        }
    }
    if let Some(turn_id) = working {
        rows.push(RowContent::Working { turn_id });
    }
    if let Some(WorkspaceBanner::Progress { title, setup }) =
        state.workspace.as_ref().and_then(|workspace| {
            workspace_banners(workspace)
                .into_iter()
                .find(|banner| matches!(banner, WorkspaceBanner::Progress { .. }))
        })
    {
        rows.push(RowContent::Startup { title, setup });
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
        "dotfiles.apply" => "Applying shell files",
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

/// The workspace banners (04, Empty, loading and error states), as the web `workspaceBanners`.
#[derive(Clone, Debug, PartialEq)]
pub enum WorkspaceBanner {
    /// `creating`, `starting`, `setting_up`: only the current status.
    Progress {
        title: String,
        setup: bool,
    },
    Error {
        code: String,
        message: String,
        detail: Option<String>,
    },
    SetupFailed,
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
            title: w
                .op
                .as_ref()
                .filter(|op| !op.step.is_empty())
                .map(|op| step_label(&op.step))
                .unwrap_or_else(|| title.into()),
            setup: w.state == S::SettingUp,
        });
    }
    if w.setup_status == p::SetupStatus::Failed
        && !matches!(w.state, S::Error | S::Archiving | S::Archived)
    {
        out.push(WorkspaceBanner::SetupFailed);
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
/// The token split shown on hover over the turn footer (04, Transcript).
pub fn turn_usage_detail(turn: &Turn) -> Option<String> {
    turn.usage.as_ref().map(|u| {
        format!(
            "{} in, {} out",
            format_tokens(u.input_tokens),
            format_tokens(u.output_tokens)
        )
    })
}
/// The turn footer (04, Transcript): duration unless the work row shows it, tokens when the agent
/// sent usage, and how it ended when that is not plain success.
pub fn turn_footer(turn: &Turn, work_row: bool) -> String {
    let duration = turn
        .started_at
        .zip(turn.ended_at)
        .filter(|_| !work_row)
        .map(|(start, end)| format_duration((end - start).max(0.)));
    let tokens = turn
        .usage
        .as_ref()
        .map(|u| format!("{} tokens", format_tokens(u.total_tokens)));
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

/// 13, L-ADR-1: the intent card's header.
pub fn intent_status_text(intent: &p::IntentContent) -> &'static str {
    match intent.status {
        p::IntentContentStatus::Awaiting => "Waiting for the agent's intent",
        p::IntentContentStatus::Proposed => "Intent: confirm or correct",
        p::IntentContentStatus::Corrected => "Intent corrected",
        p::IntentContentStatus::Confirmed
            if intent.decided_by == Some(p::IntentContentDecidedBy::Judge) =>
        {
            "Intent confirmed by Tempo (low risk)"
        }
        p::IntentContentStatus::Confirmed => "Intent confirmed",
    }
}

/// 13, L-ADR-1: why the judge sent an intent to the owner.
pub fn intent_reason_text(reasons: &[String]) -> String {
    reasons
        .iter()
        .map(|reason| match reason.as_str() {
            "new_access" => "it needs new access",
            "security_risk" => "it may add a security risk",
            "hard_rollback" => "it is hard to roll back",
            "no_answer" => "the judge did not answer",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub const ADD_TO_CHECKLIST: &str = "Add to checklist";
pub const ON_CHECKLIST: &str = "On checklist";
pub const REOPEN_CHECKLIST_ITEM: &str = "Reopen";
pub const MISSING_CHECKLIST_TEXT: &str = "Open checklist items not resolved:";

/// 13, L-ADR-2: the proof card's header.
pub fn proof_status_text(status: p::ProofContentStatus) -> &'static str {
    match status {
        p::ProofContentStatus::Checking => "Proof: Tempo is running the checks",
        p::ProofContentStatus::Complete => "Proof complete",
        p::ProofContentStatus::Incomplete => "Proof incomplete",
    }
}

pub fn proof_check_text(check: &p::ProofContentChecksItem) -> String {
    match (check.status, check.exit_code) {
        (p::ProofContentChecksItemStatus::Running, _) => format!("{}: running", check.name),
        (p::ProofContentChecksItemStatus::Passed, _) => format!("{}: passed", check.name),
        (_, None) => format!("{}: did not start", check.name),
        (_, Some(code)) => format!("{}: failed (exit {code})", check.name),
    }
}

pub fn proof_screen_label(screen: &p::ProofContentScreensItem) -> String {
    format!("{} · {} · {}", screen.route, screen.viewport, screen.theme)
}

pub fn proof_missing_routes_text(routes: &[String]) -> String {
    format!("No screen for: {}", routes.join(", "))
}

/// A checklist item's text, or its id when the workspace no longer has it.
pub fn checklist_text(checklist: &[p::ChecklistItem], checklist_id: &str) -> String {
    checklist
        .iter()
        .find(|c| c.id == checklist_id)
        .map_or_else(|| checklist_id.to_string(), |c| c.text.clone())
}

pub fn proof_resolved_note(note: &str) -> Option<String> {
    (!note.is_empty()).then(|| format!(" — {note}"))
}

/// Only the proof that resolved an item offers to reopen it.
pub fn can_reopen(checklist: &[p::ChecklistItem], checklist_id: &str, proof_id: &str) -> bool {
    checklist.iter().any(|c| {
        c.id == checklist_id
            && c.status == p::ChecklistItemStatus::Resolved
            && c.resolved_by.as_deref() == Some(proof_id)
    })
}

pub fn on_checklist(checklist: &[p::ChecklistItem], item_id: &str) -> bool {
    checklist
        .iter()
        .any(|c| c.source_item_id.as_deref() == Some(item_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proof_texts_match_the_web_card() {
        assert_eq!(
            proof_status_text(p::ProofContentStatus::Checking),
            "Proof: Tempo is running the checks"
        );
        assert_eq!(
            proof_status_text(p::ProofContentStatus::Complete),
            "Proof complete"
        );
        assert_eq!(
            proof_status_text(p::ProofContentStatus::Incomplete),
            "Proof incomplete"
        );
        let check = |status: &str, exit: serde_json::Value| -> p::ProofContentChecksItem {
            serde_json::from_value(serde_json::json!({
                "name": "lint", "runId": null, "status": status, "exitCode": exit
            }))
            .unwrap()
        };
        assert_eq!(
            proof_check_text(&check("running", serde_json::Value::Null)),
            "lint: running"
        );
        assert_eq!(proof_check_text(&check("passed", 0.into())), "lint: passed");
        assert_eq!(
            proof_check_text(&check("failed", serde_json::Value::Null)),
            "lint: did not start"
        );
        assert_eq!(
            proof_check_text(&check("failed", 2.into())),
            "lint: failed (exit 2)"
        );
        let screen: p::ProofContentScreensItem = serde_json::from_value(serde_json::json!({
            "route": "/todos", "viewport": "phone", "theme": "dark",
            "artifactId": "a1", "version": 1, "recordingArtifactId": null
        }))
        .unwrap();
        assert_eq!(proof_screen_label(&screen), "/todos · phone · dark");
        assert_eq!(
            proof_missing_routes_text(&["/".into(), "/settings".into()]),
            "No screen for: /, /settings"
        );
        assert_eq!(proof_resolved_note(""), None);
        assert_eq!(
            proof_resolved_note("Fixed spacing").as_deref(),
            Some(" — Fixed spacing")
        );
    }
    #[test]
    fn checklist_state_decides_reopen_and_add() {
        let checklist: Vec<p::ChecklistItem> = serde_json::from_value(serde_json::json!([
            {"id": "c1", "text": "Bigger buttons", "status": "resolved", "sourceItemId": "m1",
             "resolvedBy": "proof-1", "createdAt": 1},
            {"id": "c2", "text": "Dark mode contrast", "status": "open", "sourceItemId": null,
             "resolvedBy": null, "createdAt": 2}
        ]))
        .unwrap();
        assert_eq!(checklist_text(&checklist, "c1"), "Bigger buttons");
        assert_eq!(checklist_text(&checklist, "gone"), "gone");
        assert!(can_reopen(&checklist, "c1", "proof-1"));
        assert!(!can_reopen(&checklist, "c1", "proof-2"));
        assert!(!can_reopen(&checklist, "c2", "proof-1"));
        assert!(on_checklist(&checklist, "m1"));
        assert!(!on_checklist(&checklist, "m2"));
    }
    #[test]
    fn intent_texts_match_the_web_card() {
        let mut intent: p::IntentContent = serde_json::from_value(serde_json::json!({
            "intentId": "i1", "status": "awaiting", "goal": "g", "approach": "a",
            "notDoing": "n", "decidedBy": null, "reasons": [], "enforced": true
        }))
        .unwrap();
        assert_eq!(
            intent_status_text(&intent),
            "Waiting for the agent's intent"
        );
        intent.status = p::IntentContentStatus::Proposed;
        assert_eq!(intent_status_text(&intent), "Intent: confirm or correct");
        intent.status = p::IntentContentStatus::Corrected;
        assert_eq!(intent_status_text(&intent), "Intent corrected");
        intent.status = p::IntentContentStatus::Confirmed;
        intent.decided_by = Some(p::IntentContentDecidedBy::Owner);
        assert_eq!(intent_status_text(&intent), "Intent confirmed");
        intent.decided_by = Some(p::IntentContentDecidedBy::Judge);
        assert_eq!(
            intent_status_text(&intent),
            "Intent confirmed by Tempo (low risk)"
        );
        assert_eq!(
            intent_reason_text(&["new_access".into(), "hard_rollback".into(), "custom".into()]),
            "it needs new access, it is hard to roll back, custom"
        );
    }
    #[test]
    fn new_chat_only_offers_agents_with_a_confirmed_login() {
        let mut credentials: CredentialStatus = serde_json::from_value(serde_json::json!({
            "claude": {"set": false, "updatedAt": null},
            "codex": {"set": false, "updatedAt": null, "lastRefresh": null},
            "openrouter": {"set": false, "updatedAt": null},
            "anthropic": {"set": false, "updatedAt": null},
            "openai": {"set": false, "updatedAt": null}
        }))
        .unwrap();
        assert!(new_chat_agents(None).is_empty());
        assert!(new_chat_agents(Some(&credentials)).is_empty());
        credentials.claude.set = true;
        assert_eq!(new_chat_agents(Some(&credentials)), vec![AgentId::Claude]);
        credentials.claude.set = false;
        credentials.anthropic.set = true;
        credentials.openai.set = true;
        credentials.openrouter.set = true;
        assert_eq!(new_chat_agents(Some(&credentials)), AGENTS.to_vec());
    }
    #[test]
    fn new_chat_disables_opencode_and_pi_without_a_model() {
        let mut credentials: CredentialStatus = serde_json::from_value(serde_json::json!({
            "claude": {"set": true, "updatedAt": 1},
            "codex": {"set": true, "updatedAt": 1, "lastRefresh": 1},
            "openrouter": {"set": true, "updatedAt": 1},
            "anthropic": {"set": false, "updatedAt": null},
            "openai": {"set": false, "updatedAt": null}
        }))
        .unwrap();
        let mut settings: p::Settings = serde_json::from_str(
            include_str!("../../../../packages/protocol/fixtures/types/Settings.jsonl")
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        settings.agent.models.pi = "openrouter/pi".into();
        let hints = |c: Option<&CredentialStatus>, s: Option<&p::Settings>| {
            AGENTS.map(|a| new_chat_hint(a, c, s))
        };
        assert_eq!(
            hints(Some(&credentials), Some(&settings)),
            [None, None, Some("Set a model in Settings → Project"), None]
        );
        assert_eq!(hints(Some(&credentials), None), [None, None, None, None]);
        credentials.openrouter.set = false;
        assert_eq!(
            hints(Some(&credentials), Some(&settings)),
            [
                None,
                None,
                Some("Add login in Settings"),
                Some("Add login in Settings")
            ]
        );
        assert_eq!(hints(None, Some(&settings)), [Some("Loading logins…"); 4]);
    }
    #[test]
    fn turn_footer_matches_the_web_copy() {
        let mut turn = state().turns.into_values().next().unwrap();
        turn.status = TurnStatus::Completed;
        turn.stop_reason = Some("end_turn".into());
        turn.started_at = Some(1_000.);
        turn.ended_at = Some(13_000.);
        turn.usage = None;
        assert_eq!(turn_footer(&turn, false), "12 s");
        turn.usage = Some(tempo_protocol::TurnUsage {
            total_tokens: 15_300.,
            input_tokens: 12_000.,
            output_tokens: 3_300.,
            thought_tokens: None,
            cached_read_tokens: None,
            cached_write_tokens: None,
        });
        assert_eq!(turn_footer(&turn, false), "12 s · 15k tokens");
        assert_eq!(
            turn_usage_detail(&turn).as_deref(),
            Some("12k in, 3.3k out")
        );
        turn.status = TurnStatus::Cancelled;
        turn.usage = None;
        assert_eq!(turn_footer(&turn, false), "12 s · Stopped");
        assert_eq!(turn_footer(&turn, true), "Stopped");
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
        let WorkspaceBanner::Progress { title, setup } = &workspace_banners(&w)[0] else {
            panic!("progress");
        };
        assert_eq!((title.as_str(), *setup), ("Cloning repo", false));
        w.op = None;
        assert!(matches!(
            &workspace_banners(&w)[..],
            [WorkspaceBanner::Progress { title, setup: false }]
                if title == "Starting the workspace"
        ));
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
        assert_eq!(banners, [WorkspaceBanner::SetupFailed]);
        assert_eq!(banner_codes(&banners), ["SETUP_FAILED"]);
        w.state = p::WorkspaceState::SettingUp;
        w.setup_status = p::SetupStatus::Running;
        assert!(matches!(
            &workspace_banners(&w)[..],
            [WorkspaceBanner::Progress {
                title,
                setup: true,
                ..
            }] if title == "Running setup"
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
            let rows = transcript_rows(&state, &session.id, TranscriptDetail::Detailed);
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
    fn tool(kind: &str, title: &str, input: serde_json::Value) -> ToolCallItemContent {
        serde_json::from_value(serde_json::json!({
            "toolCallId": "t", "title": title, "toolKind": kind,
            "locations": [], "content": [], "rawInput": input,
        }))
        .unwrap()
    }
    fn item(id: &str, turn: &str, at: f64, status: &str, content: serde_json::Value) -> Item {
        let mut value = serde_json::json!({
            "id": id, "sessionId": "s", "turnId": turn, "status": status,
            "rev": at, "createdAt": at, "updatedAt": at,
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(content.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }
    fn call(id: &str, at: f64, status: &str, kind: &str, input: serde_json::Value) -> Item {
        item(
            id,
            "t1",
            at,
            status,
            serde_json::json!({"kind": "tool_call", "content": {
                "toolCallId": id, "title": format!("title {id}"), "toolKind": kind,
                "locations": [], "content": [], "rawInput": input,
            }}),
        )
    }
    fn text(id: &str, at: f64, kind: &str) -> Item {
        item(
            id,
            "t1",
            at,
            "completed",
            serde_json::json!({"kind": kind, "content": {"text": id}}),
        )
    }
    fn turn_state(status: &str, items: Vec<Item>) -> WorkspaceState {
        let mut state = WorkspaceState::new();
        let turn: Turn = serde_json::from_value(serde_json::json!({
            "id": "t1", "sessionId": "s", "seq": 1, "status": status, "queuePos": null,
            "queuedAt": 0, "startedAt": 0, "endedAt": if status == "running" { None } else { Some(48_000) },
            "prompt": {"text": "go", "mentions": [], "attachmentIds": [], "reviewCommentIds": []},
            "checkpointId": null, "errorCode": null, "stopReason": null, "reverted": false,
        }))
        .unwrap();
        state.turns.insert("t1".into(), turn);
        let mut items = items;
        items.insert(0, item("u", "t1", 0., "completed", serde_json::json!({
            "kind": "user_message", "content": {"text": "go", "mentions": [], "attachments": [], "reviewCommentIds": []},
        })));
        state
            .order
            .insert("s".into(), items.iter().map(|i| i.id.clone()).collect());
        for i in items {
            state.items.insert(i.id.clone(), i);
        }
        state
    }
    fn ids(rows: &[RowContent]) -> Vec<String> {
        rows.iter().map(RowContent::id).collect()
    }
    #[test]
    fn initial_prompt_stays_in_the_transcript_through_startup_and_deletion() {
        let mut state = turn_state("queued", vec![]);
        let first = state.turns.get_mut("t1").unwrap();
        first.started_at = None;
        first.ended_at = None;
        first.queue_pos = Some(0.);
        let mut follow_up = first.clone();
        follow_up.id = "t2".into();
        follow_up.seq = 2.;
        follow_up.queue_pos = Some(1.);
        state.turns.insert("t2".into(), follow_up);
        let mut message = state.items["u"].clone();
        message.id = "u2".into();
        message.turn_id = Some("t2".into());
        state.order.get_mut("s").unwrap().push("u2".into());
        state.items.insert("u2".into(), message);

        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Default)),
            ["u"]
        );
        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Detailed)),
            ["u"]
        );
        let first = state.turns.get_mut("t1").unwrap();
        first.status = TurnStatus::Running;
        first.started_at = Some(100.);
        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Default)),
            ["u", "work:t1"]
        );
        state.turns.remove("t1");
        assert!(transcript_rows(&state, "s", TranscriptDetail::Default).is_empty());
    }
    #[test]
    fn queue_reordering_keeps_the_initial_prompt_fixed() {
        let mut state = turn_state("queued", vec![]);
        state.turns.get_mut("t1").unwrap().queue_pos = Some(0.);
        for (id, seq, position) in [("t2", 2., 1.), ("t3", 3., 2.), ("t4", 4., 3.)] {
            let mut turn = state.turns["t1"].clone();
            turn.id = id.into();
            turn.seq = seq;
            turn.queue_pos = Some(position);
            state.turns.insert(id.into(), turn);
        }
        assert_eq!(
            reordered_queue(&state, "t4", "t2").unwrap(),
            ["t1", "t4", "t2", "t3"]
        );
        assert_eq!(
            reordered_queue(&state, "t2", "t4").unwrap(),
            ["t1", "t3", "t2", "t4"]
        );
        assert!(reordered_queue(&state, "t1", "t2").is_none());
        assert!(reordered_queue(&state, "t2", "t1").is_none());
    }
    #[test]
    fn startup_progress_follows_the_prompt_and_disappears_when_ready() {
        let mut state = turn_state("queued", vec![]);
        let mut workspace = self::state().workspace.unwrap();
        workspace.state = p::WorkspaceState::Starting;
        workspace.setup_status = p::SetupStatus::None;
        workspace.op = None;
        state.workspace = Some(workspace);
        let rows = transcript_rows(&state, "s", TranscriptDetail::Default);
        assert_eq!(ids(&rows), ["u", "workspace-startup"]);
        assert!(
            matches!(&rows[1], RowContent::Startup { title, setup: false } if title == "Starting the workspace")
        );
        state.workspace.as_mut().unwrap().state = p::WorkspaceState::SettingUp;
        let rows = transcript_rows(&state, "s", TranscriptDetail::Default);
        assert!(
            matches!(&rows[1], RowContent::Startup { title, setup: true } if title == "Running setup")
        );
        state.workspace.as_mut().unwrap().state = p::WorkspaceState::Ready;
        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Default)),
            ["u"]
        );
    }
    #[test]
    fn work_types_follow_tool_kind_and_command() {
        let none = serde_json::Value::Null;
        assert_eq!(
            work_type(&tool("read", "a", none.clone())),
            WorkType::Explore
        );
        assert_eq!(
            work_type(&tool("search", "a", none.clone())),
            WorkType::Explore
        );
        for kind in ["edit", "delete", "move"] {
            assert_eq!(work_type(&tool(kind, "a", none.clone())), WorkType::Edit);
        }
        let exec = |c: &str| tool("execute", "x", serde_json::json!({ "command": c }));
        assert_eq!(work_type(&exec("cat src/a.rs")), WorkType::Explore);
        assert_eq!(work_type(&exec("cd app && rg foo")), WorkType::Explore);
        assert_eq!(work_type(&exec("ls -la | head -5")), WorkType::Explore);
        assert_eq!(work_type(&exec("bun test")), WorkType::Run);
        assert_eq!(work_type(&exec("cat a | grep x")), WorkType::Run);
        assert_eq!(work_type(&exec("ls; rm x")), WorkType::Run);
        assert_eq!(
            work_type(&tool("execute", "ls src", none.clone())),
            WorkType::Explore
        );
        assert_eq!(work_type(&tool("fetch", "a", none.clone())), WorkType::Web);
        assert_eq!(
            work_type(&tool(
                "think",
                "a",
                serde_json::json!({"subagent_type": "x"})
            )),
            WorkType::SubAgent
        );
        assert_eq!(
            work_type(&tool(
                "think",
                "a",
                serde_json::json!({"prompt": "p", "description": "d"})
            )),
            WorkType::SubAgent
        );
        assert_eq!(
            work_type(&tool("think", "a", serde_json::json!({"prompt": "p"}))),
            WorkType::Other
        );
        assert_eq!(
            work_type(&tool("other", "a", none.clone())),
            WorkType::Other
        );
        assert_eq!(work_type(&tool("switch_mode", "a", none)), WorkType::Other);
    }
    #[test]
    fn labels_show_intent() {
        let label = |input| tool_label(&tool("execute", "raw cmd", input));
        assert_eq!(
            label(serde_json::json!({"command": "bun test", "description": "Run the tests"})),
            ("Run the tests".into(), false)
        );
        assert_eq!(
            label(serde_json::json!({"command": "cd /workspace && sed -n 1,40p src/a.rs"})),
            ("Read 1,40p src/a.rs".into(), false)
        );
        assert_eq!(
            label(serde_json::json!({"command": "cd x; grep -rn foo src | head -20"})),
            ("Search -rn foo src".into(), false)
        );
        assert_eq!(
            label(serde_json::json!({"command": "tree"})),
            ("List".into(), false)
        );
        assert_eq!(
            label(serde_json::json!({"command": "bun test", "description": "  "})),
            ("raw cmd".into(), true)
        );
        assert_eq!(
            label(serde_json::json!({"command": "cat a\ncat b"})),
            ("raw cmd".into(), true)
        );
        assert_eq!(
            label(serde_json::json!({"command": "cat a || true"})),
            ("raw cmd".into(), true)
        );
        assert_eq!(
            tool_label(&tool("read", "Read a.rs", serde_json::Value::Null)),
            ("Read a.rs".into(), false)
        );
        assert_eq!(command_intent("sed -i s/a/b/ f"), None);
        assert_eq!(command_intent("cdx && ls"), None);
    }
    #[test]
    fn edit_counts_come_from_diff_content() {
        let mut edit = tool("edit", "Edit", serde_json::Value::Null);
        edit.content = vec![
            serde_json::from_value(serde_json::json!({
                "type": "diff", "path": "/workspace/src/app.rs",
                "oldText": "a\nb\nc\n", "newText": "a\nB\nc\nd\n",
            }))
            .unwrap(),
        ];
        let counts = edit_counts(&edit);
        assert_eq!((counts.added, counts.removed), (2, 1));
        assert_eq!(counts.file_name(), "app.rs");
        assert_eq!(line_counts("", "x\ny"), (2, 0));
        assert_eq!(line_counts("x\ny\n", ""), (0, 2));
        assert_eq!(line_counts("same", "same"), (0, 0));
    }
    #[test]
    fn summary_counts_parts_in_order() {
        let read = |id, paths: &[&str]| {
            let mut i = call(id, 1., "completed", "read", serde_json::Value::Null);
            if let ItemContent::ToolCall(t) = &mut i.content {
                t.locations = paths
                    .iter()
                    .map(|p| serde_json::from_value(serde_json::json!({"path": p})).unwrap())
                    .collect();
            }
            i
        };
        let items = vec![
            read("r1", &["a", "b", "a"]),
            read("r2", &[]),
            call("s1", 1., "completed", "search", serde_json::Value::Null),
            call(
                "x1",
                1.,
                "completed",
                "execute",
                serde_json::json!({"command": "bun test"}),
            ),
            call(
                "x2",
                1.,
                "completed",
                "execute",
                serde_json::json!({"command": "make"}),
            ),
            call("w1", 1., "completed", "fetch", serde_json::Value::Null),
            call("o1", 1., "completed", "other", serde_json::Value::Null),
            text("th", 1., "agent_thought"),
        ];
        assert_eq!(
            work_summary(&items, Some(48_000.)),
            "Explored 3 files · 1 search · ran 2 commands · fetched 1 page · used 1 tool · 48 s"
        );
        assert_eq!(
            work_summary(
                &[
                    text("a", 1., "agent_thought"),
                    text("b", 1., "agent_thought")
                ],
                None
            ),
            "Thought 2 times"
        );
        assert_eq!(
            work_summary(
                &[call(
                    "g",
                    1.,
                    "completed",
                    "think",
                    serde_json::json!({"subagent_type": "x"})
                )],
                Some(1500.)
            ),
            "Ran 1 agent · 2 s"
        );
        assert_eq!(format_duration(450.), "450 ms");
        assert_eq!(format_duration(192_000.), "3 min 12 s");
        assert_eq!(format_duration(120_000.), "2 min");
        assert_eq!(format_duration(3_900_000.), "1 h 5 min");
    }
    #[test]
    fn default_detail_folds_work_and_keeps_edits_failures_and_the_answer() {
        let items = vec![
            text("th", 1., "agent_thought"),
            text("m1", 2., "agent_message"),
            call("c1", 3., "completed", "read", serde_json::Value::Null),
            call("e1", 4., "completed", "edit", serde_json::Value::Null),
            call(
                "f1",
                5.,
                "failed",
                "execute",
                serde_json::json!({"command": "bun test"}),
            ),
            call(
                "c2",
                6.,
                "completed",
                "execute",
                serde_json::json!({"command": "bun test"}),
            ),
            text("m2", 7., "agent_message"),
        ];
        let state = turn_state("completed", items.clone());
        let rows = transcript_rows(&state, "s", TranscriptDetail::Default);
        assert_eq!(ids(&rows), ["u", "work:t1", "e1", "f1", "m2", "footer:t1"]);
        let RowContent::Work { items: folded, .. } = &rows[1] else {
            panic!("work row");
        };
        assert_eq!(
            folded.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["th", "m1", "c1", "c2"]
        );
        assert!(matches!(rows[5], RowContent::Footer { work_row: true, .. }));
        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Detailed)),
            ["u", "th", "m1", "c1", "e1", "f1", "c2", "m2", "footer:t1"]
        );
    }
    #[test]
    fn a_plan_proposal_stays_outside_with_its_permission_under_it_and_artifacts_stay_outside() {
        let permission = item(
            "p1",
            "t1",
            5.,
            "pending",
            serde_json::json!({"kind": "permission", "content": {
                "requestId": "r1", "toolCallId": "plan", "title": "Approve?", "options": [],
            }}),
        );
        let artifact = item(
            "a1",
            "t1",
            3.,
            "completed",
            serde_json::json!({"kind": "artifact", "content": {
                "artifactId": "01jart00000000000000000001", "version": 1, "title": "Plan",
                "name": "plan.md", "path": "/workspace/plan.md", "mime": "text/markdown",
                "artifactKind": "markdown", "size": 1,
            }}),
        );
        let items = vec![
            call("c1", 1., "completed", "read", serde_json::Value::Null),
            call(
                "plan",
                2.,
                "pending",
                "other",
                serde_json::json!({"plan": "# Plan"}),
            ),
            artifact,
            text("m1", 4., "agent_message"),
            permission,
        ];
        let state = turn_state("completed", items);
        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Default)),
            ["u", "work:t1", "plan", "p1", "a1", "m1", "footer:t1"]
        );
        assert_eq!(
            plan_proposal_text(&tool("other", "x", serde_json::json!({"plan": " "}))),
            None
        );
    }
    #[test]
    fn a_running_turn_shows_its_work_row_instead_of_working() {
        let state = turn_state("running", vec![]);
        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Default)),
            ["u", "work:t1"]
        );
        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Detailed)),
            ["u", "working:t1"]
        );
        let state = turn_state(
            "running",
            vec![
                text("m1", 1., "agent_message"),
                call("c1", 2., "in_progress", "read", serde_json::Value::Null),
                text("m2", 3., "agent_message"),
            ],
        );
        let rows = transcript_rows(&state, "s", TranscriptDetail::Default);
        assert_eq!(ids(&rows), ["u", "work:t1", "m2"]);
        let RowContent::Work { items, .. } = &rows[1] else {
            panic!("work row");
        };
        assert_eq!(current_step(items).as_deref(), Some("title c1"));
        let thought = text("th", 4., "agent_thought");
        let with_thought = [items.clone(), vec![thought]].concat();
        assert_eq!(current_step(&with_thought).as_deref(), Some("Thinking"));
    }
    #[test]
    fn an_ended_turn_with_nothing_to_fold_has_no_work_row() {
        let state = turn_state("completed", vec![text("m", 1., "agent_message")]);
        assert_eq!(
            ids(&transcript_rows(&state, "s", TranscriptDetail::Default)),
            ["u", "m", "footer:t1"]
        );
        let rows = transcript_rows(&state, "s", TranscriptDetail::Default);
        assert!(matches!(
            rows[2],
            RowContent::Footer {
                work_row: false,
                ..
            }
        ));
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
