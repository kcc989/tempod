//! Cross-platform face of `src/macos`. On macOS it calls the native module; elsewhere (the Linux
//! build machine) it keeps the token in memory and the rest are no-ops, so the app builds and
//! tests there.
use std::collections::HashMap;
use std::sync::Mutex;

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

/// The Dock badge: the number of workspaces whose attention is `needs_input`, `error` or
/// `unread` (07, Dock badge). Cleared at 0.
pub fn set_badge_count(count: usize) {
    #[cfg(target_os = "macos")]
    crate::macos::dock::set_badge_count(count);
    #[cfg(not(target_os = "macos"))]
    let _ = count;
}

/// What the Dock shows for a count.
pub fn badge_label(count: usize) -> Option<String> {
    (count > 0).then(|| count.to_string())
}

/// A macOS notification for one of the three events in 04. `workspace_id` goes in `userInfo`.
pub struct Notice<'a> {
    pub workspace_id: &'a str,
    pub title: &'a str,
    pub body: &'a str,
}

pub fn notify(notice: &Notice<'_>) {
    #[cfg(target_os = "macos")]
    crate::macos::notifications::post(notice.workspace_id, notice.title, notice.body);
    #[cfg(not(target_os = "macos"))]
    let _ = notice;
}

/// Calls `on_wake` after the Mac wakes from sleep, so every channel reconnects at once.
pub fn observe_wake(on_wake: impl Fn() + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    crate::macos::wake::observe(on_wake);
    #[cfg(not(target_os = "macos"))]
    drop(on_wake);
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
