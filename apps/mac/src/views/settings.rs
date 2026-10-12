//! Settings (04, Settings; 07): its own window with sidebar navigation.
//! Devices is web only (07, Scope).
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{TitleBar, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, WindowOptions, div, px, size,
};

pub const TABS: [&str; 5] = [
    "Logins",
    "Project",
    "Appearance",
    "General",
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
    section: usize,
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
        let sidebar = v_flex()
            .w(px(220.))
            .h_full()
            .p_4()
            .gap_2()
            .border_r_1()
            .border_color(color(Token::Border, cx))
            .child(div().text_color(muted).child("Personal"))
            .children([3, 0, 2, 4].map(|ix| {
                Button::new(SharedString::from(format!("settings-nav-{ix}")))
                    .ghost()
                    .label(TABS[ix])
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.tab = ix;
                        this.form.update(cx, |form, cx| {
                            form.tab = ix;
                            cx.notify();
                        });
                        cx.notify();
                    }))
            }))
            .child(div().mt_4().text_color(muted).child("Project"))
            .children(
                ["Agents", "Scripts", "Environment", "Git", "Prompts", "Secrets", "General"]
                    .into_iter()
                    .enumerate()
                    .map(|(ix, label)| {
                        Button::new(SharedString::from(format!("project-settings-nav-{ix}")))
                            .ghost()
                            .label(label)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.tab = 1;
                                this.section = ix;
                                this.form.update(cx, |form, cx| {
                                    form.tab = 1;
                                    form.section = ix;
                                    cx.notify();
                                });
                                cx.notify();
                            }))
                    }),
            );
        let title = if self.tab == 1 {
            ["Agents", "Scripts", "Environment", "Git", "Prompts", "Secrets", "General"][self.section]
        } else {
            TABS[self.tab]
        };
        v_flex()
            .key_context(crate::keymap::WORKSPACE)
            .on_action(
                cx.listener(|_, _: &crate::actions::CloseTab, window, _| window.remove_window()),
            )
            .size_full()
            .child(TitleBar::new().child("Settings"))
            .child(
                h_flex().flex_1().min_h_0().child(sidebar).child(
                    v_flex()
                        .flex_1()
                        .p_6()
                        .gap_4()
                        .child(div().text_lg().child(title))
                        .child(body),
                ),
            )
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
        window_min_size: Some(size(px(760.), px(520.))),
        ..TitleBar::window_options()
    };
    let opened = gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| SettingsWindow {
            tab: 3,
            section: 0,
            form: cx.new(|cx| {
                let mut form = super::settings_form::SettingsForm::new(window, cx);
                form.tab = 3;
                form
            }),
        })
    });
    if let Ok((handle, _)) = opened
        && let Some(app) = crate::app::AppState::try_global(cx)
    {
        app.update(cx, |a, _| a.settings_window = Some(handle));
    }
}
