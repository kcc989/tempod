//! WorkspaceStore: one per open workspace, fed by `/api/ws/workspace/<id>?sinceRev=<n>`
//! (02, Workspace channel; 07, Live state). Stub: it keeps what the reconnect and eviction rules
//! need. Its items, sessions and turns mirror `applyWorkspaceMessage` in `workspace-state.ts` once
//! crates/tempo-protocol is generated.
use super::Connection;
use std::time::{Duration, Instant};

/// At most this many stores stay in memory; the one shown least recently is evicted (07).
pub const MAX_OPEN: usize = 5;
/// The socket closes this long after the workspace is no longer shown (07).
pub const CLOSE_AFTER_HIDDEN: Duration = Duration::from_secs(60);
/// The backlog arrives in `items` pages of this size until `done: true` (02).
pub const BACKLOG_PAGE: usize = 500;

pub struct WorkspaceStore {
    pub workspace_id: String,
    pub connection: Connection,
    /// Highest `itemsRev` applied; a reopen sends it as `sinceRev`, a new store sends 0.
    pub items_rev: u64,
    /// `None` while shown; otherwise when it stopped being shown.
    pub hidden_since: Option<Instant>,
}

impl WorkspaceStore {
    pub fn new(workspace_id: impl Into<String>) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            connection: Connection::Closed,
            items_rev: 0,
            hidden_since: None,
        }
    }

    pub fn since_rev(&self) -> u64 {
        self.items_rev
    }

    pub fn should_close_socket(&self, now: Instant) -> bool {
        self.hidden_since
            .is_some_and(|since| now.duration_since(since) >= CLOSE_AFTER_HIDDEN)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_store_asks_for_everything() {
        assert_eq!(WorkspaceStore::new("w").since_rev(), 0);
    }

    #[test]
    fn socket_closes_a_minute_after_hiding() {
        let mut store = WorkspaceStore::new("w");
        let t0 = Instant::now();
        assert!(!store.should_close_socket(t0));
        store.hidden_since = Some(t0);
        assert!(!store.should_close_socket(t0 + Duration::from_secs(59)));
        assert!(store.should_close_socket(t0 + Duration::from_secs(60)));
    }
}
