//! Keychain, generic password: service `dev.tempo.mac`, account = the Tempo host (07, Local
//! storage). Stub: kept in memory until M1 calls `security_framework::passwords`
//! (`set_generic_password`, `get_generic_password`, `delete_generic_password`).
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const SERVICE: &str = "dev.tempo.mac";

fn items() -> &'static Mutex<HashMap<String, String>> {
    static ITEMS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ITEMS.get_or_init(Default::default)
}

pub fn get(account: &str) -> Option<String> {
    items().lock().ok()?.get(account).cloned()
}

pub fn set(account: &str, password: &str) -> Result<(), String> {
    let mut items = items()
        .lock()
        .map_err(|_| "keychain stub poisoned".to_string())?;
    items.insert(account.to_string(), password.to_string());
    Ok(())
}

pub fn delete(account: &str) {
    if let Ok(mut items) = items().lock() {
        items.remove(account);
    }
}
