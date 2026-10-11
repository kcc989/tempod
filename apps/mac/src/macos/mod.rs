//! macOS integration (07, macOS integration): Keychain, notifications, Dock badge and wake events.
//! The only module allowed to use unsafe code. It depends on std only for now; each submodule
//! notes the API it will call. `crate::platform` is the cross-platform face.
//! The `tempo` URL scheme needs no code here: `Info.plist` registers it and GPUI delivers the
//! URLs through `App::on_open_urls` (see `crate::url_scheme`).
#![allow(unsafe_code)]

pub mod dock;
pub mod keychain;
pub mod notifications;
pub mod wake;
