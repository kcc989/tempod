//! The main window (04, Layout; 07, Window layout): `Root` (from `gpui_kit::open_window`) with a
//! `TitleBar`, then `Resizable` panes: sidebar | center | right side, the right side split into
//! review (Changes, All files, Checks) over processes (Setup, Run, Terminal).
use super::changes::ChangesPanel;
use super::chat::{TranscriptRow, TranscriptView};
use super::checks::ChecksPanel;
use super::composer::Composer;
use super::files::FilesPanel;
use super::run::RunPanel;
use super::setup::SetupPanel;
use super::sidebar::{self, SidebarSection, WorkspaceSidebar};
use super::terminal::TerminalPanel;
use super::tokens::{Token, color};
use super::top_bar::TopBar;
use crate::actions::*;
use crate::keymap::WORKSPACE;
use gpui_kit::component::resizable::{h_resizable, resizable_panel, v_resizable};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Theme, TitleBar, v_flex};
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
    _app_state: Option<Subscription>,
    sign_in: Option<Entity<super::sign_in::SignInView>>,
    _hub: Option<Subscription>,
    sections: Vec<SidebarSection>,
    active: Option<SharedString>,
}

impl MainWindow {
    pub fn new(content: MainWindowContent, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (top_bar, tabs, rows) = match content.workspace {
            Some(w) => (Some(w.top_bar), w.tabs, w.rows),
            None => (None, Vec::new(), Vec::new()),
        };
        Theme::sync_system_appearance(Some(window), cx);
        let appearance = cx.observe_window_appearance(window, |_, window, cx| {
            Theme::sync_system_appearance(Some(window), cx);
        });
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let live_state = crate::app::AppState::try_global(cx);
        let app_state = live_state.as_ref().map(|state| {
            cx.observe_in(state, window, |this, state, window, cx| {
                if matches!(state.read(cx).auth, crate::app::AuthState::SignedIn) {
                    window.focus(&this.focus, cx);
                }
                cx.notify();
            })
        });
        let hub_subscription = live_state.as_ref().map(|state| {
            let hub = state.read(cx).hub.clone();
            cx.observe(&hub, |_, _, cx| cx.notify())
        });
        let sign_in = live_state.map(|_| cx.new(|cx| super::sign_in::SignInView::new(window, cx)));
        Self {
            focus,
            panes: Panes {
                sidebar: true,
                right: true,
                right_when_narrow: false,
                bottom: true,
            },
            narrow: false,
            center_tab: 0,
            review_tab: 0,
            process_tab: 0,
            sections: content.sections,
            active: content.active,
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

    fn toggle_right(&mut self, cx: &mut Context<Self>) {
        if self.narrow {
            self.panes.right_when_narrow = !self.panes.right_when_narrow;
        } else {
            self.panes.right = !self.panes.right;
        }
        cx.notify();
    }

    fn cycle_tab(&mut self, forward: bool, cx: &mut Context<Self>) {
        let n = self.tabs.len().max(1);
        self.center_tab = if forward {
            (self.center_tab + 1) % n
        } else {
            (self.center_tab + n - 1) % n
        };
        cx.notify();
    }

    fn render_center(&mut self, cx: &mut Context<Self>) -> AnyElement {
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
            .child(match self.review_tab {
                0 => ChangesPanel.into_any_element(),
                1 => FilesPanel.into_any_element(),
                _ => ChecksPanel.into_any_element(),
            });
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
            .child(match self.process_tab {
                0 => SetupPanel.into_any_element(),
                1 => RunPanel.into_any_element(),
                _ => TerminalPanel.into_any_element(),
            });
        v_resizable("right-side")
            .child(resizable_panel().child(review))
            .child(
                resizable_panel()
                    .visible(self.panes.bottom)
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
            return v_flex()
                .size_full()
                .bg(color(Token::Background, cx))
                .text_color(color(Token::Foreground, cx))
                .child(TitleBar::new().child(crate::APP_NAME))
                .child(div().flex_1().child(sign_in.clone()))
                .into_any_element();
        }
        let width = f32::from(window.viewport_size().width);
        self.narrow = width < RIGHT_COLLAPSE_WIDTH;
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
                                .map(|p| p.name.clone())
                                .unwrap_or_default()
                                .into()
                        } else {
                            "Pinned".into()
                        },
                        rows: section
                            .workspaces
                            .into_iter()
                            .map(|w| sidebar::SidebarRow {
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
        let center = self.render_center(cx);
        let right = self.render_right(cx);

        v_flex()
            .size_full()
            .key_context(WORKSPACE)
            .track_focus(&self.focus)
            .bg(color(Token::Background, cx))
            .text_color(color(Token::Foreground, cx))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| {
                this.panes.sidebar = !this.panes.sidebar;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleRightSide, _, cx| this.toggle_right(cx)))
            .on_action(cx.listener(|this, _: &ToggleBottomPanel, _, cx| {
                this.panes.bottom = !this.panes.bottom;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &NextTab, _, cx| this.cycle_tab(true, cx)))
            .on_action(cx.listener(|this, _: &PreviousTab, _, cx| this.cycle_tab(false, cx)))
            .on_action(cx.listener(|this, _: &FocusComposer, window, cx| {
                this.composer.update(cx, |c, cx| c.focus(window, cx));
            }))
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .on_action(|_: &Zoom, window, _| window.zoom_window())
            .child(TitleBar::new().child(div().text_sm().child(crate::APP_NAME)))
            .child(
                div().flex_1().min_h_0().child(
                    h_resizable("main-panes")
                        .child(
                            resizable_panel()
                                .size(px(sidebar::DEFAULT_WIDTH))
                                .size_range(px(sidebar::MIN_WIDTH)..px(sidebar::MAX_WIDTH))
                                .visible(self.panes.sidebar)
                                .child(sidebar),
                        )
                        .child(resizable_panel().child(center))
                        .child(
                            resizable_panel()
                                .size(px(380.))
                                .visible(show_right)
                                .child(right),
                        ),
                ),
            )
            .into_any_element()
    }
}

pub fn window_options(cx: &App) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::centered(size(px(1280.), px(800.)), cx)),
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
