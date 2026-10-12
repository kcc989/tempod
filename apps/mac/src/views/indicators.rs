//! 04, Indicators and Container pill, as the web's `lib/indicators.ts`, `sidebar-logic.ts` and
//! `topbar-logic.ts`. Pure, so the sidebar, the palette and their tests share one copy.
use super::tokens::Token;
use tempo_protocol::{self as p, Attention, WorkspaceState as State};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndicatorKind {
    NeedsInput,
    Error,
    Working,
    Unread,
    /// `creating`, `starting`, `setting_up` or `stopping`: a small grey spinner.
    Busy,
    Sleeping,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Indicator {
    pub kind: IndicatorKind,
    pub tooltip: String,
}

impl IndicatorKind {
    pub fn token(self) -> Token {
        match self {
            Self::NeedsInput => Token::Warning,
            Self::Error => Token::Destructive,
            Self::Working | Self::Unread => Token::Primary,
            Self::Busy | Self::Sleeping => Token::MutedForeground,
        }
    }
}

/// First match wins; attention wins over state.
pub fn status_indicator(
    attention: Attention,
    state: State,
    op: Option<&p::OpProgress>,
) -> Option<Indicator> {
    let (kind, tooltip) = match (attention, state) {
        (Attention::NeedsInput, _) => (IndicatorKind::NeedsInput, "Waiting for you".into()),
        (Attention::Error, _) => (IndicatorKind::Error, "Needs attention".into()),
        (_, State::Working) => (IndicatorKind::Working, "Working".into()),
        (Attention::Unread, _) => (IndicatorKind::Unread, "New activity".into()),
        (_, State::Creating | State::Starting | State::SettingUp | State::Stopping) => {
            (IndicatorKind::Busy, pill_text(state, op, None).text)
        }
        (_, State::Sleeping) => (IndicatorKind::Sleeping, "Sleeping".into()),
        _ => return None,
    };
    Some(Indicator { kind, tooltip })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PillTone {
    Default,
    Muted,
    Error,
    Busy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pill {
    pub text: String,
    pub tone: PillTone,
}

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
    let mut words = String::new();
    let mut prev_lower = false;
    for c in step.chars() {
        if c == '.' || c == '_' {
            words.push(' ');
            prev_lower = false;
        } else {
            if c.is_ascii_uppercase() && prev_lower {
                words.push(' ');
            }
            prev_lower = c.is_ascii_lowercase();
            words.extend(c.to_lowercase());
        }
    }
    let words = words.trim();
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => step.into(),
    }
}

/// `instanceLabel` in packages/protocol.
pub fn instance_label(instance: &p::Instance) -> String {
    match instance {
        p::Instance::InstanceName(name) => name.to_string(),
        p::Instance::CustomInstance(i) => format!(
            "{} vCPU, {} GiB",
            i.vcpu,
            (i.memory_mib as f64 / 1024.).round()
        ),
    }
}

/// 04, Container pill.
pub fn pill_text(state: State, op: Option<&p::OpProgress>, instance: Option<&p::Instance>) -> Pill {
    let (text, tone) = match state {
        State::Starting => (
            match op.filter(|op| !op.step.is_empty()) {
                Some(op) => format!("Starting… {}", step_label(&op.step)),
                None => "Starting…".into(),
            },
            PillTone::Busy,
        ),
        State::SettingUp => ("Running setup".into(), PillTone::Busy),
        State::Ready | State::Working => (
            match instance {
                Some(instance) => format!("Running · {}", instance_label(instance)),
                None => "Running".into(),
            },
            PillTone::Default,
        ),
        State::Stopping => ("Going to sleep".into(), PillTone::Busy),
        State::Sleeping => ("Sleeping".into(), PillTone::Muted),
        State::Error => ("Error".into(), PillTone::Error),
        State::Creating => ("Creating".into(), PillTone::Busy),
        State::Archiving => ("Archiving".into(), PillTone::Busy),
        State::Archived => ("Archived".into(), PillTone::Muted),
    };
    Pill { text, tone }
}

/// PR badge colours: open green, draft grey, merged purple, closed red.
pub fn pr_token(state: Option<p::PrState>) -> Token {
    match state {
        Some(p::PrState::Open) => Token::Success,
        Some(p::PrState::Merged) => Token::Merged,
        Some(p::PrState::Closed) => Token::Destructive,
        _ => Token::MutedForeground,
    }
}

pub fn pr_state_label(state: p::PrState) -> &'static str {
    match state {
        p::PrState::Open => "Open",
        p::PrState::Draft => "Draft",
        p::PrState::Merged => "Merged",
        p::PrState::Closed => "Closed",
    }
}

/// Checks dot: pending amber, success green, failure red.
pub fn checks_token(state: p::ChecksState) -> Token {
    match state {
        p::ChecksState::Pending => Token::Warning,
        p::ChecksState::Success => Token::Success,
        p::ChecksState::Failure => Token::Destructive,
    }
}

pub fn checks_label(state: p::ChecksState) -> &'static str {
    match state {
        p::ChecksState::Pending => "Checks running",
        p::ChecksState::Success => "Checks passed",
        p::ChecksState::Failure => "Checks failed",
    }
}

pub fn is_bold(attention: Attention) -> bool {
    matches!(attention, Attention::Unread | Attention::NeedsInput)
}

/// The server accepts archive only from these states (otherwise `WORKSPACE_BUSY`).
pub fn can_archive(state: State) -> bool {
    matches!(
        state,
        State::Ready | State::Working | State::Sleeping | State::Error
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PowerAction {
    pub wake: bool,
    pub enabled: bool,
}

impl PowerAction {
    pub fn label(self) -> &'static str {
        if self.wake { "Wake" } else { "Sleep" }
    }
}

/// Overflow menu and hover card: Wake or Sleep.
pub fn power_action(state: State) -> PowerAction {
    match state {
        State::Sleeping | State::Error => PowerAction {
            wake: true,
            enabled: true,
        },
        State::Ready => PowerAction {
            wake: false,
            enabled: true,
        },
        State::Working | State::SettingUp | State::Stopping => PowerAction {
            wake: false,
            enabled: false,
        },
        _ => PowerAction {
            wake: true,
            enabled: false,
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Primary {
    CommitPush,
    CreatePr,
    ViewChecks,
    Merge,
    Archive,
}

impl Primary {
    pub fn label(self) -> &'static str {
        match self {
            Self::CommitPush => "Commit and push",
            Self::CreatePr => "Create PR",
            Self::ViewChecks => "View checks",
            Self::Merge => "Merge",
            Self::Archive => "Archive",
        }
    }
}

/// 04, Primary action: the first row that applies, from the workspace detail.
pub fn primary_action(w: &p::WorkspaceDetail) -> Option<Primary> {
    if matches!(w.state, State::Archived | State::Archiving) {
        return None;
    }
    let pr_open =
        w.pr_number.is_some() && matches!(w.pr_state, Some(p::PrState::Open | p::PrState::Draft));
    if w.has_unpushed_commits == Some(true) {
        Some(Primary::CommitPush)
    } else if w.pushed && w.pr_number.is_none() {
        Some(Primary::CreatePr)
    } else if pr_open && w.checks_state == Some(p::ChecksState::Failure) {
        Some(Primary::ViewChecks)
    } else if pr_open {
        Some(Primary::Merge)
    } else if w.pr_number.is_some()
        && matches!(w.pr_state, Some(p::PrState::Merged | p::PrState::Closed))
    {
        Some(Primary::Archive)
    } else {
        None
    }
}

pub fn github_pull_url(owner: &str, name: &str, number: f64) -> String {
    format!("https://github.com/{owner}/{name}/pull/{}", number as u64)
}

#[derive(Debug, PartialEq)]
pub struct PrLink {
    pub label: String,
    pub url: String,
    pub token: Token,
}

/// 04 Top bar, left: `#<number> ↗` after the base branch, coloured by prState, to the PR on GitHub.
pub fn pr_link(
    owner: &str,
    name: &str,
    pr_number: Option<f64>,
    pr_state: Option<p::PrState>,
) -> Option<PrLink> {
    let number = pr_number?;
    Some(PrLink {
        label: format!("#{} ↗", number as u64),
        url: github_pull_url(owner, name, number),
        token: pr_token(pr_state),
    })
}

/// Open on GitHub: the PR, else the branch.
pub fn github_url_for(owner: &str, name: &str, pr_number: Option<f64>, branch: &str) -> String {
    match pr_number {
        Some(number) => github_pull_url(owner, name, number),
        None => format!(
            "https://github.com/{owner}/{name}/tree/{}",
            branch
                .split('/')
                .map(encode_segment)
                .collect::<Vec<_>>()
                .join("/")
        ),
    }
}

fn encode_segment(segment: &str) -> String {
    let mut out = String::new();
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `formatRelative` in the web's `lib/format.ts`. Times are epoch milliseconds.
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
    if d < 30. {
        return if d == 1. {
            "yesterday".into()
        } else {
            format!("{d} days ago")
        };
    }
    let (y, mo, day) = civil_date((at / 86_400_000.).floor() as i64);
    format!("{y}-{mo:02}-{day:02}")
}

/// Epoch milliseconds now.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.
}

/// Days since 1970-01-01 to a (year, month, day) date in UTC.
fn civil_date(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attention_wins_over_state() {
        let kind = |a, s| status_indicator(a, s, None).map(|i| i.kind);
        assert_eq!(
            kind(Attention::NeedsInput, State::Working),
            Some(IndicatorKind::NeedsInput)
        );
        assert_eq!(
            kind(Attention::Error, State::Sleeping),
            Some(IndicatorKind::Error)
        );
        assert_eq!(
            kind(Attention::Unread, State::Working),
            Some(IndicatorKind::Working)
        );
        assert_eq!(
            kind(Attention::Unread, State::Sleeping),
            Some(IndicatorKind::Unread)
        );
        assert_eq!(
            kind(Attention::None, State::Stopping),
            Some(IndicatorKind::Busy)
        );
        assert_eq!(
            kind(Attention::None, State::Sleeping),
            Some(IndicatorKind::Sleeping)
        );
        assert_eq!(kind(Attention::None, State::Ready), None);
        assert_eq!(IndicatorKind::NeedsInput.token(), Token::Warning);
        assert_eq!(IndicatorKind::Busy.token(), Token::MutedForeground);
    }

    #[test]
    fn busy_tooltip_is_the_pill_text() {
        let op: p::OpProgress = serde_json::from_value(serde_json::json!({
            "kind": "wake", "status": "running", "step": "container.snapshot", "steps": []
        }))
        .unwrap();
        let busy = status_indicator(Attention::None, State::Starting, Some(&op)).unwrap();
        assert_eq!(busy.tooltip, "Starting… Saving snapshot");
        assert_eq!(
            status_indicator(Attention::None, State::Stopping, None)
                .unwrap()
                .tooltip,
            "Going to sleep"
        );
    }

    #[test]
    fn step_labels_fall_back_to_words() {
        assert_eq!(step_label("repo.clone"), "Cloning repo");
        assert_eq!(step_label("foo.barBaz"), "Foo bar baz");
        assert_eq!(step_label("snake_case.step"), "Snake case step");
    }

    #[test]
    fn pill_names_the_instance() {
        let name: p::Instance = serde_json::from_value(serde_json::json!("standard-3")).unwrap();
        let custom: p::Instance =
            serde_json::from_value(serde_json::json!({"vcpu":2,"memoryMib":8192,"diskMb":100}))
                .unwrap();
        assert_eq!(
            pill_text(State::Ready, None, Some(&name)).text,
            "Running · standard-3"
        );
        assert_eq!(
            pill_text(State::Working, None, Some(&custom)).text,
            "Running · 2 vCPU, 8 GiB"
        );
        assert_eq!(pill_text(State::Ready, None, None).text, "Running");
        assert_eq!(pill_text(State::Error, None, None).tone, PillTone::Error);
    }

    #[test]
    fn badge_and_dot_colours() {
        assert_eq!(pr_token(Some(p::PrState::Open)), Token::Success);
        assert_eq!(pr_token(Some(p::PrState::Draft)), Token::MutedForeground);
        assert_eq!(pr_token(Some(p::PrState::Merged)), Token::Merged);
        assert_eq!(pr_token(Some(p::PrState::Closed)), Token::Destructive);
        assert_eq!(checks_token(p::ChecksState::Pending), Token::Warning);
        assert_eq!(checks_token(p::ChecksState::Success), Token::Success);
        assert_eq!(checks_token(p::ChecksState::Failure), Token::Destructive);
    }

    #[test]
    fn power_and_archive_follow_the_state() {
        assert_eq!(power_action(State::Sleeping).label(), "Wake");
        assert!(power_action(State::Ready).enabled);
        assert_eq!(power_action(State::Working).label(), "Sleep");
        assert!(!power_action(State::Working).enabled);
        assert!(!power_action(State::Creating).enabled);
        assert!(can_archive(State::Error));
        assert!(!can_archive(State::Starting));
    }

    #[test]
    fn github_links() {
        assert_eq!(
            github_url_for("acme", "api", Some(12.), "tempo/x"),
            "https://github.com/acme/api/pull/12"
        );
        assert_eq!(
            github_url_for("acme", "api", None, "tempo/fix #1"),
            "https://github.com/acme/api/tree/tempo/fix%20%231"
        );
    }

    #[test]
    fn pr_link_follows_the_pr_number_and_state() {
        assert_eq!(
            pr_link("acme", "api", Some(12.), Some(p::PrState::Merged)),
            Some(PrLink {
                label: "#12 ↗".into(),
                url: "https://github.com/acme/api/pull/12".into(),
                token: Token::Merged,
            })
        );
        assert_eq!(
            pr_link("acme", "api", Some(3.), Some(p::PrState::Draft)).map(|l| l.token),
            Some(Token::MutedForeground)
        );
        assert_eq!(
            pr_link("acme", "api", Some(3.), Some(p::PrState::Closed)).map(|l| l.token),
            Some(Token::Destructive)
        );
        assert_eq!(pr_link("acme", "api", None, None), None);
    }

    #[test]
    fn relative_time_matches_the_web() {
        let now = 1_760_000_000_000.;
        assert_eq!(format_relative(now - 10_000., now), "just now");
        assert_eq!(format_relative(now + 5_000., now), "just now");
        assert_eq!(format_relative(now - 50_000., now), "1 min ago");
        assert_eq!(format_relative(now - 25. * 60_000., now), "25 min ago");
        assert_eq!(format_relative(now - 3. * 3_600_000., now), "3 h ago");
        assert_eq!(format_relative(now - 30. * 3_600_000., now), "yesterday");
        assert_eq!(format_relative(now - 5. * 86_400_000., now), "5 days ago");
        assert_eq!(format_relative(0., now), "1970-01-01");
        assert_eq!(format_relative(1_700_000_000_000., now), "2023-11-14");
    }
}
