//! HubStore: the sidebar, fed by `/api/ws/hub` (02, Hub channel; 07, Live state). Stub: it keeps
//! the connection state only. Its summaries are `tempo_protocol::WorkspaceSummary` values once
//! crates/tempo-protocol is generated; it then mirrors `applyHubMessage` in `hub-state.ts`
//! (one summary per id, ignore a summary whose `rev` is not newer).
use super::Connection;

pub struct HubStore {
    pub connection: Connection,
    /// True once the first `hello` arrived.
    pub ready: bool,
}

impl HubStore {
    pub fn new() -> Self {
        Self {
            connection: Connection::Closed,
            ready: false,
        }
    }
}

impl Default for HubStore {
    fn default() -> Self {
        Self::new()
    }
}
