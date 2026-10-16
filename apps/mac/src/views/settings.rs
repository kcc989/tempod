//! Settings (04, Settings; 07): a page in the main window with sidebar navigation.
//! Devices is web only (07, Scope).
use super::agents_settings::AgentsSettings;
use super::environments::EnvironmentsPage;
use super::models_page::ModelsPage;
use super::settings_form::{
    PROJECT_PAGES, SettingsForm, TAB_AGENTS, TAB_APPEARANCE, TAB_ENVIRONMENTS, TAB_GENERAL,
    TAB_LOGINS, TAB_MCP, TAB_MODELS, TAB_PROJECT, TAB_SHELL, TAB_SHORTCUTS,
};
use super::shell::ShellPage;
use super::tokens::{Token, color};
use gpui_kit::assets::IconName;
use gpui_kit::base::Root;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Selectable as _, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div, px,
};

pub const TABS: [&str; 10] = [
    "Logins",
    "Project",
    "Appearance",
    "General",
    "Shell",
    "Shortcuts",
    "Environments",
    "MCP servers",
    "Agents",
    "Models",
];

/// The shortcut table of 04 with its Mac column, read-only.
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

pub struct SettingsView {
    pub(crate) form: Entity<SettingsForm>,
    pub(crate) focus: FocusHandle,
    environments: Entity<EnvironmentsPage>,
    shell: Entity<ShellPage>,
    agents: Entity<AgentsSettings>,
    models: Entity<ModelsPage>,
    search: Entity<InputState>,
}

impl SettingsView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let form = cx.new(|cx| {
            let mut form = SettingsForm::new(window, cx);
            form.tab = TAB_GENERAL;
            form
        });
        cx.observe(&form, |_, _, cx| cx.notify()).detach();
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search settings"));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        if let Some(app) = crate::app::AppState::try_global(cx) {
            let hub = app.read(cx).hub.clone();
            cx.observe(&hub, |_, _, cx| cx.notify()).detach();
        }
        Self {
            form,
            focus: cx.focus_handle(),
            environments: cx.new(|cx| EnvironmentsPage::new(window, cx)),
            shell: cx.new(|cx| ShellPage::new(window, cx)),
            agents: cx.new(|cx| AgentsSettings::new(window, cx)),
            models: cx.new(|cx| ModelsPage::new(window, cx)),
            search,
        }
    }
}

impl Render for SettingsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        let query = self.search.read(cx).value().trim().to_lowercase();
        let matches = |label: &str| label.to_lowercase().contains(&query);
        let projects = crate::app::AppState::try_global(cx)
            .map(|a| a.read(cx).hub.read(cx).projects.clone())
            .unwrap_or_default();
        let selected_project = self.form.read(cx).selected_project().cloned();
        let (tab, section) = {
            let form = self.form.read(cx);
            (form.tab, form.section)
        };
        let body = if tab == TAB_SHORTCUTS {
            v_flex()
                .gap_1()
                .children(SHORTCUTS.iter().map(|(action, keys)| {
                    h_flex()
                        .justify_between()
                        .child(*action)
                        .child(div().text_color(muted).child(*keys))
                }))
                .into_any_element()
        } else if tab == TAB_SHELL {
            self.shell.clone().into_any_element()
        } else if tab == TAB_ENVIRONMENTS {
            self.environments.clone().into_any_element()
        } else if tab == TAB_AGENTS {
            self.agents.clone().into_any_element()
        } else if tab == TAB_MODELS {
            self.models.clone().into_any_element()
        } else {
            self.form.clone().into_any_element()
        };
        let sidebar = v_flex()
            .id("settings-navigation")
            .overflow_y_scroll()
            .w(px(256.))
            .flex_shrink_0()
            .h_full()
            .bg(color(Token::Sidebar, cx))
            .p_3()
            .gap_2()
            .border_r_1()
            .border_color(color(Token::Border, cx))
            .child(
                Button::new("settings-back")
                    .ghost()
                    .icon(IconName::ArrowLeft)
                    .accessibility_label("Back to workspace")
                    .child(div().w_full().text_left().child("Back to workspace"))
                    .on_click(|_, _, cx| close(cx)),
            )
            .child(div().mt_4().text_lg().child("Settings"))
            .child(Input::new(&self.search))
            .child(
                Button::new("settings-command-palette")
                    .ghost()
                    .icon(IconName::Search)
                    .accessibility_label("Search workspaces and actions (⌘K)")
                    .child(
                        h_flex()
                            .w_full()
                            .justify_between()
                            .child("Search workspaces")
                            .child(div().text_color(muted).child("⌘K")),
                    )
                    .on_click(|_, window, cx| {
                        window.dispatch_action(Box::new(crate::actions::CommandPalette), cx)
                    }),
            )
            .child(div().mt_4().text_color(muted).child("Personal"))
            .children(
                [
                    TAB_GENERAL,
                    TAB_SHELL,
                    TAB_LOGINS,
                    TAB_MODELS,
                    TAB_AGENTS,
                    TAB_ENVIRONMENTS,
                    TAB_MCP,
                    TAB_APPEARANCE,
                    TAB_SHORTCUTS,
                ]
                .into_iter()
                .filter(|ix| matches(TABS[*ix]))
                .map(|ix| {
                    Button::new(SharedString::from(format!("settings-nav-{ix}")))
                        .ghost()
                        .icon(match ix {
                            TAB_GENERAL => IconName::Bell,
                            TAB_SHELL => IconName::SquareTerminal,
                            TAB_LOGINS => IconName::KeyRound,
                            TAB_MODELS => IconName::ListChecks,
                            TAB_AGENTS => IconName::Bot,
                            TAB_ENVIRONMENTS => IconName::Network,
                            TAB_MCP => IconName::Server,
                            TAB_APPEARANCE => IconName::Palette,
                            _ => IconName::Keyboard,
                        })
                        .accessibility_label(TABS[ix])
                        .child(div().w_full().text_left().child(TABS[ix]))
                        .selected(tab == ix)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if ix == TAB_MODELS {
                                this.models.update(cx, |page, cx| page.load(window, cx));
                            }
                            this.form.update(cx, |form, cx| form.show_tab(ix, cx));
                        }))
                }),
            )
            .child(div().mt_4().text_color(muted).child("Projects"))
            .children(
                projects
                    .iter()
                    .filter(|project| {
                        matches(&format!("{}/{}", project.owner, project.name))
                            || PROJECT_PAGES.iter().any(|(label, _)| matches(label))
                    })
                    .map(|project| {
                        let project = project.clone();
                        let name = format!("{}/{}", project.owner, project.name);
                        let selected = tab == TAB_PROJECT
                            && selected_project
                                .as_ref()
                                .is_some_and(|p| p.id == project.id);
                        let target = project.clone();
                        v_flex()
                            .gap_1()
                            .child(
                                Button::new(SharedString::from(format!(
                                    "settings-project-{}",
                                    project.id
                                )))
                                .ghost()
                                .icon(IconName::FolderGit2)
                                .accessibility_label(name.clone())
                                .child(div().w_full().text_left().truncate().child(name.clone()))
                                .selected(selected)
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.form.update(cx, |form, cx| {
                                            form.show_project(target.clone(), 0, window, cx)
                                        });
                                    },
                                )),
                            )
                            .children(selected.then(|| {
                                v_flex()
                                    .ml_4()
                                    .pl_2()
                                    .gap_1()
                                    .border_l_1()
                                    .border_color(color(Token::Border, cx))
                                    .children(
                                        PROJECT_PAGES
                                            .iter()
                                            .enumerate()
                                            .filter(|(_, (label, _))| {
                                                matches(label) || matches(&name)
                                            })
                                            .map(|(ix, (label, _))| {
                                                let target = project.clone();
                                                Button::new(SharedString::from(format!(
                                                    "project-settings-nav-{}-{ix}",
                                                    project.id
                                                )))
                                                .ghost()
                                                .accessibility_label(*label)
                                                .child(div().w_full().text_left().child(*label))
                                                .selected(section == ix)
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.form.update(cx, |form, cx| {
                                                            form.show_project(
                                                                target.clone(),
                                                                ix,
                                                                window,
                                                                cx,
                                                            )
                                                        });
                                                    },
                                                ))
                                            }),
                                    )
                            }))
                    }),
            );
        let title = if tab == TAB_PROJECT {
            PROJECT_PAGES[section].0
        } else {
            TABS[tab]
        };
        v_flex()
            .key_context(crate::keymap::SETTINGS)
            .track_focus(&self.focus)
            .on_action(cx.listener(|_, _: &crate::actions::BackFromSettings, _, cx| close(cx)))
            .size_full()
            .child(
                h_flex().size_full().items_start().child(sidebar).child(
                    v_flex()
                        .flex_1()
                        .h_full()
                        .min_w_0()
                        .min_h_0()
                        .px_8()
                        .py_8()
                        .child(
                            v_flex()
                                .w_full()
                                .max_w(px(896.))
                                .h_full()
                                .min_h_0()
                                .gap_6()
                                .child(
                                    v_flex()
                                        .gap_2()
                                        .children(
                                            (tab == TAB_PROJECT)
                                                .then(|| {
                                                    selected_project.as_ref().map(|p| {
                                                        div().text_sm().text_color(muted).child(
                                                            format!("{}/{}", p.owner, p.name),
                                                        )
                                                    })
                                                })
                                                .flatten(),
                                        )
                                        .child(
                                            div()
                                                .text_2xl()
                                                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                                .child(title),
                                        )
                                        .child(div().text_sm().text_color(muted).child(
                                            match tab {
                                                TAB_LOGINS => "Manage agent logins and API keys.",
                                                TAB_MODELS => super::models_page::DESCRIPTION,
                                                TAB_GENERAL => {
                                                    "Notifications and sound for this Mac."
                                                }
                                                TAB_SHELL => super::shell_model::DESCRIPTION,
                                                TAB_PROJECT => {
                                                    "Configure this project and its workspaces."
                                                }
                                                TAB_ENVIRONMENTS => {
                                                    "Manage shared project environments."
                                                }
                                                TAB_MCP => "Manage MCP servers for your agents.",
                                                TAB_AGENTS => "Manage agents and their defaults.",
                                                TAB_APPEARANCE => {
                                                    "Set your theme and transcript detail."
                                                }
                                                _ => "Keyboard shortcuts for Tempo.",
                                            },
                                        )),
                                )
                                .child(div().flex_1().min_h_0().child(body)),
                        ),
                ),
            )
    }
}

/// Shows the existing Settings page, preserving its selected section.
pub fn open(cx: &mut App) {
    show(None, cx);
}

pub fn open_logins(cx: &mut App) {
    show(Some(TAB_LOGINS), cx);
}

pub fn open_agents(cx: &mut App) {
    show(Some(TAB_AGENTS), cx);
}

pub fn close(cx: &mut App) {
    if let Some(app) = crate::app::AppState::try_global(cx) {
        app.update(cx, |a, cx| {
            a.settings_open = false;
            cx.notify();
        });
    }
}

fn show(tab: Option<usize>, cx: &mut App) {
    cx.defer(move |cx| {
        if crate::app::ensure_main_window(cx).is_err() {
            return;
        }
        let Some(app) = crate::app::AppState::try_global(cx) else {
            return;
        };
        if let Some(handle) = app.read(cx).main_window {
            let _ = handle.update(cx, |_, window, cx| {
                if let Ok(view) = Root::read(window, cx)
                    .view()
                    .clone()
                    .downcast::<super::main_window::MainWindow>()
                {
                    view.update(cx, |view, cx| view.show_settings(tab, window, cx));
                }
            });
        }
    });
}
