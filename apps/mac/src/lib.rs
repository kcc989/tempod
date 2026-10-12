//! Tempo for Mac (07). The binary in `main.rs` wires these modules together.
#![deny(unsafe_code)]

#[cfg(test)]
extern crate gpui_kit as gpui;

pub mod actions;
pub mod app;
pub mod auth;
pub mod client;
pub mod image_policy;
pub mod inline_media;
pub mod keymap;
pub mod links;
pub mod logging;
pub mod markdown;
pub mod menus;
pub mod platform;
pub mod storage;
pub mod stores;
pub mod update;
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

    fn plist_value<'a>(plist: &'a str, key: &str) -> &'a str {
        let after = plist
            .split(&format!("<key>{key}</key>"))
            .nth(1)
            .unwrap_or_else(|| panic!("{key} missing"));
        let start = after.find("<string>").expect("string value") + "<string>".len();
        let end = after.find("</string>").expect("string end");
        &after[start..end]
    }

    #[test]
    fn info_plist_matches_07() {
        let plist = include_str!("../resources/Info.plist");
        assert_eq!(plist_value(plist, "CFBundleIdentifier"), super::BUNDLE_ID);
        assert_eq!(plist_value(plist, "CFBundleExecutable"), super::APP_NAME);
        assert_eq!(plist_value(plist, "LSMinimumSystemVersion"), "15.0");
        assert_eq!(
            plist_value(plist, "CFBundleShortVersionString"),
            super::VERSION
        );
        let schemes = plist.split("<key>CFBundleURLSchemes</key>").nth(1).unwrap();
        assert!(
            schemes
                .trim_start()
                .starts_with("<array>\n\t\t\t\t<string>tempo</string>")
        );
    }

    #[test]
    fn entitlements_have_no_exceptions() {
        let entitlements = include_str!("../resources/Tempo.entitlements");
        assert!(!entitlements.contains("<key>"));
    }
}
