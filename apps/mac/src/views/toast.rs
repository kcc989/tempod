//! 04, Toasts: server-function errors show as a toast with the UI message from the error table
//! (02), as the web's `lib/toast.ts`.
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::notification::Notification;
use gpui_kit::{App, SharedString, Window};
use tempo_client::ApiError;
use tempo_protocol::AgentId;

/// The UI message for `error`. An error without a Tempo error body counts as `INTERNAL`.
pub fn error_text(error: &ApiError, agent: Option<AgentId>) -> String {
    crate::errors::error_message(&error_code(error), agent)
}

pub fn error_code(error: &ApiError) -> String {
    error
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "INTERNAL".into())
}

/// A 401 returns to Connect to Tempo (07) and a cancelled call has nothing to say.
pub fn shows_toast(error: &ApiError) -> bool {
    !error.is_unauthorized() && *error != ApiError::Cancelled
}

struct ErrorToast;

/// One toast per error code, as the web's `error:<code>` toast id.
pub fn error(error: &ApiError, agent: Option<AgentId>, window: &mut Window, cx: &mut App) {
    if !shows_toast(error) {
        return;
    }
    window.push_notification(
        Notification::error(error_text(error, agent))
            .id1::<ErrorToast>(SharedString::from(error_code(error))),
        cx,
    );
}

/// [`error`] in the main window, for views that have no window at hand. It runs after the
/// current update, so it never meets a leased window.
pub fn error_in_main_window(error: &ApiError, agent: Option<AgentId>, cx: &mut App) {
    if !shows_toast(error) {
        return;
    }
    let Some(handle) = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).main_window)
    else {
        return;
    };
    let error = error.clone();
    cx.defer(move |cx| {
        let _ = handle.update(cx, |_, window, cx| self::error(&error, agent, window, cx));
    });
}

pub fn success(message: impl Into<SharedString>, window: &mut Window, cx: &mut App) {
    window.push_notification(Notification::success(message), cx);
}

pub fn success_in_main_window(message: impl Into<SharedString>, cx: &mut App) {
    let Some(handle) = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).main_window)
    else {
        return;
    };
    let message = message.into();
    cx.defer(move |cx| {
        let _ = handle.update(cx, |_, window, cx| success(message, window, cx));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(code: &str) -> ApiError {
        ApiError::Server {
            status: 409,
            error: serde_json::from_value(serde_json::json!({
                "code": code,
                "message": "server text"
            }))
            .unwrap(),
        }
    }

    #[test]
    fn messages_come_from_the_error_table() {
        assert_eq!(
            error_text(&server("PR_EXISTS"), None),
            "A pull request already exists."
        );
        assert_eq!(
            error_text(&server("CREDENTIAL_MISSING"), Some(AgentId::Codex)),
            "Add your Codex login in Settings."
        );
        assert_eq!(
            error_text(&ApiError::Network("reset".into()), None),
            "Something went wrong."
        );
        assert_eq!(error_code(&ApiError::Http { status: 502 }), "INTERNAL");
    }

    #[test]
    fn sign_in_and_cancelled_errors_do_not_toast() {
        assert!(shows_toast(&server("PR_EXISTS")));
        let ApiError::Server { error, .. } = server("UNAUTHENTICATED") else {
            unreachable!()
        };
        assert!(!shows_toast(&ApiError::Server { status: 401, error }));
        assert!(!shows_toast(&ApiError::Cancelled));
    }
}
