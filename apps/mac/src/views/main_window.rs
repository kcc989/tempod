//! The main window (04, Layout; 07, Window layout): `Root` (from `gpui_kit::open_window`) with a
//! `TitleBar`, then `Resizable` panes: sidebar | center | right side, the right side split into
//! review (Changes, All files, Checks) over processes (Setup, Run, Terminal).
use super::chat::{TranscriptRow, TranscriptView};
use super::composer::Composer;
use super::sidebar::{self, SidebarSection, WorkspaceSidebar};
use super::tokens::{Token, color};
use super::top_bar::TopBar;
use crate::actions::*;
use crate::keymap::WORKSPACE;
use gpui_kit::component::button::Button;
use gpui_kit::component::resizable::{h_resizable, resizable_panel, v_resizable};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Disableable as _, Theme, TitleBar, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Window, WindowBounds, WindowOptions, div, px, size,
};

/// 07: minimum window size, and the width below which the right side collapses behind its toggle.
pub const MIN_SIZE: (f32, f32) = (900., 600.);
pub const RIGHT_COLLAPSE_WIDTH: f32 = 1100.;

pub const REVIEW_TABS: [&str; 3] = ["Changes", "All files", "Checks"];
pub const PROCESS_TABS: [&str; 3] = ["Setup", "Run", "Terminal"];

/// Below the collapse width the right side keeps its own toggle state, closed by default.
pub fn right_side_visible(width: f32, open: bool, open_when_narrow: bool) -> bool {
    if width < RIGHT_COLLAPSE_WIDTH {
        open_when_narrow
    } else {
        open
    }
}

pub struct WorkspaceContent {
    pub top_bar: TopBar,
    pub tabs: Vec<SharedString>,
    pub rows: Vec<TranscriptRow>,
}

#[derive(Default)]
pub struct MainWindowContent {
    pub sections: Vec<SidebarSection>,
    pub active: Option<SharedString>,
    pub workspace: Option<WorkspaceContent>,
}

struct Panes {
    sidebar: bool,
    right: bool,
    right_when_narrow: bool,
    bottom: bool,
}

pub struct MainWindow {
    focus: FocusHandle,
    dialogs: Entity<super::dialogs::Dialogs>,
    _bounds: Subscription,
    panes: Panes,
    narrow: bool,
    center_tab: usize,
    review_tab: usize,
    process_tab: usize,
    top_bar: Option<TopBar>,
    tabs: Vec<SharedString>,
    transcript: Entity<TranscriptView>,
    composer: Entity<Composer>,
    _appearance: Subscription,
    _activation: Subscription,
    _app_state: Option<Subscription>,
    signed_in: bool,
    sign_in: Option<Entity<super::sign_in::SignInView>>,
    _hub: Option<Subscription>,
    sections: Vec<SidebarSection>,
    active: Option<SharedString>,
    live_workspaces: Vec<Entity<super::workspace::WorkspaceView>>,
}

impl MainWindow {
    pub fn new(content: MainWindowContent, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (top_bar, tabs, rows) = match content.workspace {
            Some(w) => (Some(w.top_bar), w.tabs, w.rows),
            None => (None, Vec::new(), Vec::new()),
        };
        match cx.global::<crate::storage::Local>().config().theme {
            crate::storage::Theme::System => Theme::sync_system_appearance(Some(window), cx),
            crate::storage::Theme::Light => {
                Theme::change(gpui_kit::component::ThemeMode::Light, Some(window), cx)
            }
            crate::storage::Theme::Dark => {
                Theme::change(gpui_kit::component::ThemeMode::Dark, Some(window), cx)
            }
        }
        let appearance = cx.observe_window_appearance(window, |_, window, cx| {
            if cx.global::<crate::storage::Local>().config().theme == crate::storage::Theme::System
            {
                Theme::sync_system_appearance(Some(window), cx);
            }
        });
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let live_state = crate::app::AppState::try_global(cx);
        let app_state = live_state.as_ref().map(|state| {
            cx.observe_in(state, window, |this, state, window, cx| {
                let signed_in = matches!(state.read(cx).auth, crate::app::AuthState::SignedIn);
                if signed_in && !this.signed_in {
                    window.focus(&this.focus, cx);
                } else if !signed_in {
                    window.close_all_dialogs(cx);
                    this.dialogs.update(cx, |d, cx| {
                        d.kind = None;
                        cx.notify();
                    });
                }
                this.signed_in = signed_in;
                cx.notify();
            })
        });
        let hub_subscription = live_state.as_ref().map(|state| {
            let hub = state.read(cx).hub.clone();
            cx.observe(&hub, |_, _, cx| cx.notify())
        });
        let signed_in = live_state
            .as_ref()
            .is_some_and(|s| matches!(s.read(cx).auth, crate::app::AuthState::SignedIn));
        let sign_in = live_state.map(|_| cx.new(|cx| super::sign_in::SignInView::new(window, cx)));
        let bounds = cx.observe_window_bounds(window, |_, window, cx| {
            if let WindowBounds::Windowed(bounds) = window.window_bounds() {
                cx.global_mut::<crate::storage::Local>().update_state(|s| {
                    s.window = Some(crate::storage::WindowFrame {
                        x: f32::from(bounds.origin.x),
                        y: f32::from(bounds.origin.y),
                        width: f32::from(bounds.size.width),
                        height: f32::from(bounds.size.height),
                    })
                });
            }
        });
        let dialogs = cx.new(|cx| super::dialogs::Dialogs::new(window, cx));
        let activation = cx.observe_window_activation(window, |_, window, cx| {
            if let Some(app) = crate::app::AppState::try_global(cx) {
                app.update(cx, |a, cx| {
                    a.workspace_focused = window.is_window_active();
                    if a.workspace_focused
                        && let (Some(client), Some(id)) = (a.client(), a.active_workspace.clone())
                    {
                        let viewed = client.call::<tempo_protocol::api::MarkViewed>(
                            tempo_protocol::MarkViewedIn { workspace_id: id },
                        );
                        cx.spawn(async move |_, _| {
                            let _ = viewed.await;
                        })
                        .detach();
                    }
                });
            }
        });
        let saved = cx.global::<crate::storage::Local>().state().panels;
        Self {
            signed_in,
            _activation: activation,
            focus,
            dialogs,
            _bounds: bounds,
            panes: Panes {
                sidebar: saved.sidebar,
                right: saved.right,
                right_when_narrow: saved.right_when_narrow,
                bottom: saved.bottom,
            },
            narrow: false,
            center_tab: 0,
            review_tab: 0,
            process_tab: 0,
            sections: content.sections,
            active: content.active,
            live_workspaces: Vec::new(),
            top_bar,
            tabs,
            transcript: cx.new(|cx| TranscriptView::new(rows, cx)),
            composer: cx.new(|cx| Composer::new(window, cx)),
            _appearance: appearance,
            _app_state: app_state,
            sign_in,
            _hub: hub_subscription,
        }
    }

    pub fn transcript(&self) -> &Entity<TranscriptView> {
        &self.transcript
    }

    pub fn composer(&self) -> &Entity<Composer> {
        &self.composer
    }

    fn workspace_ids(&self, cx: &App) -> Vec<String> {
        let Some(app) = crate::app::AppState::try_global(cx) else {
            return vec![];
        };
        let hub = app.read(cx).hub.read(cx);
        tempo_client::state::hub::sidebar_sections(
            &hub.state.workspaces,
            &hub.projects,
            tempo_client::state::hub::SortMode::Activity,
        )
        .into_iter()
        .flat_map(|s| s.workspaces.into_iter().map(|w| w.id))
        .collect()
    }
    fn switch_workspace(&mut self, delta: i32, position: Option<usize>, cx: &mut Context<Self>) {
        let ids = self.workspace_ids(cx);
        if ids.is_empty() {
            return;
        }
        let app = crate::app::AppState::global(cx);
        let current = app
            .read(cx)
            .active_workspace
            .as_ref()
            .and_then(|id| ids.iter().position(|s| s == id))
            .unwrap_or(0);
        let ix = position
            .map(|p| p.saturating_sub(1))
            .unwrap_or_else(|| (current as i32 + delta).rem_euclid(ids.len() as i32) as usize);
        if let Some(id) = ids.get(ix) {
            app.update(cx, |a, cx| {
                a.show_workspace(id, cx);
            });
        }
    }
    fn next_attention(&mut self, cx: &mut Context<Self>) {
        let ids = self.workspace_ids(cx);
        let app = crate::app::AppState::global(cx);
        let hub = app.read(cx).hub.read(cx);
        let current = app
            .read(cx)
            .active_workspace
            .as_ref()
            .and_then(|id| ids.iter().position(|s| s == id))
            .unwrap_or(0);
        let next = (1..=ids.len())
            .map(|n| &ids[(current + n) % ids.len()])
            .find(|id| {
                hub.state.workspaces.get(*id).is_some_and(|w| {
                    matches!(
                        w.attention,
                        tempo_protocol::Attention::NeedsInput
                            | tempo_protocol::Attention::Error
                            | tempo_protocol::Attention::Unread
                    )
                })
            })
            .cloned();
        if let Some(id) = next {
            app.update(cx, |a, cx| {
                a.show_workspace(&id, cx);
            });
        }
    }

    fn route<A: gpui_kit::Action>(
        &mut self,
        action: &A,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if action.name() == "tempo::OpenFile" || action.name() == "tempo::SearchFiles" {
            self.panes.right = true;
            self.panes.right_when_narrow = true;
            cx.notify();
        }
        if let Some(view) = self.live_active(cx) {
            view.update(cx, |view, cx| view.handle_action(action, window, cx));
        }
    }
    fn toggle_right(&mut self, cx: &mut Context<Self>) {
        if self.narrow {
            self.panes.right_when_narrow = !self.panes.right_when_narrow;
        } else {
            self.panes.right = !self.panes.right;
        }
        cx.notify();
    }

    fn live_active(&self, cx: &gpui_kit::App) -> Option<Entity<super::workspace::WorkspaceView>> {
        let id = crate::app::AppState::try_global(cx)?
            .read(cx)
            .active_workspace
            .clone()?;
        self.live_workspaces
            .iter()
            .find(|v| v.read(cx).store.read(cx).workspace_id == id)
            .cloned()
    }

    fn cycle_tab(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(view) = self.live_active(cx) {
            view.update(cx, |view, cx| view.cycle_tab(forward, window, cx));
            return;
        }

        let n = self.tabs.len().max(1);
        self.center_tab = if forward {
            (self.center_tab + 1) % n
        } else {
            (self.center_tab + n - 1) % n
        };
        cx.notify();
    }

    fn render_center(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if let Some(app) = crate::app::AppState::try_global(cx) {
            let cached: Vec<_> = app
                .read(cx)
                .workspaces
                .iter()
                .map(|w| w.read(cx).workspace_id.clone())
                .collect();
            self.live_workspaces
                .retain(|v| cached.contains(&v.read(cx).store.read(cx).workspace_id));
            if let Some(active) = app.read(cx).active_workspace.clone() {
                if let Some(view) = self
                    .live_workspaces
                    .iter()
                    .find(|v| v.read(cx).store.read(cx).workspace_id == active)
                {
                    return div().size_full().child(view.clone()).into_any_element();
                }
                let store = app
                    .read(cx)
                    .workspaces
                    .iter()
                    .find(|w| w.read(cx).workspace_id == active)
                    .cloned();
                if let (Some(store), Some(client)) = (store, app.read(cx).client()) {
                    let view = cx
                        .new(|cx| super::workspace::WorkspaceView::new(store, client, window, cx));
                    self.live_workspaces.push(view.clone());
                    return div().size_full().child(view).into_any_element();
                }
            }
            return div()
                .p_4()
                .child("Select a workspace to continue.")
                .into_any_element();
        }

        let Some(top_bar) = self.top_bar.clone() else {
            return div().size_full().into_any_element();
        };
        v_flex()
            .size_full()
            .child(top_bar)
            .child(
                TabBar::new("center-tabs")
                    .selected_index(self.center_tab)
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.center_tab = *ix;
                        cx.notify();
                    }))
                    .children(self.tabs.iter().map(|t| Tab::new().label(t.clone()))),
            )
            .child(div().flex_1().min_h_0().child(self.transcript.clone()))
            .child(self.composer.clone())
            .into_any_element()
    }

    fn render_right(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if crate::app::AppState::try_global(cx).is_some() && self.live_active(cx).is_none() {
            return div().p_4().child("Select a workspace.").into_any_element();
        }
        if let Some(view) = self.live_active(cx) {
            let view = view.read(cx);
            let bottom = cx.global::<crate::storage::Local>().state().panes.bottom;
            return v_resizable("live-right-side")
                .on_resize(|state, _, cx| {
                    let bottom = state.read(cx).sizes().get(1).map(|s| f32::from(*s));
                    cx.global_mut::<crate::storage::Local>()
                        .update_state(|s| s.panes.bottom = bottom);
                })
                .child(resizable_panel().child(view.review.clone()))
                .child(
                    resizable_panel()
                        .size(px(bottom.unwrap_or(300.)))
                        .visible(self.panes.bottom)
                        .child(view.processes.clone()),
                )
                .into_any_element();
        }
        let live_review: Option<Entity<super::review::ReviewPanel>> = None;
        let review = v_flex()
            .size_full()
            .child(
                TabBar::new("review-tabs")
                    .selected_index(self.review_tab)
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.review_tab = *ix;
                        cx.notify();
                    }))
                    .children(REVIEW_TABS.map(|t| Tab::new().label(t))),
            )
            .child(if let Some(review) = live_review {
                div().size_full().child(review).into_any_element()
            } else {
                match self.review_tab {
                    0 => div().p_3().child("No changes.").into_any_element(),
                    1 => div().p_3().child("No files.").into_any_element(),
                    _ => div().p_3().child("No checks.").into_any_element(),
                }
            });
        let live_processes: Option<Entity<super::processes::ProcessPanel>> = None;
        let processes = v_flex()
            .size_full()
            .child(
                TabBar::new("process-tabs")
                    .selected_index(self.process_tab)
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.process_tab = *ix;
                        cx.notify();
                    }))
                    .children(PROCESS_TABS.map(|t| Tab::new().label(t))),
            )
            .child(if let Some(processes) = live_processes {
                div().size_full().child(processes).into_any_element()
            } else {
                match self.process_tab {
                    0 => div().p_3().child("Setup has not run.").into_any_element(),
                    1 => div()
                        .p_3()
                        .child("No run script is active.")
                        .into_any_element(),
                    _ => div()
                        .p_3()
                        .child("Open a workspace to use the terminal.")
                        .into_any_element(),
                }
            });
        let bottom = cx.global::<crate::storage::Local>().state().panes.bottom;
        v_resizable("right-side")
            .on_resize(|state, _, cx| {
                let bottom = state.read(cx).sizes().get(1).map(|s| f32::from(*s));
                cx.global_mut::<crate::storage::Local>()
                    .update_state(|s| s.panes.bottom = bottom);
            })
            .child(resizable_panel().child(review))
            .child(
                resizable_panel()
                    .visible(self.panes.bottom)
                    .size(px(bottom.unwrap_or(300.)))
                    .child(processes),
            )
            .into_any_element()
    }
}

impl Focusable for MainWindow {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for MainWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(sign_in) = &self.sign_in
            && !matches!(
                crate::app::AppState::global(cx).read(cx).auth,
                crate::app::AuthState::SignedIn
            )
        {
            self.live_workspaces.clear();
            return v_flex()
                .size_full()
                .bg(color(Token::Background, cx))
                .text_color(color(Token::Foreground, cx))
                .child(TitleBar::new().child(crate::APP_NAME))
                .child(div().flex_1().child(sign_in.clone()))
                .into_any_element();
        }
        let panels = crate::storage::Panels {
            sidebar: self.panes.sidebar,
            right: self.panes.right,
            right_when_narrow: self.panes.right_when_narrow,
            bottom: self.panes.bottom,
        };
        cx.global_mut::<crate::storage::Local>()
            .update_state(|s| s.panels = panels);
        let width = f32::from(window.viewport_size().width);
        self.narrow = width < RIGHT_COLLAPSE_WIDTH;
        let pane_sizes = cx.global::<crate::storage::Local>().state().panes;
        let show_right = right_side_visible(width, self.panes.right, self.panes.right_when_narrow);
        let sidebar = if let Some(app_state) = crate::app::AppState::try_global(cx) {
            let hub = app_state.read(cx).hub.read(cx);
            if hub.project_error {
                div()
                    .p_4()
                    .child("Could not load projects. Sign out and connect again.")
                    .into_any_element()
            } else if !hub.state.ready || !hub.projects_ready {
                super::skeleton_rows(6).into_any_element()
            } else {
                let sections = tempo_client::state::hub::sidebar_sections(
                    &hub.state.workspaces,
                    &hub.projects,
                    match cx.global::<crate::storage::Local>().state().sort {
                        crate::storage::SortMode::Created => {
                            tempo_client::state::hub::SortMode::Created
                        }
                        _ => tempo_client::state::hub::SortMode::Activity,
                    },
                );
                let sections = sections
                    .into_iter()
                    .map(|section| SidebarSection {
                        label: if let Some(project_id) = section.project_id {
                            hub.projects
                                .iter()
                                .find(|p| p.id == project_id)
                                .map(|p| format!("{}/{}", p.owner, p.name))
                                .unwrap_or_default()
                                .into()
                        } else {
                            "Pinned".into()
                        },
                        rows: section
                            .workspaces
                            .into_iter()
                            .map(|w| sidebar::SidebarRow {
                                summary: Some(w.clone()),
                                id: w.id.into(),
                                title: w.title.into(),
                                detail: format!("{} · {}", w.branch, w.slug).into(),
                            })
                            .collect(),
                    })
                    .collect();
                WorkspaceSidebar::new(sections)
                    .active(app_state.read(cx).active_workspace.clone().map(Into::into))
                    .on_select(|id, _, cx| {
                        crate::app::AppState::global(cx).update(cx, |state, cx| {
                            state.show_workspace(id, cx);
                        });
                    })
                    .into_any_element()
            }
        } else {
            WorkspaceSidebar::new(self.sections.clone())
                .active(self.active.clone())
                .into_any_element()
        };
        let center = self.render_center(window, cx);
        let right = self.render_right(cx);

        v_flex()
            .size_full()
            .text_size(px(13.))
            .key_context(WORKSPACE)
            .track_focus(&self.focus)
            .bg(color(Token::Background, cx))
            .text_color(color(Token::Foreground, cx))
            .on_action(cx.listener(|this, _: &RenameWorkspace, window, cx| {
                this.dialogs
                    .update(cx, |d, cx| d.show("Rename workspace", window, cx))
            }))
            .on_action(cx.listener(Self::route::<NewChat>))
            .on_action(cx.listener(Self::route::<CloseTab>))
            .on_action(cx.listener(Self::route::<CreatePr>))
            .on_action(cx.listener(Self::route::<Merge>))
            .on_action(cx.listener(Self::route::<Archive>))
            .on_action(cx.listener(Self::route::<CommitAndPush>))
            .on_action(cx.listener(Self::route::<ToggleRun>))
            .on_action(cx.listener(Self::route::<OpenFile>))
            .on_action(cx.listener(Self::route::<SearchFiles>))
            .on_action(cx.listener(Self::route::<ShowDiff>))
            .on_action(cx.listener(Self::route::<ToggleDiffScope>))
            .on_action(cx.listener(Self::route::<NextFile>))
            .on_action(cx.listener(Self::route::<PreviousFile>))
            .on_action(cx.listener(Self::route::<MarkFileViewed>))
            .on_action(cx.listener(Self::route::<AttachFile>))
            .on_action(cx.listener(Self::route::<ModelPicker>))
            .on_action(cx.listener(Self::route::<ExpandAllToolCalls>))
            .on_action(cx.listener(Self::route::<StopTurn>))
            .on_action(cx.listener(|this, _: &AddProject, window, cx| {
                this.dialogs
                    .update(cx, |d, cx| d.show("Add project", window, cx))
            }))
            .on_action(cx.listener(|this, _: &ShowHistory, window, cx| {
                this.dialogs
                    .update(cx, |d, cx| d.show("History", window, cx))
            }))
            .on_action(
                cx.listener(|this, action: &NewWorkspaceForProject, window, cx| {
                    this.dialogs.update(cx, |d, cx| {
                        d.show("New workspace", window, cx);
                        d.select_project(action.0.clone(), window, cx);
                    });
                }),
            )
            .on_action(cx.listener(|this, _: &NewWorkspace, window, cx| {
                this.dialogs
                    .update(cx, |d, cx| d.show("New workspace", window, cx))
            }))
            .on_action(cx.listener(|this, _: &CommandPalette, window, cx| {
                this.dialogs
                    .update(cx, |d, cx| d.show("Command palette", window, cx))
            }))
            .on_action(
                cx.listener(|this, _: &NextWorkspace, _, cx| this.switch_workspace(1, None, cx)),
            )
            .on_action(
                cx.listener(|this, _: &PreviousWorkspace, _, cx| {
                    this.switch_workspace(-1, None, cx)
                }),
            )
            .on_action(cx.listener(|this, action: &SwitchToWorkspace, _, cx| {
                this.switch_workspace(0, Some(action.0), cx)
            }))
            .on_action(
                cx.listener(|this, _: &NextWorkspaceNeedingYou, _, cx| this.next_attention(cx)),
            )
            .children(
                crate::app::AppState::try_global(cx)
                    .and_then(|a| a.read(cx).available_update.clone())
                    .map(|version| {
                        h_flex()
                            .p_2()
                            .gap_2()
                            .child(format!("Tempo {version} is available."))
                            .child(
                                Button::new("download-update")
                                    .label(
                                        if crate::app::AppState::global(cx)
                                            .read(cx)
                                            .downloading_update
                                        {
                                            "Downloading…"
                                        } else {
                                            "Download"
                                        },
                                    )
                                    .disabled(
                                        crate::app::AppState::global(cx)
                                            .read(cx)
                                            .downloading_update,
                                    )
                                    .on_click(|_, window, cx| {
                                        crate::app::AppState::global(cx)
                                            .update(cx, |a, cx| a.download_update(window, cx))
                                    }),
                            )
                    }),
            )
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| {
                this.panes.sidebar = !this.panes.sidebar;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleRightSide, _, cx| this.toggle_right(cx)))
            .on_action(cx.listener(|this, _: &ToggleBottomPanel, _, cx| {
                this.panes.bottom = !this.panes.bottom;
                cx.notify();
            }))
            .on_action(
                cx.listener(|this, _: &NextTab, window, cx| this.cycle_tab(true, window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &PreviousTab, window, cx| this.cycle_tab(false, window, cx)),
            )
            .on_action(cx.listener(|this, _: &FocusComposer, window, cx| {
                if let Some(view) = this.live_active(cx) {
                    view.update(cx, |view, cx| view.focus_composer(window, cx));
                } else {
                    this.composer.update(cx, |c, cx| c.focus(window, cx));
                }
            }))
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .on_action(cx.listener(|this, _: &NewChat, window, cx| {
                if let Some(view) = this.live_active(cx) {
                    view.update(cx, |view, cx| view.open_new_chat(window, cx));
                }
            }))
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| {
                if let Some(view) = this.live_active(cx) {
                    view.update(cx, |view, cx| view.close_active(window, cx));
                }
            }))
            .on_action(cx.listener(|this, _: &ModelPicker, window, cx| {
                if let Some(view) = this.live_active(cx) {
                    view.update(cx, |view, cx| view.focus_model(window, cx));
                }
            }))
            .on_action(cx.listener(|this, _: &ExpandAllToolCalls, _, cx| {
                if let Some(view) = this.live_active(cx) {
                    view.update(cx, |view, cx| view.expand_tools(cx));
                }
            }))
            .on_action(|_: &Zoom, window, _| window.zoom_window())
            .child(TitleBar::new().child(div().text_sm().child(crate::APP_NAME)))
            .child(
                div().flex_1().min_h_0().child(
                    h_resizable("main-panes")
                        .on_resize(|state, _, cx| {
                            let sizes = state.read(cx).sizes();
                            let sidebar = sizes.first().map(|s| f32::from(*s));
                            let right = sizes.get(2).map(|s| f32::from(*s));
                            cx.global_mut::<crate::storage::Local>().update_state(|s| {
                                s.panes.sidebar = sidebar;
                                s.panes.right = right;
                            });
                        })
                        .child(
                            resizable_panel()
                                .size(px(pane_sizes.sidebar.unwrap_or(sidebar::DEFAULT_WIDTH)))
                                .size_range(px(sidebar::MIN_WIDTH)..px(sidebar::MAX_WIDTH))
                                .visible(self.panes.sidebar)
                                .child(sidebar),
                        )
                        .child(resizable_panel().child(center))
                        .child(
                            resizable_panel()
                                .size(px(pane_sizes.right.unwrap_or(380.)))
                                .visible(show_right)
                                .child(right),
                        ),
                ),
            )
            .into_any_element()
    }
}

pub fn window_options(cx: &App) -> WindowOptions {
    let bounds = cx
        .global::<crate::storage::Local>()
        .state()
        .window
        .and_then(|f| f.clamped(MIN_SIZE))
        .map(|f| {
            WindowBounds::Windowed(gpui_kit::Bounds {
                origin: gpui_kit::point(px(f.x), px(f.y)),
                size: size(px(f.width), px(f.height)),
            })
        })
        .unwrap_or_else(|| WindowBounds::centered(size(px(1280.), px(800.)), cx));
    WindowOptions {
        window_bounds: Some(bounds),
        window_min_size: Some(size(px(MIN_SIZE.0), px(MIN_SIZE.1))),
        ..TitleBar::window_options()
    }
}

pub fn open(
    content: MainWindowContent,
    cx: &mut App,
) -> gpui_kit::Result<(AnyWindowHandle, Entity<MainWindow>)> {
    let options = window_options(cx);
    gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| MainWindow::new(content, window, cx))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn right_side_collapses_below_1100() {
        assert!(right_side_visible(1280., true, false));
        assert!(!right_side_visible(1280., false, true));
        assert!(!right_side_visible(1099., true, false));
        assert!(right_side_visible(1099., true, true));
    }
}
