//! Cross-platform face of `src/macos`. On macOS it calls the native module; elsewhere (the Linux
//! build machine) it keeps the token in memory and the rest are no-ops, so the app builds and
//! tests there. The rules (badge count, when to notify, notification copy) are plain Rust here.
use std::collections::HashMap;
use std::sync::Mutex;
use tempo_protocol::{Attention, WorkspaceState, WorkspaceSummary};

/// The session token store (07, Local storage): Keychain service `dev.tempo.mac`,
/// account = the Tempo host.
pub trait TokenStore: Send + Sync {
    fn get(&self, host: &str) -> Option<String>;
    fn set(&self, host: &str, token: &str) -> Result<(), String>;
    fn delete(&self, host: &str);
}

#[derive(Default)]
pub struct MemoryTokenStore {
    tokens: Mutex<HashMap<String, String>>,
}

impl TokenStore for MemoryTokenStore {
    fn get(&self, host: &str) -> Option<String> {
        self.tokens.lock().ok()?.get(host).cloned()
    }

    fn set(&self, host: &str, token: &str) -> Result<(), String> {
        let mut tokens = self
            .tokens
            .lock()
            .map_err(|_| "token store poisoned".to_string())?;
        tokens.insert(host.to_string(), token.to_string());
        Ok(())
    }

    fn delete(&self, host: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(host);
        }
    }
}

#[cfg(target_os = "macos")]
pub struct Keychain;

#[cfg(target_os = "macos")]
impl TokenStore for Keychain {
    fn get(&self, host: &str) -> Option<String> {
        crate::macos::keychain::get(host)
    }

    fn set(&self, host: &str, token: &str) -> Result<(), String> {
        crate::macos::keychain::set(host, token)
    }

    fn delete(&self, host: &str) {
        crate::macos::keychain::delete(host)
    }
}

pub fn token_store() -> Box<dyn TokenStore> {
    #[cfg(target_os = "macos")]
    {
        Box::new(Keychain)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(MemoryTokenStore::default())
    }
}

/// `isListed` in `hub-state.ts`: not archived.
pub fn is_listed(s: &WorkspaceSummary) -> bool {
    s.archived_at.is_none() && s.state != WorkspaceState::Archived
}

/// The Dock badge count (07, Dock badge): listed workspaces whose attention is `needs_input`,
/// `error` or `unread`, the same count as the web tab title (`countsForTitle` over listed
/// summaries in `GlobalChrome.tsx`).
pub fn badge_count<'a>(summaries: impl IntoIterator<Item = &'a WorkspaceSummary>) -> usize {
    summaries
        .into_iter()
        .filter(|s| is_listed(s))
        .filter(|s| {
            matches!(
                s.attention,
                Attention::NeedsInput | Attention::Error | Attention::Unread
            )
        })
        .count()
}

/// What the Dock shows for a count; `None` clears it.
pub fn badge_label(count: usize) -> Option<String> {
    (count > 0).then(|| count.to_string())
}

pub fn set_badge_count(count: usize) {
    #[cfg(target_os = "macos")]
    crate::macos::dock::set_badge_label(badge_label(count).as_deref());
    #[cfg(not(target_os = "macos"))]
    let _ = count;
}

/// The three notification events of 04 (`NotifyKind` in `hub-state.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifyKind {
    /// A turn ends.
    Finished,
    /// A workspace enters `needs_input`.
    NeedsInput,
    /// A workspace enters `error`.
    Error,
}

impl NotifyKind {
    /// The body from 04 (`NOTIFY_BODY` in `notify.ts`).
    pub fn body(self) -> &'static str {
        match self {
            NotifyKind::Finished => "Finished",
            NotifyKind::NeedsInput => "Waiting for you",
            NotifyKind::Error => "Needs attention",
        }
    }
}

/// The event, if any, when a hub summary replaces the previous one for the same workspace: the
/// loop body of `notifyEvents` in `hub-state.ts`. The caller skips it before the first `hello`.
pub fn notify_kind(prev: &WorkspaceSummary, next: &WorkspaceSummary) -> Option<NotifyKind> {
    if prev == next {
        return None;
    }
    if next.attention == Attention::NeedsInput && prev.attention != Attention::NeedsInput {
        Some(NotifyKind::NeedsInput)
    } else if next.attention == Attention::Error && prev.attention != Attention::Error {
        Some(NotifyKind::Error)
    } else if (prev.state == WorkspaceState::Working
        && next.state != WorkspaceState::Working
        && next.state != WorkspaceState::Error)
        || (next.attention == Attention::Unread && prev.attention != Attention::Unread)
    {
        Some(NotifyKind::Finished)
    } else {
        None
    }
}

/// Notification permission, as the web's `PermissionState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Granted,
    Denied,
    /// Not asked yet.
    Default,
    /// No notification center (not macOS, or not run from an app bundle).
    Unsupported,
}

/// `shouldNotify` in `notify.ts`, with "the tab is hidden" read as "the app is not active" (07).
pub fn should_notify(app_active: bool, permission: Permission, notifications_on: bool) -> bool {
    !app_active && permission == Permission::Granted && notifications_on
}

/// A macOS notification for one of the three events in 04. `workspace_id` goes in `userInfo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub workspace_id: String,
    pub title: String,
    pub body: &'static str,
}

/// Title `<workspace title>`, body by event (04).
pub fn notice(kind: NotifyKind, workspace: &WorkspaceSummary) -> Notice {
    Notice {
        workspace_id: workspace.id.clone(),
        title: workspace.title.clone(),
        body: kind.body(),
    }
}

pub fn notify(notice: &Notice, sound: bool) {
    #[cfg(target_os = "macos")]
    crate::macos::notifications::post(&notice.workspace_id, &notice.title, notice.body, sound);
    #[cfg(not(target_os = "macos"))]
    let _ = (notice, sound);
}

/// Asks macOS for permission. Call it only when the owner turns notifications on (07).
pub fn request_notification_permission(on_result: impl Fn(Permission) + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    crate::macos::notifications::request_authorization(on_result);
    #[cfg(not(target_os = "macos"))]
    on_result(Permission::Unsupported);
}

/// Reads the current permission without asking.
pub fn notification_permission(on_result: impl Fn(Permission) + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    crate::macos::notifications::authorization(on_result);
    #[cfg(not(target_os = "macos"))]
    on_result(Permission::Unsupported);
}

/// `on_click` gets the `workspaceId` of a clicked notification, possibly off the main thread.
/// Install it at launch, so a click that launched the app is not lost.
pub fn on_notification_click(on_click: impl Fn(String) + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    crate::macos::notifications::on_click(on_click);
    #[cfg(not(target_os = "macos"))]
    drop(on_click);
}

/// Whether Tempo is the active app. Call it on the main thread. Elsewhere than macOS it is always
/// true, so nothing is sent.
pub fn app_is_active() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::macos::dock::app_is_active()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Calls `on_wake` after the Mac wakes from sleep, so every channel reconnects at once (07).
pub fn observe_wake(on_wake: impl Fn() + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    crate::macos::wake::observe(on_wake);
    #[cfg(not(target_os = "macos"))]
    drop(on_wake);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary(id: &str, attention: &str, state: &str) -> WorkspaceSummary {
        serde_json::from_value(json!({
            "id": id,
            "projectId": "p1",
            "slug": id,
            "title": format!("Title {id}"),
            "branch": "b",
            "baseBranch": "main",
            "state": state,
            "attention": attention,
            "pinned": false,
            "prNumber": null,
            "prState": null,
            "checksState": null,
            "defaultAgent": "claude",
            "lastActivityAt": 1,
            "createdAt": 1,
            "archivedAt": null,
            "rev": 1,
        }))
        .unwrap()
    }

    #[test]
    fn memory_store_round_trips_per_host() {
        let store = MemoryTokenStore::default();
        assert_eq!(store.get("a.test"), None);
        store.set("a.test", "t1").unwrap();
        store.set("b.test", "t2").unwrap();
        assert_eq!(store.get("a.test").as_deref(), Some("t1"));
        store.delete("a.test");
        assert_eq!(store.get("a.test"), None);
        assert_eq!(store.get("b.test").as_deref(), Some("t2"));
    }

    #[test]
    fn badge_is_cleared_at_zero() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(3).as_deref(), Some("3"));
    }

    #[test]
    fn badge_counts_listed_workspaces_that_need_you() {
        let mut archived = summary("e", "unread", "ready");
        archived.archived_at = Some(5.);
        let all = [
            summary("a", "needs_input", "ready"),
            summary("b", "error", "error"),
            summary("c", "unread", "ready"),
            summary("d", "none", "working"),
            archived,
            summary("f", "error", "archived"),
        ];
        assert_eq!(badge_count(&all), 3);
        assert_eq!(badge_count(&all[3..]), 0);
    }

    #[test]
    fn notify_kind_mirrors_notify_events() {
        let k = |p: (&str, &str), n: (&str, &str)| {
            notify_kind(&summary("w", p.0, p.1), &summary("w", n.0, n.1))
        };
        assert_eq!(
            k(("none", "working"), ("needs_input", "working")),
            Some(NotifyKind::NeedsInput)
        );
        assert_eq!(
            k(("needs_input", "working"), ("needs_input", "ready")),
            Some(NotifyKind::Finished)
        );
        assert_eq!(
            k(("needs_input", "ready"), ("needs_input", "sleeping")),
            None
        );
        assert_eq!(
            k(("none", "working"), ("error", "error")),
            Some(NotifyKind::Error)
        );
        assert_eq!(
            k(("none", "working"), ("none", "ready")),
            Some(NotifyKind::Finished)
        );
        assert_eq!(k(("none", "working"), ("none", "error")), None);
        assert_eq!(
            k(("none", "ready"), ("unread", "ready")),
            Some(NotifyKind::Finished)
        );
        assert_eq!(k(("unread", "ready"), ("unread", "sleeping")), None);
        assert_eq!(k(("none", "ready"), ("none", "working")), None);
        assert_eq!(k(("none", "ready"), ("none", "ready")), None);
    }

    #[test]
    fn notifies_only_when_inactive_permitted_and_on() {
        assert!(should_notify(false, Permission::Granted, true));
        assert!(!should_notify(true, Permission::Granted, true));
        assert!(!should_notify(false, Permission::Granted, false));
        for p in [
            Permission::Denied,
            Permission::Default,
            Permission::Unsupported,
        ] {
            assert!(!should_notify(false, p, true));
        }
    }

    #[test]
    fn notice_copy_follows_04() {
        let w = summary("w1", "needs_input", "ready");
        assert_eq!(
            notice(NotifyKind::NeedsInput, &w),
            Notice {
                workspace_id: "w1".into(),
                title: "Title w1".into(),
                body: "Waiting for you",
            }
        );
        assert_eq!(NotifyKind::Finished.body(), "Finished");
        assert_eq!(NotifyKind::Error.body(), "Needs attention");
    }

    #[test]
    fn fallbacks_are_quiet_off_macos() {
        if cfg!(target_os = "macos") {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        request_notification_permission(move |p| tx.send(p).unwrap());
        assert_eq!(rx.recv().unwrap(), Permission::Unsupported);
        assert!(app_is_active());
        set_badge_count(2);
        notify(
            &notice(NotifyKind::Finished, &summary("w", "unread", "ready")),
            true,
        );
    }
}
