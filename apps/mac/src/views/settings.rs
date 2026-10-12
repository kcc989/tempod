//! Settings (04, Settings; 07): its own window with sidebar navigation.
//! Devices is web only (07, Scope).
use super::environments::EnvironmentsPage;
use super::settings_form::{
    PROJECT_PAGES, SettingsForm, TAB_ENVIRONMENTS, TAB_GENERAL, TAB_LOGINS, TAB_MCP, TAB_PROJECT,
};
use super::tokens::{Token, color};
use gpui_kit::base::Root;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Selectable as _, TitleBar, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, WindowOptions, div, px, size,
};

pub const TABS: [&str; 7] = [
    "Logins",
    "Project",
    "Appearance",
    "General",
    "Shortcuts",
    "Environments",
    "MCP servers",
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
    form: Entity<SettingsForm>,
    environments: Entity<EnvironmentsPage>,
}

impl Render for SettingsWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        let (tab, section) = {
            let form = self.form.read(cx);
            (form.tab, form.section)
        };
        let body = if TABS[tab] == "Shortcuts" {
            v_flex()
                .gap_1()
                .children(SHORTCUTS.iter().map(|(action, keys)| {
                    h_flex()
                        .justify_between()
                        .child(*action)
                        .child(div().text_color(muted).child(*keys))
                }))
                .into_any_element()
        } else if tab == TAB_ENVIRONMENTS {
            self.environments.clone().into_any_element()
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
            .children(
                [TAB_GENERAL, TAB_LOGINS, TAB_ENVIRONMENTS, TAB_MCP, 2, 4].map(|ix| {
                    Button::new(SharedString::from(format!("settings-nav-{ix}")))
                        .ghost()
                        .label(TABS[ix])
                        .selected(tab == ix)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.form.update(cx, |form, cx| form.show_tab(ix, cx));
                        }))
                }),
            )
            .child(div().mt_4().text_color(muted).child("Project"))
            .children(PROJECT_PAGES.iter().enumerate().map(|(ix, (label, _))| {
                Button::new(SharedString::from(format!("project-settings-nav-{ix}")))
                    .ghost()
                    .label(*label)
                    .selected(tab == TAB_PROJECT && section == ix)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.form
                            .update(cx, |form, cx| form.show_project_page(ix, cx));
                    }))
            }));
        let title = if tab == TAB_PROJECT {
            PROJECT_PAGES[section].0
        } else {
            TABS[tab]
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

/// Opens Settings on General, or brings an open Settings window to the front as it is.
pub fn open(cx: &mut App) {
    show(None, cx);
}

/// Opens Settings on Logins, the page the add-login entry points ask for (04, Settings).
pub fn open_logins(cx: &mut App) {
    show(Some(TAB_LOGINS), cx);
}

fn show(tab: Option<usize>, cx: &mut App) {
    if let Some(handle) =
        crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).settings_window)
        && handle
            .update(cx, |_, window, cx| {
                if let Some(tab) = tab
                    && let Ok(view) = Root::read(window, cx)
                        .view()
                        .clone()
                        .downcast::<SettingsWindow>()
                {
                    let form = view.read(cx).form.clone();
                    form.update(cx, |form, cx| form.show_tab(tab, cx));
                }
                window.activate_window();
            })
            .is_ok()
    {
        return;
    }
    let options = WindowOptions {
        window_min_size: Some(size(px(760.), px(520.))),
        ..TitleBar::window_options()
    };
    let opened = gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| {
            let form = cx.new(|cx| {
                let mut form = SettingsForm::new(window, cx);
                form.tab = tab.unwrap_or(TAB_GENERAL);
                form
            });
            cx.observe(&form, |_, _, cx| cx.notify()).detach();
            let environments = cx.new(|cx| EnvironmentsPage::new(window, cx));
            SettingsWindow { form, environments }
        })
    });
    if let Ok((handle, _)) = opened
        && let Some(app) = crate::app::AppState::try_global(cx)
    {
        app.update(cx, |a, _| a.settings_window = Some(handle));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;

    fn shown_tab(state: &Entity<crate::app::AppState>, cx: &mut TestAppContext) -> usize {
        let handle = state.read_with(cx, |a, _| a.settings_window).unwrap();
        cx.update_window(handle, |_, window, cx| {
            let view = Root::read(window, cx).view().clone();
            let view = view.downcast::<SettingsWindow>().unwrap();
            view.read(cx).form.read(cx).tab
        })
        .unwrap()
    }

    #[gpui_kit::test]
    fn add_login_opens_logins_and_settings_keeps_the_page(cx: &mut TestAppContext) {
        cx.background_executor.allow_parking();
        let state = cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_global(crate::storage::Local::load(None));
            let runtime = crate::client::ClientRuntime::start().unwrap();
            let state = cx.new(|cx| crate::app::AppState::new(runtime, cx));
            crate::app::set_global_for_test(state.clone(), cx);
            state
        });
        cx.update(open);
        assert_eq!(shown_tab(&state, cx), TAB_GENERAL);
        cx.update(open_logins);
        assert_eq!(shown_tab(&state, cx), TAB_LOGINS);
        cx.update(open);
        assert_eq!(shown_tab(&state, cx), TAB_LOGINS);
        state.update(cx, |a, _| a.settings_window = None);
        cx.update(open_logins);
        assert_eq!(shown_tab(&state, cx), TAB_LOGINS);
    }
}
