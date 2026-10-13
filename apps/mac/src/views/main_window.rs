//! The main window (04, Layout; 07, Window layout): `Root` (from `gpui_kit::open_window`) with a
//! `TitleBar`, then `Resizable` panes: sidebar | center | right side, the right side split into
//! one full-height tool area with review, process and document tabs.
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
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window,
    WindowBounds, WindowOptions, div, px, size,
};

/// 07: minimum window size, and the width below which the right side collapses behind its toggle.
pub const MIN_SIZE: (f32, f32) = (900., 600.);
pub const RIGHT_COLLAPSE_WIDTH: f32 = 1100.;

pub const REVIEW_TABS: [&str; 4] = ["Changes", "All files", "Checks", "Artifacts"];
pub const PROCESS_TABS: [&str; 3] = ["Setup", "Run", "Terminal"];

/// Below the collapse width the right side keeps its own toggle state, closed by default.
pub fn right_side_visible(width: f32, open: bool, open_when_narrow: bool) -> bool {
    if width < RIGHT_COLLAPSE_WIDTH {
        open_when_narrow
    } else {
        open
    }
}

/// A workspace's right side shows when the layout has it open and the workspace is not quiet
/// (sleeping, or no changes and no PR), unless the user opened it this app session (04).
pub fn right_side_open(layout_open: bool, starts_closed: bool, opened: bool) -> bool {
    layout_open && (!starts_closed || opened)
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
    settings: Option<Entity<super::settings::SettingsView>>,
    settings_active: bool,
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
    /// An action for the shown workspace that arrived before its view existed.
    pending_action: Option<Box<dyn gpui_kit::Action>>,
    live_subscriptions: Vec<(gpui_kit::EntityId, Subscription)>,
}

impl MainWindow {
    pub fn new(content: MainWindowContent, window: &mut Window, cx: &mut Context<Self>) -> Self {
        window.set_window_title(crate::APP_NAME);
        let (top_bar, tabs, rows) = match content.workspace {
            Some(w) => (Some(w.top_bar), w.tabs, w.rows),
            None => (None, Vec::new(), Vec::new()),
        };
        super::tokens::install(cx);
        match cx.global::<crate::storage::Local>().config().theme {
            crate::storage::Theme::System => Theme::sync_system_appearance(Some(window), cx),
            crate::storage::Theme::Light => {
                Theme::change(gpui_kit::component::ThemeMode::Light, Some(window), cx)
            }
            crate::storage::Theme::Dark => {
                Theme::change(gpui_kit::component::ThemeMode::Dark, Some(window), cx)
            }
        }
        Theme::update(cx, |theme| theme.font_size = px(13.));
        let appearance = cx.observe_window_appearance(window, |_, window, cx| {
            if cx.global::<crate::storage::Local>().config().theme == crate::storage::Theme::System
            {
                Theme::sync_system_appearance(Some(window), cx);
                Theme::update(cx, |theme| theme.font_size = px(13.));
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
                    this.settings = None;
                    window.close_all_dialogs(cx);
                    this.dialogs.update(cx, |d, cx| {
                        d.kind = None;
                        cx.notify();
                    });
                }
                let settings_open = state.read(cx).settings_open;
                if this.settings_active && !settings_open {
                    window.focus(&this.focus, cx);
                }
                this.settings_active = settings_open;
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
            settings: None,
            settings_active: false,
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
            pending_action: None,
            live_subscriptions: Vec::new(),
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

    pub(crate) fn show_settings(
        &mut self,
        tab: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let settings = self
            .settings
            .get_or_insert_with(|| cx.new(|cx| super::settings::SettingsView::new(window, cx)));
        if let Some(tab) = tab {
            settings
                .read(cx)
                .form
                .clone()
                .update(cx, |form, cx| form.show_tab(tab, cx));
        }
        let focus = settings.read(cx).focus.clone();
        window.focus(&focus, cx);
        crate::app::AppState::global(cx).update(cx, |app, cx| {
            app.settings_open = true;
            cx.notify();
        });
        cx.notify();
    }

    pub fn transcript(&self) -> &Entity<TranscriptView> {
        &self.transcript
    }

    pub fn composer(&self) -> &Entity<Composer> {
        &self.composer
    }

    fn show(id: Option<String>, cx: &mut Context<Self>) {
        if let Some(id) = id {
            crate::app::AppState::global(cx).update(cx, |a, cx| {
                a.show_workspace(&id, cx);
            });
        }
    }
    fn current(cx: &App) -> Option<String> {
        crate::app::AppState::try_global(cx)?
            .read(cx)
            .active_workspace
            .clone()
    }
    /// ⌘1–⌘9 and ⌘⌥↓/⌘⌥↑ follow the rows the sidebar shows.
    fn switch_workspace(&mut self, forward: bool, position: Option<usize>, cx: &mut Context<Self>) {
        let ids: Vec<String> = sidebar::order(cx)
            .visible
            .into_iter()
            .map(|w| w.id)
            .collect();
        let next = match position {
            Some(n) => n.checked_sub(1).and_then(|ix| ids.get(ix).cloned()),
            None => sidebar::step_workspace(&ids, Self::current(cx).as_deref(), forward),
        };
        Self::show(next, cx);
    }
    fn next_attention(&mut self, cx: &mut Context<Self>) {
        let order = sidebar::order(cx);
        let next = sidebar::next_needing_you(&order.all, Self::current(cx).as_deref());
        Self::show(next, cx);
    }

    fn route<A: gpui_kit::Action>(
        &mut self,
        action: &A,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.run_on_workspace(action.boxed_clone(), window, cx);
    }
    fn run_on_workspace(
        &mut self,
        action: Box<dyn gpui_kit::Action>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(
            action.name(),
            "tempo::OpenFile" | "tempo::SearchFiles" | "tempo::ViewChecks"
        ) {
            self.panes.right = true;
            self.panes.right_when_narrow = true;
            cx.notify();
        }
        match self.live_active(cx) {
            Some(view) => Self::apply(&view, action.as_ref(), window, cx),
            None if Self::current(cx).is_some()
                && crate::app::AppState::try_global(cx)
                    .is_some_and(|a| a.read(cx).client().is_some()) =>
            {
                self.pending_action = Some(action);
                cx.notify();
            }
            None => {}
        }
    }
    fn apply(
        view: &Entity<super::workspace::WorkspaceView>,
        action: &dyn gpui_kit::Action,
        window: &mut Window,
        cx: &mut App,
    ) {
        if action.name() == "tempo::ViewChecks" {
            let review = view.read(cx).review.clone();
            review.update(cx, |r, cx| r.show_checks(cx));
            view.update(cx, |view, cx| view.reveal_right(cx));
        } else {
            view.update(cx, |view, cx| view.handle_action(action, window, cx));
        }
    }
    fn layout_right(&self) -> bool {
        if self.narrow {
            self.panes.right_when_narrow
        } else {
            self.panes.right
        }
    }

    fn right_visible(&self, cx: &App) -> bool {
        match self.live_active(cx) {
            Some(view) => {
                let view = view.read(cx);
                right_side_open(
                    self.layout_right(),
                    view.right_starts_closed(cx),
                    view.right_opened,
                )
            }
            None => self.layout_right(),
        }
    }

    fn open_right(&mut self, cx: &mut Context<Self>) {
        self.panes.right = true;
        self.panes.right_when_narrow = true;
        if let Some(view) = self.live_active(cx) {
            view.update(cx, |v, _| v.right_opened = true);
        }
        cx.notify();
    }

    fn toggle_right(&mut self, cx: &mut Context<Self>) {
        if !self.right_visible(cx) {
            return self.open_right(cx);
        }
        if self.narrow {
            self.panes.right_when_narrow = false;
        } else {
            self.panes.right = false;
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
            let live: Vec<_> = self.live_workspaces.iter().map(|v| v.entity_id()).collect();
            self.live_subscriptions.retain(|(id, _)| live.contains(id));
            if let Some(active) = app.read(cx).active_workspace.clone() {
                if let Some(view) = self
                    .live_workspaces
                    .iter()
                    .find(|v| v.read(cx).store.read(cx).workspace_id == active)
                    .cloned()
                {
                    if let Some(action) = self.pending_action.take() {
                        Self::apply(&view, action.as_ref(), window, cx);
                    }
                    return div().size_full().child(view).into_any_element();
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
                    let reveal =
                        cx.subscribe(&view, |this, _, _: &super::workspace::RevealRight, cx| {
                            this.panes.right = true;
                            this.panes.right_when_narrow = true;
                            cx.notify();
                        });
                    self.live_subscriptions.push((view.entity_id(), reveal));
                    self.live_workspaces.push(view.clone());
                    if let Some(action) = self.pending_action.take() {
                        Self::apply(&view, action.as_ref(), window, cx);
                    }
                    return div().size_full().child(view).into_any_element();
                }
            }
            return self.render_welcome(cx);
        }

        let Some(top_bar) = self.top_bar.clone() else {
            return self.render_welcome(cx);
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

    fn render_welcome(&self, cx: &App) -> AnyElement {
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child("Your work, in one place"),
            )
            .child(
                div()
                    .text_color(color(Token::MutedForeground, cx))
                    .child("Select a workspace, or start a new one."),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("welcome-new-workspace")
                            .label("New workspace")
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(NewWorkspace), cx)
                            }),
                    )
                    .child(
                        Button::new("welcome-add-project")
                            .label("Add project")
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(AddProject), cx)
                            }),
                    ),
            )
            .into_any_element()
    }

    fn hide_browser_views(&self, except: Option<gpui_kit::EntityId>, cx: &gpui_kit::App) {
        for view in &self.live_workspaces {
            if Some(view.entity_id()) != except {
                view.read(cx).tools.read(cx).hide_browser();
            }
        }
    }

    fn render_right(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let visible = self.right_visible(cx);
        let active = self.live_active(cx).map(|view| view.entity_id());
        self.hide_browser_views(if visible { active } else { None }, cx);
        if crate::app::AppState::try_global(cx).is_some() && self.live_active(cx).is_none() {
            return div().p_4().child("Select a workspace.").into_any_element();
        }
        if let Some(view) = self.live_active(cx) {
            return div()
                .size_full()
                .child(view.read(cx).tools.clone())
                .into_any_element();
        }
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
            .child(super::skeleton_rows(4));
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
            .child(super::skeleton_rows(4));
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
            self.hide_browser_views(None, cx);
            self.live_workspaces.clear();
            return v_flex()
                .size_full()
                .bg(color(Token::Background, cx))
                .text_color(color(Token::Foreground, cx))
                .child(TitleBar::new().child(crate::APP_NAME))
                .child(div().flex_1().child(sign_in.clone()))
                .into_any_element();
        }
        if crate::app::AppState::try_global(cx).is_some_and(|a| a.read(cx).settings_open)
            && let Some(settings) = self.settings.clone()
        {
            self.hide_browser_views(None, cx);
            return v_flex()
                .size_full()
                .bg(color(Token::Background, cx))
                .text_color(color(Token::Foreground, cx))
                .on_action(cx.listener(|this, _: &CommandPalette, window, cx| {
                    super::palette::open(this.focus.clone(), window, cx)
                }))
                .child(TitleBar::new().child(crate::APP_NAME))
                .child(div().flex_1().min_h_0().child(settings))
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
        let show_right = right_side_visible(width, self.panes.right, self.panes.right_when_narrow)
            && self.right_visible(cx);
        let sidebar = if let Some(app_state) = crate::app::AppState::try_global(cx) {
            let hub = app_state.read(cx).hub.read(cx);
            if hub.project_error {
                sidebar::shell(
                    div()
                        .p_4()
                        .child("Could not load projects. Sign out and connect again."),
                    cx,
                )
            } else if !hub.state.ready || !hub.projects_ready {
                sidebar::shell(super::skeleton_rows(6), cx)
            } else {
                WorkspaceSidebar::from_hub(cx)
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
        let reconnecting = crate::app::AppState::try_global(cx).is_some_and(|app| {
            let app = app.read(cx);
            let workspace = app.active_workspace.as_ref().and_then(|id| {
                app.workspaces
                    .iter()
                    .find(|w| &w.read(cx).workspace_id == id)
                    .map(|w| w.read(cx).connection)
            });
            crate::stores::shows_hub_bar(
                app.hub.read(cx).connection,
                workspace,
                std::time::Instant::now(),
            )
        });

        v_flex()
            .size_full()
            .text_size(px(13.))
            .key_context(WORKSPACE)
            .track_focus(&self.focus)
            .bg(color(Token::Background, cx))
            .text_color(color(Token::Foreground, cx))
            .on_action(|_: &OpenSettings, _, cx| super::settings::open(cx))
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
                super::palette::open(this.focus.clone(), window, cx)
            }))
            .on_action(cx.listener(Self::route::<ViewChecks>))
            .on_action(
                cx.listener(|this, _: &NextWorkspace, _, cx| this.switch_workspace(true, None, cx)),
            )
            .on_action(cx.listener(|this, _: &PreviousWorkspace, _, cx| {
                this.switch_workspace(false, None, cx)
            }))
            .on_action(cx.listener(|this, action: &SwitchToWorkspace, _, cx| {
                this.switch_workspace(true, Some(action.0), cx)
            }))
            .on_action(
                cx.listener(|this, _: &NextWorkspaceNeedingYou, _, cx| this.next_attention(cx)),
            )
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| {
                this.panes.sidebar = !this.panes.sidebar;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleRightSide, _, cx| this.toggle_right(cx)))
            .on_action(cx.listener(|this, _: &ToggleBottomPanel, _, cx| {
                if let Some(view) = this.live_active(cx) {
                    let tools = view.read(cx).tools.clone();
                    tools.update(cx, |tools, cx| tools.toggle_terminal(cx));
                }
                this.open_right(cx);
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
            .children(reconnecting.then(|| {
                div()
                    .id("reconnecting-bar")
                    .role(gpui_kit::Role::Status)
                    .aria_label("Reconnecting…")
                    .h(px(20.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_b_1()
                    .border_color(color(Token::Border, cx))
                    .bg(color(Token::Warning, cx).opacity(0.15))
                    .text_xs()
                    .child("Reconnecting…")
                    .test_support()
            }))
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
                                .size(px(pane_sizes
                                    .right
                                    .unwrap_or((width - 280.) / 2.)
                                    .clamp(300., (width - 600.).max(300.))))
                                .size_range(px(300.)..px(600.))
                                .visible(show_right)
                                .child(div().size_full().bg(color(Token::Panel, cx)).child(right)),
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
    fn right_side_starts_closed_until_opened() {
        assert!(right_side_open(true, false, false));
        assert!(!right_side_open(true, true, false));
        assert!(right_side_open(true, true, true));
        assert!(!right_side_open(false, false, true));
    }

    #[test]
    fn right_side_collapses_below_1100() {
        assert!(right_side_visible(1280., true, false));
        assert!(!right_side_visible(1280., false, true));
        assert!(!right_side_visible(1099., true, false));
        assert!(right_side_visible(1099., true, true));
    }
}

#[cfg(test)]
mod view_tests {
    use super::*;
    use gpui_kit::TestAppContext;
    use gpui_kit::test::TestWindowExt as _;
    use tempo_protocol as p;

    fn summary(id: &str, project: &str, activity: f64, attention: &str) -> p::WorkspaceSummary {
        serde_json::from_value(serde_json::json!({
            "id": id, "projectId": project, "title": format!("Title {id}"), "slug": id,
            "branch": format!("tempo/{id}"), "baseBranch": "main", "state": "ready",
            "attention": attention, "defaultAgent": "claude", "pinned": false,
            "prNumber": null, "prState": null, "checksState": null,
            "createdAt": 1.0, "lastActivityAt": activity, "archivedAt": null, "rev": 1.0
        }))
        .unwrap()
    }

    fn project(id: &str, order: f64) -> p::Project {
        serde_json::from_value(serde_json::json!({
            "id": id, "installationId": 1, "repoId": order, "owner": "acme", "name": id,
            "defaultBranch": "main", "settings": {}, "sortOrder": order
        }))
        .unwrap()
    }

    fn setup(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<crate::app::AppState>) {
        cx.background_executor.allow_parking();
        cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_global(crate::storage::Local::load(None));
            crate::keymap::bind(cx);
            let runtime = crate::client::ClientRuntime::start().unwrap();
            let state = cx.new(|cx| crate::app::AppState::new(runtime, cx));
            crate::app::set_global_for_test(state.clone(), cx);
            state.update(cx, |s, cx| {
                s.auth = crate::app::AuthState::SignedIn;
                s.hub.update(cx, |hub, _| {
                    hub.projects = vec![project("a", 0.), project("b", 1.), project("c", 2.)];
                    hub.projects_ready = true;
                    hub.state.ready = true;
                    let mut a1 = summary("a1", "a", 3., "unread");
                    a1.pr_number = Some(12.);
                    a1.pr_state = Some(p::PrState::Merged);
                    a1.checks_state = Some(p::ChecksState::Failure);
                    a1.created_at = 9.;
                    for w in [
                        a1,
                        summary("a2", "a", 5., "none"),
                        summary("b1", "b", 1., "needs_input"),
                    ] {
                        hub.state.workspaces.insert(w.id.clone(), w);
                    }
                });
            });
            let (handle, view) = open(Default::default(), cx).unwrap();
            state.update(cx, |s, _| s.main_window = Some(handle));
            let focus = view.read(cx).focus.clone();
            handle
                .update(cx, |_, window, cx| window.focus(&focus, cx))
                .unwrap();
            (handle, state)
        })
    }

    fn active(cx: &mut TestAppContext, state: &Entity<crate::app::AppState>) -> Option<String> {
        state.read_with(cx, |s, _| s.active_workspace.clone())
    }

    fn act(cx: &mut TestAppContext, handle: AnyWindowHandle, action: impl gpui_kit::Action) {
        cx.update_window(handle, |_, window, cx| {
            window.dispatch_action(Box::new(action), cx)
        })
        .unwrap();
        cx.run_until_parked();
    }

    #[gpui_kit::test]
    fn sidebar_settings_returns_to_the_same_workspace(cx: &mut TestAppContext) {
        let (handle, state) = setup(cx);
        let view = cx
            .update_window(handle, |_, window, cx| {
                let view = gpui_kit::base::Root::read(window, cx)
                    .view()
                    .clone()
                    .downcast::<MainWindow>()
                    .unwrap();
                view.update(cx, |view, cx| {
                    view.review_tab = 2;
                    view.composer.update(cx, |composer, cx| {
                        composer.set_text("Unsent draft", window, cx)
                    });
                });
                window.render_frame(cx);
                window.click("sidebar-settings", cx);
                view
            })
            .unwrap();
        cx.run_until_parked();
        assert!(state.read_with(cx, |state, _| state.settings_open));
        assert_eq!(
            state.read_with(cx, |s, _| s.main_window.unwrap().window_id()),
            handle.window_id()
        );
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.dispatch_action(Box::new(ToggleRightSide), cx);
            window.click("settings-back", cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert!(!state.read_with(cx, |state, _| state.settings_open));
        view.read_with(cx, |view, cx| {
            assert_eq!(view.review_tab, 2);
            assert_eq!(view.composer.read(cx).text(cx), "Unsent draft");
            assert!(view.panes.right);
        });
        cx.update(super::super::settings::open_logins);
        cx.run_until_parked();
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.settings.as_ref().unwrap().read(cx).form.read(cx).tab,
                super::super::settings_form::TAB_LOGINS
            )
        });
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
        act(cx, handle, BackFromSettings);
        assert!(!state.read_with(cx, |state, _| state.settings_open));
        cx.update(super::super::settings::open);
        cx.run_until_parked();
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.settings.as_ref().unwrap().read(cx).form.read(cx).tab,
                super::super::settings_form::TAB_LOGINS
            )
        });
    }

    #[gpui_kit::test]
    fn settings_navigation_selects_each_named_project(cx: &mut TestAppContext) {
        let (handle, _) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.click("sidebar-settings", cx);
        })
        .unwrap();
        cx.run_until_parked();
        let view = cx
            .update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                for id in [
                    "settings-project-a",
                    "settings-project-b",
                    "settings-project-c",
                ] {
                    assert!(window.try_find(id).is_some());
                }
                window.click("settings-project-b", cx);
                gpui_kit::base::Root::read(window, cx)
                    .view()
                    .clone()
                    .downcast::<MainWindow>()
                    .unwrap()
            })
            .unwrap();
        cx.run_until_parked();
        view.read_with(cx, |v, cx| {
            assert_eq!(
                v.settings
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .form
                    .read(cx)
                    .selected_project()
                    .unwrap()
                    .id,
                "b"
            )
        });
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("project-settings-nav-b-0").is_some());
            assert!(window.try_find("project-settings-nav-a-0").is_none());
            window.click("project-settings-nav-b-3", cx);
        })
        .unwrap();
        cx.run_until_parked();
        view.read_with(cx, |v, cx| {
            assert_eq!(
                v.settings.as_ref().unwrap().read(cx).form.read(cx).section,
                3
            )
        });
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.click("settings-project-c", cx);
        })
        .unwrap();
        cx.run_until_parked();
        view.read_with(cx, |v, cx| {
            assert_eq!(
                v.settings
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .form
                    .read(cx)
                    .selected_project()
                    .unwrap()
                    .id,
                "c"
            )
        });
    }

    #[gpui_kit::test]
    fn sidebar_rows_badges_and_order_follow_04(cx: &mut TestAppContext) {
        let (handle, state) = setup(cx);
        cx.read(|cx| assert_eq!(Theme::global(cx).font_size, px(13.)));
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            for (id, label) in [
                ("status-a1", "New activity"),
                ("status-b1", "Waiting for you"),
                ("pr-a1", "PR #12, merged"),
                ("checks-a1", "Checks failed"),
                ("section-c", "acme/c, expanded"),
            ] {
                assert_eq!(window.find(id).label(), Some(label), "{id}");
            }
            for id in [
                "start-in-c",
                "new-in-a",
                "sidebar-sort",
                "history",
                "sidebar-new-workspace",
                "sidebar-search",
                "sidebar-settings",
            ] {
                assert!(window.try_find(id).is_some(), "{id} missing");
            }
            let project = window.find("section-a").bounds();
            let row = window.find("workspace-a1").bounds();
            assert!(
                row.size.height >= px(48.),
                "workspace row is clipped: {row:?}"
            );
            assert!(
                row.origin.y >= project.bottom(),
                "workspace overlaps project header"
            );
            let settings = window.find("sidebar-settings").bounds();
            assert!(
                settings.size.width >= px(70.),
                "Settings must have a visible label"
            );
            assert!(window.try_find("status-a2").is_none());
            assert!(window.try_find("pr-a2").is_none());
            assert!(window.try_find("start-in-a").is_none());
            assert!(window.try_find("reconnecting-bar").is_none());
        })
        .unwrap();

        act(cx, handle, SwitchToWorkspace(1));
        assert_eq!(active(cx, &state).as_deref(), Some("a2"));
        act(cx, handle, NextWorkspace);
        assert_eq!(active(cx, &state).as_deref(), Some("a1"));
        act(cx, handle, NextWorkspaceNeedingYou);
        assert_eq!(active(cx, &state).as_deref(), Some("b1"));

        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.click("section-a", cx);
        })
        .unwrap();
        cx.run_until_parked();
        act(cx, handle, SwitchToWorkspace(1));
        assert_eq!(active(cx, &state).as_deref(), Some("b1"));
        act(cx, handle, PreviousWorkspace);
        assert_eq!(active(cx, &state).as_deref(), Some("b1"));

        cx.update(|cx| {
            cx.global_mut::<crate::storage::Local>()
                .update_state(|s| s.sort = crate::storage::SortMode::Created)
        });
        state.update(cx, |s, _| {
            s.collapsed_sections.clear();
        });
        act(cx, handle, SwitchToWorkspace(1));
        assert_eq!(active(cx, &state).as_deref(), Some("a1"));
        cx.update(|cx| {
            cx.global_mut::<crate::storage::Local>()
                .update_state(|s| s.sort = crate::storage::SortMode::Activity)
        });
    }

    #[gpui_kit::test]
    fn hub_socket_down_shows_the_reconnecting_bar_without_a_workspace(cx: &mut TestAppContext) {
        let (handle, state) = setup(cx);
        state.update(cx, |s, cx| {
            s.hub.update(cx, |hub, _| {
                hub.connection = crate::stores::Connection::Down(
                    std::time::Instant::now() - std::time::Duration::from_secs(3),
                )
            })
        });
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("reconnecting-bar").is_some());
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn palette_filters_and_enter_opens_the_workspace(cx: &mut TestAppContext) {
        let (handle, state) = setup(cx);
        act(cx, handle, SwitchToWorkspace(1));
        assert_eq!(active(cx, &state).as_deref(), Some("a2"));
        act(cx, handle, CommandPalette);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.input("tempo/b1", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(active(cx, &state).as_deref(), Some("b1"));

        act(cx, handle, CommandPalette);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.input("Toggle side", cx);
        })
        .unwrap();
        cx.run_until_parked();
        let before = cx.read(|cx| cx.global::<crate::storage::Local>().state().panels.sidebar);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.press("down", cx);
            window.press("up", cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
        let after = cx.read(|cx| cx.global::<crate::storage::Local>().state().panels.sidebar);
        assert_ne!(before, after);
    }

    #[gpui_kit::test]
    fn hover_card_shows_state_activity_and_actions(cx: &mut TestAppContext) {
        let (handle, _) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.hover("status-a1", cx);
        })
        .unwrap();
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(500));
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("hover-power-a1").is_some());
            assert!(window.try_find("hover-archive-a1").is_some());
            assert_eq!(window.find("hover-pr-a1").label(), Some("PR #12, merged"));
        })
        .unwrap();
    }
}
