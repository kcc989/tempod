//! Dock badge (07, Dock badge): `NSApp.dockTile.badgeLabel`. AppKit is main-thread only; a call
//! from another thread does nothing.
use objc2::MainThreadMarker;
use objc2_app_kit::NSApplication;
use objc2_foundation::NSString;

/// `None` clears the badge.
pub fn set_badge_label(label: Option<&str>) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let tile = NSApplication::sharedApplication(mtm).dockTile();
    let label = label.map(NSString::from_str);
    tile.setBadgeLabel(label.as_deref());
}

pub fn app_is_active() -> bool {
    MainThreadMarker::new().is_none_or(|mtm| NSApplication::sharedApplication(mtm).isActive())
}
