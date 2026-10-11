//! Wake from sleep (07, Live state and reconnects): `NSWorkspaceDidWakeNotification` on
//! `NSWorkspace.sharedWorkspace.notificationCenter`.
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
use objc2_foundation::NSNotification;
use std::cell::RefCell;
use std::ptr::NonNull;

thread_local! {
    static OBSERVERS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
        const { RefCell::new(Vec::new()) };
}

/// `on_wake` runs on the thread that posts the notification.
pub fn observe(on_wake: impl Fn() + Send + Sync + 'static) {
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let block = RcBlock::new(move |_: NonNull<NSNotification>| on_wake());
    // SAFETY: the name is AppKit's constant; with no object and no queue the block runs on the
    // posting thread, which `on_wake: Send + Sync` allows.
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidWakeNotification),
            None,
            None,
            &block,
        )
    };
    OBSERVERS.with(|o| o.borrow_mut().push(observer));
}
