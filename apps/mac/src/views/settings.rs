//! Settings (04, Settings; 07): its own window, with GPUI Kit `Settings` in M4. Tabs as on the
//! web except Devices, which is web only (07, Scope).
use super::tokens::{Token, color};
use crate::app::AppState;
use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{TitleBar, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    Task, Window, WindowOptions, div, px, size,
};
use std::time::Duration;
use tempo_protocol::{self as p, api};

pub const TABS: [&str; 5] = [
    "Logins",
    "Project",
    "Appearance",
    "Notifications",
    "Shortcuts",
];

/// The shortcut table of 04 with its Conductor column, read-only.
pub const SHORTCUTS: &[(&str, &str)] = &[
    ("Command palette", "⌘K"),
    ("New workspace", "⌘N"),
    ("New chat tab", "⌘T"),
    ("Close tab", "⌘W"),
    ("Next or previous center tab", "⌃Tab or ⌃⇧Tab"),
    ("Switch to workspace 1 to 9", "⌘1 to ⌘9"),
    ("Next or previous workspace", "⌘⌥↓ or ⌘⌥↑"),
    ("Next workspace that needs you", "⌘⌥L"),
    ("Toggle sidebar", "⌘B"),
    ("Toggle right side", "⌘⌥B"),
    ("Toggle bottom panel", "⌘J"),
    ("Focus composer", "⌘L"),
    ("Send", "Enter"),
    ("New line", "⇧Enter"),
    ("Stop the turn", "Esc or ⌘⇧⌫"),
    ("Toggle plan mode", "⇧Tab"),
    ("Model picker", "⌘/"),
    ("Attach a file", "⌘U"),
    ("Approve or deny a permission", "Enter or ⌫"),
    ("Expand all tool calls", "⌃O"),
    ("Diff tab", "⌘⇧D"),
    ("Branch or uncommitted scope", "⌘⌥U"),
    ("Next or previous file in the diff", "↓ or ↑"),
    ("Mark file viewed", "⌃V"),
    ("Open file", "⌘P"),
    ("Search files", "⌘⇧F"),
    ("Commit and push", "⌘⇧Y"),
    ("Create PR", "⌘⇧P"),
    ("Merge", "⌘⇧M"),
    ("Archive", "⌘⇧A"),
    ("Start or stop the default run script", "⌘R"),
    ("Settings", "⌘,"),
];

pub struct SettingsWindow {
    tab: usize,
    codex_set: Option<bool>,
    login: Option<p::StartCodexLoginOut>,
    busy: bool,
    error: Option<String>,
    login_task: Option<Task<()>>,
    upload: bool,
    auth_json: Entity<InputState>,
}

impl SettingsWindow {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let auth_json =
            cx.new(|cx| InputState::new(window, cx).placeholder("Paste auth.json here"));
        if let Some(client) = AppState::try_global(cx).and_then(|s| s.read(cx).client()) {
            let request = client.call::<api::GetCredentialStatus>(p::Empty {});
            cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = this.update(cx, |this, cx| {
                    match result {
                        Ok(status) => this.codex_set = Some(status.codex.set),
                        Err(error) => this.error = Some(error.to_string()),
                    }
                    cx.notify();
                });
            })
            .detach();
        }
        Self {
            tab: 0,
            codex_set: None,
            login: None,
            busy: false,
            error: None,
            login_task: None,
            upload: false,
            auth_json,
        }
    }

    fn client(&self, cx: &App) -> Option<tempo_client::Client> {
        AppState::try_global(cx).and_then(|s| s.read(cx).client())
    }

    fn connected(&mut self, cx: &mut Context<Self>) {
        self.codex_set = Some(true);
        self.login = None;
        self.busy = false;
        self.error = None;
        if let Some(state) = AppState::try_global(cx) {
            let workspaces = state.read(cx).workspaces.clone();
            for workspace in workspaces {
                workspace.update(cx, |workspace, cx| {
                    workspace
                        .state
                        .clear_credential_invalid(&[p::CredentialProvider::Codex]);
                    cx.notify();
                });
            }
        }
        cx.notify();
    }

    fn connect_codex(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client(cx) else {
            return;
        };
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        cx.notify();
        self.login_task = Some(cx.spawn(async move |this, cx| {
            let result = client.call::<api::StartCodexLogin>(p::Empty {}).await;
            let login = match result {
                Ok(login) => login,
                Err(error) => {
                    let _ = this.update(cx, |this, cx| {
                        this.busy = false;
                        this.error = Some(error.to_string());
                        cx.notify();
                    });
                    return;
                }
            };
            if this
                .update(cx, |this, cx| {
                    this.login = Some(login.clone());
                    cx.notify();
                })
                .is_err()
            {
                return;
            }
            loop {
                cx.background_executor()
                    .timer(Duration::from_secs_f64((login.interval_ms / 1000.).max(1.)))
                    .await;
                let Ok(login_id) = login.login_id.clone().try_into() else {
                    return;
                };
                let result = client
                    .call::<api::PollCodexLogin>(p::PollCodexLoginIn { login_id })
                    .await;
                match result {
                    Ok(result) if result.status == p::PollCodexLoginOutStatus::Pending => continue,
                    Ok(result) if result.status == p::PollCodexLoginOutStatus::Connected => {
                        let _ = this.update(cx, |this, cx| this.connected(cx));
                    }
                    result => {
                        let _ = this.update(cx, |this, cx| {
                            this.login = None;
                            this.busy = false;
                            this.error = Some(match result {
                                Err(error) => error.to_string(),
                                _ => "Codex login expired. Connect again to get a new code.".into(),
                            });
                            cx.notify();
                        });
                    }
                }
                break;
            }
        }));
    }

    fn cancel_codex(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client(cx) else {
            return;
        };
        let Some(login) = &self.login else {
            return;
        };
        let Ok(login_id) = login.login_id.clone().try_into() else {
            return;
        };
        self.login_task.take();
        self.login_task = Some(cx.spawn(async move |this, cx| {
            let result = client
                .call::<api::CancelCodexLogin>(p::CancelCodexLoginIn { login_id })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.login = None;
                this.busy = false;
                this.error = result.err().map(|error| error.to_string());
                cx.notify();
            });
        }));
    }

    fn upload_codex(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client(cx) else {
            return;
        };
        let Ok(auth_json) = self.auth_json.read(cx).value().to_string().try_into() else {
            return;
        };
        if self.busy {
            return;
        }
        self.auth_json
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.busy = true;
        self.error = None;
        cx.notify();
        let request = client.call::<api::SetCodexAuth>(p::SetCodexAuthIn { auth_json });
        self.login_task = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(_) => this.connected(cx),
                Err(error) => {
                    this.busy = false;
                    this.error = Some(error.to_string());
                    cx.notify();
                }
            });
        }));
    }

    fn logins(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let mut card = v_flex().gap_3()
            .child(div().text_lg().child("Codex"))
            .child(match self.codex_set { Some(true) => "Set", Some(false) => "Not set", None => "Loading…" })
            .child("Sign in with ChatGPT using a one-time code. Enable device-code login in your ChatGPT security settings or ask your workspace admin.");
        if let Some(login) = &self.login {
            let uri = login.verification_url.clone();
            card = card
                .child("Open the sign-in page, then enter this code:")
                .child(
                    div()
                        .text_3xl()
                        .font_family("monospace")
                        .child(login.user_code.clone()),
                )
                .child(
                    Button::new("codex-open-sign-in")
                        .primary()
                        .label("Open sign-in page")
                        .on_click(move |_, _, cx| cx.open_url(&uri)),
                )
                .child(
                    Button::new("codex-cancel")
                        .label("Cancel")
                        .on_click(cx.listener(|this, _, _, cx| this.cancel_codex(cx))),
                )
                .child("Waiting for sign-in… This code expires in 15 minutes.");
        } else {
            card = card.child(
                Button::new("codex-connect")
                    .primary()
                    .disabled(self.busy)
                    .label(if self.busy {
                        "Connecting…"
                    } else if self.codex_set == Some(true) {
                        "Reconnect Codex"
                    } else {
                        "Connect Codex"
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.connect_codex(cx))),
            );
        }
        card = card
            .children(
                self.error
                    .clone()
                    .map(|error| div().text_color(color(Token::Destructive, cx)).child(error)),
            )
            .child(
                Button::new("codex-upload-toggle")
                    .disabled(self.busy)
                    .label("Use auth.json instead")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.upload = !this.upload;
                        cx.notify();
                    })),
            );
        if self.upload {
            card = card
                .child("Run codex login, then paste ~/.codex/auth.json.")
                .child(
                    Input::new(&self.auth_json)
                        .id("codex-auth-json")
                        .aria_label("Codex auth.json"),
                )
                .child(
                    Button::new("codex-upload-save")
                        .disabled(self.busy)
                        .label("Save")
                        .on_click(cx.listener(|this, _, window, cx| this.upload_codex(window, cx))),
                );
        }
        card
    }
}

impl Render for SettingsWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        let body = if TABS[self.tab] == "Shortcuts" {
            v_flex()
                .gap_1()
                .children(SHORTCUTS.iter().map(|(action, keys)| {
                    h_flex()
                        .justify_between()
                        .child(*action)
                        .child(div().text_color(muted).child(*keys))
                }))
                .into_any_element()
        } else if TABS[self.tab] == "Logins" {
            self.logins(cx).into_any_element()
        } else {
            super::skeleton_rows(6).into_any_element()
        };
        v_flex()
            .size_full()
            .child(TitleBar::new().child("Settings"))
            .child(
                TabBar::new("settings-tabs")
                    .selected_index(self.tab)
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.tab = *ix;
                        cx.notify();
                    }))
                    .children(TABS.map(|t| Tab::new().label(t))),
            )
            .child(div().flex_1().p_4().child(body))
    }
}

pub fn open(cx: &mut App) {
    let options = WindowOptions {
        window_min_size: Some(size(px(560.), px(420.))),
        ..TitleBar::window_options()
    };
    let _ = gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| SettingsWindow::new(window, cx))
    });
}
