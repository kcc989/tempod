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
        if block.0.get("type").and_then(|t| t.as_str()) != Some("diff") {
            continue;
        }
        let text = |key| block.0.get(key).and_then(|v| v.as_str()).unwrap_or("");
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

/// True when Default detail folds the item into its turn's work row.
pub fn folds_into_work(item: &Item, last_message: Option<&str>) -> bool {
    match &item.content {
        ItemContent::AgentThought(_) => true,
        ItemContent::AgentMessage(_) => last_message != Some(item.id.as_str()),
        ItemContent::ToolCall(tool) => {
            !matches!(item.status, ItemStatus::Failed | ItemStatus::Cancelled)
                && work_type(tool) != WorkType::Edit
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
}
impl RowContent {
    pub fn id(&self) -> String {
        match self {
            Self::Item { item, .. } => item.id.clone(),
            Self::Work { turn, .. } => format!("work:{}", turn.id),
            Self::Footer { turn, .. } => format!("footer:{}", turn.id),
            Self::Working { turn_id } => format!("working:{turn_id}"),
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
    let placed: Vec<&Item> = placed.into_iter().map(|p| p.0).collect();
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
/// The turn footer (04, Transcript): duration unless the work row shows it, tokens when the agent
/// sent usage, and how it ended when that is not plain success.
pub fn turn_footer(turn: &Turn, work_row: bool) -> String {
    let duration = turn
        .started_at
        .zip(turn.ended_at)
        .filter(|_| !work_row)
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
        assert_eq!(
            turn_footer(&turn, false),
            "12 s · 15k tokens (12k in, 3.3k out)"
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
