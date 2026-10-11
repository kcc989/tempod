//! Tempo for Mac (07). The binary in `main.rs` wires these modules together.
#![deny(unsafe_code)]

pub mod actions;
pub mod app;
pub mod client;
pub mod image_policy;
pub mod keymap;
pub mod links;
pub mod markdown;
pub mod menus;
pub mod platform;
pub mod stores;
pub mod url_scheme;
pub mod views;

#[cfg(target_os = "macos")]
pub mod macos;

/// 07, Local storage: the Keychain item and folders depend on it.
pub const BUNDLE_ID: &str = "dev.tempo.mac";
pub const APP_NAME: &str = "Tempo";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The `X-Tempo-Client` header value sent on every request (07, Live state).
pub fn client_header() -> String {
    format!("mac/{VERSION}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn client_header_names_the_platform_and_version() {
        assert_eq!(super::client_header(), format!("mac/{}", super::VERSION));
    }
}
