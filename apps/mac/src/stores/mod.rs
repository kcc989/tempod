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

/// The main window's bar for the hub socket. The workspace view shows its own bar for its socket,
/// so this one stays hidden while that one shows: one bar at a time.
pub fn shows_hub_bar(hub: Connection, workspace: Option<Connection>, now: Instant) -> bool {
    hub.shows_reconnecting_bar(now) && !workspace.is_some_and(|w| w.shows_reconnecting_bar(now))
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

    #[test]
    fn hub_bar_shows_without_a_workspace_and_never_twice() {
        let t0 = Instant::now();
        let later = t0 + Duration::from_secs(3);
        let down = Connection::Down(t0);
        assert!(shows_hub_bar(down, None, later));
        assert!(shows_hub_bar(down, Some(Connection::Open), later));
        assert!(!shows_hub_bar(down, Some(down), later));
        assert!(!shows_hub_bar(Connection::Open, Some(down), later));
        assert!(!shows_hub_bar(down, None, t0 + Duration::from_secs(1)));
    }
}
