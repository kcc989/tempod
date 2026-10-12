use super::tokens::{Token, color};
use crate::app::{AppState, AuthState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{Disableable as _, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    Subscription, Window, div, px,
};

pub struct SignInView {
    url: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

impl SignInView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = AppState::global(cx);
        let saved = state.read(cx).server_url.clone().unwrap_or_default();
        let url = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value(saved)
                .placeholder("https://tempo.example.com")
        });
        url.update(cx, |input, cx| input.focus(window, cx));
        let changed = cx.observe_in(&state, window, |this, state, window, cx| {
            if matches!(state.read(cx).auth, AuthState::Connect { .. }) {
                this.url.update(cx, |input, cx| input.focus(window, cx));
            }
            cx.notify();
        });
        let enter = cx.subscribe_in(&url, window, |this, _, event: &InputEvent, _, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.connect(cx);
            }
        });
        Self {
            url,
            _subscriptions: vec![changed, enter],
        }
    }

    fn connect(&mut self, cx: &mut Context<Self>) {
        let state = AppState::global(cx);
        if !matches!(state.read(cx).auth, AuthState::Connect { .. }) {
            return;
        }
        let url = self.url.read(cx).value().to_string();
        if url.trim().is_empty() {
            return;
        }
        state.update(cx, |state, cx| state.connect(&url, false, cx));
    }
}

impl Render for SignInView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let auth = AppState::global(cx).read(cx).auth.clone();
        let body = match auth {
            AuthState::Connect { error, .. } => v_flex()
                .gap_3()
                .child(div().text_xl().child("Connect to Tempo"))
                .child("Tempo URL")
                .child(
                    Input::new(&self.url)
                        .id("tempo-url")
                        .aria_label("Tempo URL"),
                )
                .children(
                    error.map(|error| div().text_color(color(Token::Destructive, cx)).child(error)),
                )
                .child(
                    Button::new("connect-tempo")
                        .primary()
                        .label("Connect")
                        .disabled(self.url.read(cx).value().trim().is_empty())
                        .on_click(cx.listener(|this, _, _, cx| this.connect(cx))),
                )
                .into_any_element(),
            AuthState::ClearingSession => div().child("Returning to sign-in…").into_any_element(),
            AuthState::Connecting => div().child("Connecting to Tempo…").into_any_element(),
            AuthState::AwaitingApproval {
                user_code,
                verification_uri_complete,
            } => v_flex()
                .gap_3()
                .child(div().text_xl().child("Approve sign-in in your browser"))
                .child("Check that the browser shows this code:")
                .child(div().text_3xl().font_family("monospace").child(user_code))
                .child(
                    Button::new("open-sign-in-browser")
                        .primary()
                        .label("Open browser")
                        .on_click(move |_, _, cx| cx.open_url(&verification_uri_complete)),
                )
                .into_any_element(),
            AuthState::UpdateRequired => {
                let app = AppState::global(cx);
                v_flex().gap_3().child(div().text_xl().child("Update Tempo"))
                    .child("This server requires a newer version of Tempo for Mac.")
                    .children(app.read(cx).available_update.clone().map(|version|div().child(format!("Tempo {version} is available."))))
                    .child(Button::new("required-download").label(if app.read(cx).downloading_update { "Downloading…" } else { "Download" }).disabled(app.read(cx).downloading_update || !app.read(cx).has_download_session()).on_click(|_,window,cx|AppState::global(cx).update(cx,|a,cx|a.download_update(window,cx))))
                    .children((!app.read(cx).has_download_session()).then(||div().child("A saved owner session is required to download this update. Install the current client through Tempo in your browser, then connect.")))
                    .children(app.read(cx).update_error.clone().map(|e|div().text_color(color(Token::Destructive,cx)).child(e)))
                    .into_any_element()
            }
            AuthState::SignedIn => div().into_any_element(),
        };
        v_flex()
            .size_full()
            .justify_center()
            .items_center()
            .p_6()
            .child(div().w(px(420.)).child(body))
    }
}
