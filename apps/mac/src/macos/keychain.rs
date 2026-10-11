//! Keychain, generic password: service `dev.tempo.mac`, account = the Tempo host (07, Local
//! storage). Errors carry the OSStatus code only.
use crate::logging;
use security_framework::passwords::{
    PasswordOptions, delete_generic_password, generic_password, set_generic_password,
};
use serde_json::json;

pub const SERVICE: &str = crate::BUNDLE_ID;

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

pub fn get(account: &str) -> Option<String> {
    match generic_password(PasswordOptions::new_generic_password(SERVICE, account)) {
        Ok(bytes) => String::from_utf8(bytes).ok(),
        Err(e) => {
            if e.code() != ERR_SEC_ITEM_NOT_FOUND {
                logging::warn("keychain", "read failed", json!({"status": e.code()}));
            }
            None
        }
    }
}

/// Adds the item, or replaces the one already there.
pub fn set(account: &str, password: &str) -> Result<(), String> {
    set_generic_password(SERVICE, account, password.as_bytes())
        .map_err(|e| format!("Keychain error {}", e.code()))
}

pub fn delete(account: &str) {
    if let Err(e) = delete_generic_password(SERVICE, account)
        && e.code() != ERR_SEC_ITEM_NOT_FOUND
    {
        logging::warn("keychain", "delete failed", json!({"status": e.code()}));
    }
}
