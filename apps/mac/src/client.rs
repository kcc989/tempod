//! Stand-in for `tempo_client::Runtime` (07, Data flow). `main` starts it before GPUI and it
//! lives until the app quits. Replace it with the real runtime once crates/tempo-client has one;
//! the GPUI side only ever holds this handle.

use std::time::Instant;

#[derive(Debug)]
pub struct ClientRuntime {
    started_at: Instant,
}

impl ClientRuntime {
    /// The real runtime starts a tokio runtime with 2 worker threads here (07, Threads).
    pub fn start() -> Self {
        Self { started_at: Instant::now() }
    }

    pub fn started_at(&self) -> Instant {
        self.started_at
    }
}
