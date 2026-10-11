//! Pure state for the hub channel (02, Hub channel), mirroring `apps/tempo/src/ui/stores/hub-state.ts`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tempo_protocol::{
    Attention, HubServerMessage, HubWorkspace, Project, WorkspaceState as Lifecycle,
    WorkspaceSummary,
};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct HubState {
    /// True once the first hello arrived.
    pub ready: bool,
    pub workspaces: HashMap<String, WorkspaceSummary>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyKind {
    Finished,
    NeedsInput,
    Error,
}

/// A notification event (04): a turn ends, a workspace enters `needs_input`, or enters `error`.
#[derive(Clone, Debug, PartialEq)]
pub struct NotifyEvent {
    pub kind: NotifyKind,
    pub workspace: WorkspaceSummary,
}

impl HubState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies one hub message and returns the notification events the web store emits for it
    /// (`notifyEvents(prev, next)`).
    pub fn apply(&mut self, msg: HubServerMessage) -> Vec<NotifyEvent> {
        match msg {
            HubServerMessage::HubHello(hello) => {
                let was_ready = self.ready;
                let mut prev = std::mem::take(&mut self.workspaces);
                let mut first_seen = Vec::new();
                let mut seen = HashSet::new();
                for w in hello.workspaces {
                    if seen.insert(w.id.clone()) {
                        first_seen.push(w.id.clone());
                    }
                    self.workspaces.insert(w.id.clone(), w);
                }
                self.ready = true;
                if !was_ready {
                    return Vec::new();
                }
                first_seen
                    .iter()
                    .filter_map(|id| {
                        let p = prev.remove(id)?;
                        let w = &self.workspaces[id];
                        notify_kind(&p, w).map(|kind| NotifyEvent {
                            kind,
                            workspace: w.clone(),
                        })
                    })
                    .collect()
            }
            HubServerMessage::HubWorkspace(HubWorkspace { summary, .. }) => {
                self.merge_with_event(summary).into_iter().collect()
            }
            HubServerMessage::HubWorkspaceRemoved(m) => {
                self.workspaces.remove(&m.workspace_id);
                Vec::new()
            }
            HubServerMessage::WsPong(_) => Vec::new(),
        }
    }

    /// Merges a summary from elsewhere (a server function result) under the same rev rule
    /// (`mergeSummary`). Returns whether it was applied.
    pub fn merge(&mut self, summary: WorkspaceSummary) -> bool {
        if self
            .workspaces
            .get(&summary.id)
            .is_some_and(|prev| prev.rev >= summary.rev)
        {
            return false;
        }
        self.workspaces.insert(summary.id.clone(), summary);
        true
    }

    fn merge_with_event(&mut self, summary: WorkspaceSummary) -> Option<NotifyEvent> {
        let prev = self.workspaces.get(&summary.id).cloned();
        if !self.merge(summary.clone()) || !self.ready {
            return None;
        }
        let kind = notify_kind(&prev?, &summary)?;
        Some(NotifyEvent {
            kind,
            workspace: summary,
        })
    }

    /// The Dock badge (07): the web tab-title count (`countsForTitle` over listed workspaces).
    pub fn attention_count(&self) -> usize {
        self.workspaces
            .values()
            .filter(|w| is_listed(w) && w.attention != Attention::None)
            .count()
    }
}

fn notify_kind(p: &WorkspaceSummary, w: &WorkspaceSummary) -> Option<NotifyKind> {
    if w.attention == Attention::NeedsInput && p.attention != Attention::NeedsInput {
        Some(NotifyKind::NeedsInput)
    } else if w.attention == Attention::Error && p.attention != Attention::Error {
        Some(NotifyKind::Error)
    } else if (p.state == Lifecycle::Working
        && w.state != Lifecycle::Working
        && w.state != Lifecycle::Error)
        || (w.attention == Attention::Unread && p.attention != Attention::Unread)
    {
        Some(NotifyKind::Finished)
    } else {
        None
    }
}

pub fn is_listed(s: &WorkspaceSummary) -> bool {
    s.archived_at.is_none() && s.state != Lifecycle::Archived
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SortMode {
    #[default]
    Activity,
    Created,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SidebarSection {
    pub key: String,
    pub project_id: Option<String>,
    pub workspaces: Vec<WorkspaceSummary>,
}

/// 04, Sidebar: Pinned (only if any), then one section per project in sort order.
pub fn sidebar_sections(
    workspaces: &HashMap<String, WorkspaceSummary>,
    projects: &[Project],
    sort: SortMode,
) -> Vec<SidebarSection> {
    let listed: Vec<&WorkspaceSummary> = workspaces.values().filter(|w| is_listed(w)).collect();
    let cmp = |a: &WorkspaceSummary, b: &WorkspaceSummary| -> Ordering {
        let by = |x: f64, y: f64| y.partial_cmp(&x).unwrap_or(Ordering::Equal);
        match sort {
            SortMode::Created => by(a.created_at, b.created_at),
            SortMode::Activity => by(a.last_activity_at, b.last_activity_at)
                .then_with(|| by(a.created_at, b.created_at)),
        }
    };
    let pick = |f: &dyn Fn(&WorkspaceSummary) -> bool| -> Vec<WorkspaceSummary> {
        let mut out: Vec<WorkspaceSummary> =
            listed.iter().filter(|w| f(w)).map(|w| (*w).clone()).collect();
        out.sort_by(cmp);
        out
    };
    let mut sections = Vec::new();
    let pinned = pick(&|w| w.pinned);
    if !pinned.is_empty() {
        sections.push(SidebarSection {
            key: "pinned".into(),
            project_id: None,
            workspaces: pinned,
        });
    }
    let mut ordered: Vec<&Project> = projects.iter().collect();
    ordered.sort_by(|a, b| a.sort_order.partial_cmp(&b.sort_order).unwrap_or(Ordering::Equal));
    for p in ordered {
        sections.push(SidebarSection {
            key: p.id.clone(),
            project_id: Some(p.id.clone()),
            workspaces: pick(&|w| !w.pinned && w.project_id == p.id),
        });
    }
    sections
}
