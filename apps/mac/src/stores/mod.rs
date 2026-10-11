//! Live state (07, Live state and reconnects). The stores apply the same messages with the same
//! rules as the web stores (`apps/tempo/src/ui/stores`); the shared fixtures prove it.
pub mod hub;
pub mod workspace;

use std::time::{Duration, Instant};

/// Receivers from the runtime are bounded at this many decoded messages (07, Data flow).
pub const CHANNEL_CAPACITY: usize = 1024;

/// A socket down for longer than this shows the `Reconnecting…` bar from 04.
pub const RECONNECTING_BAR_AFTER: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connection {
    Closed,
    Open,
    /// Down since this instant; the runtime is reconnecting.
    Down(Instant),
}

impl Connection {
    pub fn shows_reconnecting_bar(self, now: Instant) -> bool {
        matches!(self, Connection::Down(since) if now.duration_since(since) > RECONNECTING_BAR_AFTER)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnecting_bar_waits_two_seconds() {
        let t0 = Instant::now();
        let down = Connection::Down(t0);
        assert!(!down.shows_reconnecting_bar(t0 + Duration::from_millis(1999)));
        assert!(down.shows_reconnecting_bar(t0 + Duration::from_millis(2001)));
        assert!(!Connection::Open.shows_reconnecting_bar(t0 + Duration::from_secs(60)));
    }
}
