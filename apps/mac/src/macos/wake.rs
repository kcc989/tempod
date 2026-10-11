//! Wake from sleep (07, Reconnect): on `NSWorkspaceDidWakeNotification` every channel reconnects
//! at once. Stub: M5 observes it on `NSWorkspace.sharedWorkspace.notificationCenter`.

pub fn observe(on_wake: impl Fn() + Send + Sync + 'static) {
    drop(on_wake);
}
