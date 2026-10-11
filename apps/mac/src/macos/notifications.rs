//! macOS notifications (07, Notifications). Stub: M5 uses `UNUserNotificationCenter` through
//! `objc2-user-notifications`, asks for permission only when the owner turns notifications on,
//! sends only while the app is not active, and puts `workspaceId` in `userInfo`. It needs a
//! signed bundle.

pub fn post(workspace_id: &str, title: &str, body: &str) {
    let _ = (workspace_id, title, body);
}
