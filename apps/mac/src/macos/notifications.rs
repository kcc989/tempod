//! macOS notifications (07, Notifications) through `UNUserNotificationCenter`. `workspaceId` goes
//! in `userInfo`; a click hands it to the callback from `on_click`. When to send and the copy are
//! decided in `crate::platform`. Do not also use GPUI's `show_system_notification`: it installs
//! its own delegate and asks for permission on the first post.
//!
//! The notification center aborts the process when the binary is not inside an app bundle
//! (`cargo run`), so every entry point checks for a bundle identifier first.
use crate::logging;
use crate::platform::Permission;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{AnyThread as _, define_class, msg_send};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use serde_json::json;
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};

const WORKSPACE_ID_KEY: &str = "workspaceId";

type ClickHandler = Box<dyn Fn(String) + Send + Sync>;

fn click_handler() -> &'static Mutex<Option<ClickHandler>> {
    static HANDLER: OnceLock<Mutex<Option<ClickHandler>>> = OnceLock::new();
    HANDLER.get_or_init(|| Mutex::new(None))
}

fn center() -> Option<Retained<UNUserNotificationCenter>> {
    NSBundle::mainBundle().bundleIdentifier()?;
    Some(UNUserNotificationCenter::currentNotificationCenter())
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "TempoNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            if let Some(id) = workspace_id(response)
                && let Ok(handler) = click_handler().lock()
                && let Some(handler) = handler.as_ref()
            {
                handler(id);
            }
            completion_handler.call(());
        }

        // Tempo sends only while it is not active (04); one that lands after the app became
        // active is not shown.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((UNNotificationPresentationOptions::empty(),));
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's init is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

fn workspace_id(response: &UNNotificationResponse) -> Option<String> {
    let info = response.notification().request().content().userInfo();
    let key = NSString::from_str(WORKSPACE_ID_KEY);
    let value = info.objectForKey(&key)?;
    let id = value.downcast::<NSString>().ok()?;
    Some(id.to_string())
}

/// Installs the delegate and the click callback. The center keeps only a weak reference to its
/// delegate, so the delegate lives for the rest of the process.
pub fn on_click(on_click: impl Fn(String) + Send + Sync + 'static) {
    if let Ok(mut handler) = click_handler().lock() {
        *handler = Some(Box::new(on_click));
    }
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.get().is_some() {
        return;
    }
    let Some(center) = center() else {
        return;
    };
    let delegate = Delegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
    let _ = INSTALLED.set(());
}

pub fn request_authorization(on_result: impl Fn(Permission) + Send + Sync + 'static) {
    let Some(center) = center() else {
        on_result(Permission::Unsupported);
        return;
    };
    let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        if !error.is_null() {
            logging::warn("notifications", "authorization request failed", json!({}));
        }
        on_result(if granted.as_bool() {
            Permission::Granted
        } else {
            Permission::Denied
        });
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &block,
    );
}

pub fn authorization(on_result: impl Fn(Permission) + Send + Sync + 'static) {
    let Some(center) = center() else {
        on_result(Permission::Unsupported);
        return;
    };
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: the center passes a valid settings object for the duration of the call.
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        on_result(permission(status));
    });
    center.getNotificationSettingsWithCompletionHandler(&block);
}

fn permission(status: UNAuthorizationStatus) -> Permission {
    match status {
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral => Permission::Granted,
        UNAuthorizationStatus::Denied => Permission::Denied,
        _ => Permission::Default,
    }
}

/// Posts at once. One notification per workspace: a newer one replaces the older, as the web's
/// `tag`.
pub fn post(workspace_id: &str, title: &str, body: &str, sound: bool) {
    let Some(center) = center() else {
        return;
    };
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    if sound {
        content.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    let key = NSString::from_str(WORKSPACE_ID_KEY);
    let value = NSString::from_str(workspace_id);
    let info = NSDictionary::<NSString, NSString>::from_slices(&[&*key], &[&*value]);
    // SAFETY: userInfo must be a property-list dictionary; this one maps a string to a string.
    let info = unsafe { Retained::cast_unchecked::<NSDictionary<AnyObject, AnyObject>>(info) };
    // SAFETY: as above.
    unsafe { content.setUserInfo(&info) };
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&format!("tempo:{workspace_id}")),
        &content,
        None,
    );
    let done = RcBlock::new(|error: *mut NSError| {
        if !error.is_null() {
            logging::warn("notifications", "post failed", json!({}));
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
}
