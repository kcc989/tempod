//! Settings (04, Settings; 07): its own window, with GPUI Kit `Settings` in M4. Tabs as on the
//! web except Devices, which is web only (07, Scope).
//! Project fields in M4 use direct editing and Reset to inherited, as specified in 04 and 07.
use super::tokens::{Token, color};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{TitleBar, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, IntoElement, ParentElement as _, Render, Styled as _, Window,
    WindowOptions, div, px, size,
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
    let _ = gpui_kit::open_window(options, cx, |_, cx| cx.new(|_| SettingsWindow { tab: 0 }));
}
