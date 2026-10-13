//! Keychain, generic password: service `dev.tempo.mac`, account = the Tempo host (07, Local
//! storage). Errors carry the OSStatus code only.
use crate::logging;
use security_framework::passwords::{
    PasswordOptions, delete_generic_password, generic_password, set_generic_password,
};
use serde_json::json;
use std::{
    io::Write,
    process::{Command, Stdio},
};

pub const SERVICE: &str = crate::BUNDLE_ID;

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

fn helper(operation: &str, account: &str, secret: Option<&str>) -> Option<Result<Vec<u8>, i32>> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.parent()?.join("Helpers/TempoKeychain");
    if !path.is_file() {
        return None;
    }
    Some((|| {
        let mut child = Command::new(path)
            .args([operation, account])
            .stdin(if secret.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| -36)?;
        if let Some(secret) = secret {
            child
                .stdin
                .take()
                .ok_or(-36)?
                .write_all(secret.as_bytes())
                .map_err(|_| -36)?;
        }
        let output = child.wait_with_output().map_err(|_| -36)?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(String::from_utf8_lossy(&output.stderr)
                .trim()
                .strip_prefix("Keychain status=")
                .and_then(|s| s.parse().ok())
                .unwrap_or(-50))
        }
    })())
}

pub fn get(account: &str) -> Option<String> {
    if let Some(result) = helper("get", account, None) {
        return match result {
            Ok(bytes) => String::from_utf8(bytes).ok(),
            Err(status) => {
                if status != ERR_SEC_ITEM_NOT_FOUND {
                    logging::warn("keychain", "read failed", json!({"status":status}));
                }
                None
            }
        };
    }
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
    if let Some(result) = helper("set", account, Some(password)) {
        return result
            .map(|_| ())
            .map_err(|status| format!("Keychain error {status}"));
    }
    set_generic_password(SERVICE, account, password.as_bytes())
        .map_err(|e| format!("Keychain error {}", e.code()))
}

pub fn delete(account: &str) {
    if let Some(result) = helper("delete", account, None) {
        if let Err(status) = result
            && status != ERR_SEC_ITEM_NOT_FOUND
        {
            logging::warn("keychain", "delete failed", json!({"status":status}));
        }
        return;
    }
    if let Err(e) = delete_generic_password(SERVICE, account)
        && e.code() != ERR_SEC_ITEM_NOT_FOUND
    {
        logging::warn("keychain", "delete failed", json!({"status": e.code()}));
    }
}
