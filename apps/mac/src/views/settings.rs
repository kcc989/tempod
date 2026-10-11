//! Settings (04, Settings; 07): its own window, with GPUI Kit `Settings` in M4. Tabs as on the
//! web except Devices, which is web only (07, Scope).
use super::tokens::{Token, color};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{TitleBar, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Styled as _, Window, WindowOptions, div, px, size,
};

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
    form: Entity<super::settings_form::SettingsForm>,
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
        } else {
            self.form.clone().into_any_element()
        };
        v_flex()
            .key_context(crate::keymap::WORKSPACE)
            .on_action(
                cx.listener(|_, _: &crate::actions::CloseTab, window, _| window.remove_window()),
            )
            .size_full()
            .child(TitleBar::new().child("Settings"))
            .child(
                TabBar::new("settings-tabs")
                    .selected_index(self.tab)
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.tab = *ix;
                        this.form.update(cx, |f, cx| {
                            f.tab = *ix;
                            cx.notify();
                        });
                        cx.notify();
                    }))
                    .children(TABS.map(|t| Tab::new().label(t))),
            )
            .child(div().flex_1().p_4().child(body))
    }
}

pub fn open(cx: &mut App) {
    if let Some(handle) =
        crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).settings_window)
        && handle
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
    {
        return;
    }
    let options = WindowOptions {
        window_min_size: Some(size(px(560.), px(420.))),
        ..TitleBar::window_options()
    };
    let opened = gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| SettingsWindow {
            tab: 0,
            form: cx.new(|cx| super::settings_form::SettingsForm::new(window, cx)),
        })
    });
    if let Ok((handle, _)) = opened
        && let Some(app) = crate::app::AppState::try_global(cx)
    {
        app.update(cx, |a, _| a.settings_window = Some(handle));
    }
}
