//! macOS integration (07, macOS integration): Keychain, notifications, Dock badge and wake events,
//! through `security-framework` and `objc2`. The only module allowed to use unsafe code.
//! `crate::platform` is the cross-platform face and holds the rules.
//! The `tempo` URL scheme needs no code here: `Info.plist` registers it and GPUI delivers the
//! URLs through `App::on_open_urls` (see `crate::url_scheme`).
#![allow(unsafe_code)]

pub mod dock;
pub mod keychain;
pub mod notifications;
pub mod wake;
