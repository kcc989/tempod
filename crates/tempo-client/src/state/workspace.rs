//! Pure state for one workspace channel (02, Workspace channel), mirroring
//! `apps/tempo/src/ui/stores/workspace-state.ts`. `apply` is the only writer.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::Serialize;
use tempo_protocol::{
    ChangesSummary, CredentialProvider, Item, ItemContent, ItemStatus, PermissionRequest,
    ScriptRun, Session, Turn, TurnStatus, WorkspaceDetail, WorkspaceServerMessage,
};

/// Script output kept per run, in UTF-16 code units (the web store's string length).
pub const MAX_SCRIPT_OUTPUT: usize = 512 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    /// True once hello arrived.
    pub ready: bool,
    /// True once the backlog of the current connection ended (an `items` with done: true).
    pub backlog_done: bool,
    pub workspace: Option<WorkspaceDetail>,
    pub sessions: HashMap<String, Session>,
    pub turns: HashMap<String, Turn>,
    pub items: HashMap<String, Item>,
    /// Item ids per session, oldest first.
    pub order: HashMap<String, Vec<String>>,
    /// Highest itemsRev seen; sent as sinceRev on reconnect.
    pub items_rev: f64,
    /// Pending permission requests by requestId.
    pub permissions: HashMap<String, PermissionRequest>,
    pub script_runs: HashMap<String, ScriptRun>,
    pub script_output: HashMap<String, String>,
    /// Last `changes` message (branch scope).
    pub changes: Option<ChangesSummary>,
    /// Increments on every `changes` message so views refetch.
    pub changes_seq: u64,
    pub credential_invalid: Vec<CredentialProvider>,
    #[serde(skip)]
    script_output_units: HashMap<String, usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceEvent {
    TurnEnded { turn: Box<Turn> },
    Error { code: String, message: String },
    CredentialInvalid { provider: CredentialProvider },
}

pub fn is_turn_ended(status: TurnStatus) -> bool {
    matches!(
        status,
        TurnStatus::Completed
            | TurnStatus::Cancelled
            | TurnStatus::Failed
            | TurnStatus::Interrupted
    )
}

fn compare_items(a: &Item, b: &Item) -> Ordering {
    match a.created_at.partial_cmp(&b.created_at) {
        Some(Ordering::Equal) | None => a.id.cmp(&b.id),
        Some(o) => o,
    }
}

/// Inserts an id into an ordered list (binary search on createdAt, then id).
fn insert_ordered(ids: &mut Vec<String>, item: &Item, items: &HashMap<String, Item>) {
    let last = ids.last().and_then(|id| items.get(id));
    if last.is_none_or(|l| compare_items(l, item) == Ordering::Less) {
        ids.push(item.id.clone());
        return;
    }
    let (mut lo, mut hi) = (0, ids.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if items
            .get(&ids[mid])
            .is_some_and(|o| compare_items(o, item) == Ordering::Less)
        {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    ids.insert(lo, item.id.clone());
}

/// The requestId of a permission item that is answered or over.
fn done_permission(item: &Item) -> Option<&str> {
    let ItemContent::Permission(c) = &item.content else {
        return None;
    };
    let done = c.chosen_option_id.is_some()
        || matches!(
            item.status,
            ItemStatus::Completed | ItemStatus::Cancelled | ItemStatus::Failed
        );
    done.then_some(c.request_id.as_str())
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

impl WorkspaceState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The `sinceRev` for the next connection.
    pub fn since_rev(&self) -> u64 {
        if self.items_rev.is_finite() && self.items_rev > 0.0 {
            self.items_rev as u64
        } else {
            0
        }
    }

    /// Applies one message; returns the events the web store emits for it.
    pub fn apply(&mut self, msg: WorkspaceServerMessage) -> Vec<WorkspaceEvent> {
        use WorkspaceServerMessage as M;
        // After the backlog, any message whose itemsRev is lower than ours is stale (02, Rules).
        let msg_rev = match &msg {
            M::Items(m) => Some(m.items_rev),
            M::ItemUpsert(m) => Some(m.items_rev),
            M::ItemDelta(m) => Some(m.items_rev),
            _ => None,
        };
        if self.backlog_done && msg_rev.is_some_and(|r| r < self.items_rev) {
            return Vec::new();
        }
        match msg {
            M::Hello(h) => {
                self.ready = true;
                self.backlog_done = false;
                self.workspace = Some(h.workspace);
                self.sessions = h.sessions.into_iter().map(|s| (s.id.clone(), s)).collect();
                self.turns = h.turns.into_iter().map(|t| (t.id.clone(), t)).collect();
            }
            M::Items(m) => {
                let rev = self.upsert_items(m.items);
                self.items_rev = rev.max(m.items_rev);
                self.backlog_done = self.backlog_done || m.done;
            }
            M::ItemUpsert(m) => {
                let rev = self.upsert_items(vec![m.item]);
                self.items_rev = rev.max(m.items_rev);
            }
            M::ItemDelta(m) => {
                self.items_rev = self.items_rev.max(m.items_rev);
                if let Some(text) = self
                    .items
                    .get_mut(&m.item_id)
                    .and_then(|item| item.content.text_mut())
                {
                    text.push_str(&m.append.text);
                }
            }
            M::Workspace(m) => self.workspace = Some(m.workspace),
            M::Session(m) => {
                self.sessions.insert(m.session.id.clone(), m.session);
            }
            M::Turn(m) => {
                let ended_now = is_turn_ended(m.turn.status)
                    && self
                        .turns
                        .get(&m.turn.id)
                        .is_none_or(|prev| !is_turn_ended(prev.status));
                self.turns.insert(m.turn.id.clone(), m.turn.clone());
                if ended_now {
                    return vec![WorkspaceEvent::TurnEnded {
                        turn: Box::new(m.turn),
                    }];
                }
            }
            M::TurnDeleted(m) => {
                self.turns.remove(&m.turn_id);
            }
            M::Permission(m) => {
                let answered = self
                    .items
                    .get(&m.request.item_id)
                    .and_then(done_permission)
                    .is_some();
                if !answered {
                    self.permissions
                        .insert(m.request.request_id.clone(), m.request);
                }
            }
            M::ScriptOutput(m) => self.append_script_output(m.run_id, &m.data),
            M::ScriptRun(m) => {
                self.script_runs.insert(m.run.id.clone(), m.run);
            }
            M::Changes(m) => {
                self.changes = Some(ChangesSummary {
                    files: m.files,
                    additions: m.additions,
                    deletions: m.deletions,
                });
                self.changes_seq += 1;
            }
            M::CredentialInvalid(m) => {
                if !self.credential_invalid.contains(&m.provider) {
                    self.credential_invalid.push(m.provider);
                }
                return vec![WorkspaceEvent::CredentialInvalid {
                    provider: m.provider,
                }];
            }
            M::Error(m) => {
                return vec![WorkspaceEvent::Error {
                    code: m.code,
                    message: m.message,
                }];
            }
            M::Pong(_) => {}
        }
        Vec::new()
    }

    /// Applies a batch of items under the per-item rev rule; returns the new highest rev.
    fn upsert_items(&mut self, incoming: Vec<Item>) -> f64 {
        let mut items_rev = self.items_rev;
        for item in incoming {
            items_rev = items_rev.max(item.rev);
            let prev_session = match self.items.get(&item.id) {
                Some(prev) if prev.rev > item.rev => continue,
                Some(prev) => Some(prev.session_id.clone()),
                None => None,
            };
            let done_request = done_permission(&item).map(str::to_owned);
            let id = item.id.clone();
            let session = item.session_id.clone();
            self.items.insert(id.clone(), item);
            if prev_session.as_deref() != Some(session.as_str()) {
                if let Some(old) = prev_session {
                    self.order.entry(old).or_default().retain(|x| *x != id);
                }
                let list = self.order.entry(session).or_default();
                insert_ordered(list, &self.items[&id], &self.items);
            }
            if let Some(request_id) = done_request {
                self.permissions.remove(&request_id);
            }
        }
        items_rev
    }

    fn append_script_output(&mut self, run_id: String, data: &str) {
        let text = self.script_output.entry(run_id.clone()).or_default();
        let units = self
            .script_output_units
            .entry(run_id)
            .or_insert_with(|| utf16_len(text));
        text.push_str(data);
        *units += utf16_len(data);
        if *units <= MAX_SCRIPT_OUTPUT {
            return;
        }
        let excess = *units - MAX_SCRIPT_OUTPUT;
        let mut removed = 0;
        let mut cut = 0;
        for (i, c) in text.char_indices() {
            if removed >= excess {
                cut = i;
                break;
            }
            removed += c.len_utf16();
            cut = i + c.len_utf8();
        }
        text.drain(..cut);
        *units -= removed;
    }

    /// Seeds a run's output with the log tail from listScriptRuns without losing live output.
    pub fn seed_script_output(&mut self, run_id: &str, log_tail: &str) -> bool {
        let live = self.script_output.get(run_id).map(String::as_str);
        let text = match live {
            None | Some("") => log_tail.to_owned(),
            Some(live) if log_tail.ends_with(live) => log_tail.to_owned(),
            Some(live) if live.starts_with(log_tail) => live.to_owned(),
            Some(live) => format!("{log_tail}{live}"),
        };
        if live == Some(text.as_str()) {
            return false;
        }
        self.script_output_units
            .insert(run_id.to_owned(), utf16_len(&text));
        self.script_output.insert(run_id.to_owned(), text);
        true
    }

    pub fn clear_credential_invalid(&mut self, providers: &[CredentialProvider]) -> bool {
        let before = self.credential_invalid.len();
        self.credential_invalid.retain(|p| !providers.contains(p));
        self.credential_invalid.len() != before
    }

    pub fn session_turns(&self, session_id: &str) -> Vec<&Turn> {
        let mut out: Vec<&Turn> = self
            .turns
            .values()
            .filter(|t| t.session_id == session_id)
            .collect();
        out.sort_by(|a, b| a.seq.partial_cmp(&b.seq).unwrap_or(Ordering::Equal));
        out
    }

    pub fn running_turn(&self, session_id: &str) -> Option<&Turn> {
        self.turns
            .values()
            .find(|t| t.session_id == session_id && t.status == TurnStatus::Running)
    }

    /// Queued turns of the whole workspace in queue order (the queue is workspace-wide).
    pub fn queued_turns(&self) -> Vec<&Turn> {
        let mut out: Vec<&Turn> = self
            .turns
            .values()
            .filter(|t| t.status == TurnStatus::Queued)
            .collect();
        out.sort_by(|a, b| {
            let pos = |t: &Turn| t.queue_pos.unwrap_or(f64::INFINITY);
            match pos(a).partial_cmp(&pos(b)) {
                Some(Ordering::Equal) | None => a
                    .queued_at
                    .partial_cmp(&b.queued_at)
                    .unwrap_or(Ordering::Equal),
                Some(o) => o,
            }
        });
        out
    }

    /// The workspace queue with `turn_id` moved to `to_index` among the session's own queued turns.
    pub fn reordered_queue(&self, session_id: &str, turn_id: &str, to_index: usize) -> Vec<String> {
        let queued = self.queued_turns();
        let all: Vec<String> = queued.iter().map(|t| t.id.clone()).collect();
        let mine: Vec<String> = queued
            .iter()
            .filter(|t| t.session_id == session_id)
            .map(|t| t.id.clone())
            .collect();
        let Some(from) = mine.iter().position(|id| id == turn_id) else {
            return all;
        };
        let mut moved = mine.clone();
        moved.remove(from);
        moved.insert(to_index.min(moved.len()), turn_id.to_owned());
        let mut next = moved.into_iter();
        all.into_iter()
            .map(|id| {
                if mine.contains(&id) {
                    next.next().unwrap_or(id)
                } else {
                    id
                }
            })
            .collect()
    }

    /// The newest plan of the session's running turn, for the `Plan 3/4` pill: (done, total).
    pub fn running_plan(&self, session_id: &str) -> Option<(usize, usize)> {
        let turn = self.running_turn(session_id)?;
        let ids = self.order.get(session_id)?;
        for id in ids.iter().rev() {
            let Some(item) = self.items.get(id) else {
                continue;
            };
            if item.turn_id.as_deref() != Some(turn.id.as_str()) {
                continue;
            }
            if let ItemContent::Plan(plan) = &item.content {
                let total = plan.entries.len();
                let done = plan
                    .entries
                    .iter()
                    .filter(|e| e.status == "completed")
                    .count();
                return (total > 0).then_some((done, total));
            }
        }
        None
    }

    /// The first prompt line of each turn, oldest first, for the default PR body (03).
    pub fn prompt_first_lines(&self, max: usize) -> Vec<String> {
        let mut turns: Vec<&Turn> = self
            .turns
            .values()
            .filter(|t| !t.reverted && t.status != TurnStatus::Queued)
            .collect();
        turns.sort_by(|a, b| {
            a.queued_at
                .partial_cmp(&b.queued_at)
                .unwrap_or(Ordering::Equal)
        });
        turns
            .iter()
            .map(|t| {
                t.prompt
                    .text
                    .split('\n')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_owned()
            })
            .filter(|l| !l.is_empty())
            .take(max)
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptRow {
    Item { item_id: String, reverted: bool },
    TurnFooter { turn_id: String },
}

/// The transcript of one session as rows: every item, plus a footer after the last item of each
/// ended turn. Items of reverted turns are flagged for 50% opacity.
pub fn transcript_rows(
    order: &[String],
    items: &HashMap<String, Item>,
    turns: &HashMap<String, Turn>,
) -> Vec<TranscriptRow> {
    let mut last_index_of_turn: HashMap<&str, usize> = HashMap::new();
    for (i, id) in order.iter().enumerate() {
        if let Some(t) = items.get(id).and_then(|it| it.turn_id.as_deref()) {
            last_index_of_turn.insert(t, i);
        }
    }
    let mut rows = Vec::with_capacity(order.len());
    for (i, id) in order.iter().enumerate() {
        let Some(item) = items.get(id) else {
            continue;
        };
        let turn = item.turn_id.as_deref().and_then(|t| turns.get(t));
        rows.push(TranscriptRow::Item {
            item_id: id.clone(),
            reverted: turn.is_some_and(|t| t.reverted),
        });
        if let Some(turn) = turn
            && last_index_of_turn.get(turn.id.as_str()) == Some(&i)
            && is_turn_ended(turn.status)
        {
            rows.push(TranscriptRow::TurnFooter {
                turn_id: turn.id.clone(),
            });
        }
    }
    rows
}
