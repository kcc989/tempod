use super::chat::{TranscriptEvent, TranscriptRow, TranscriptView};
use super::chat_model;
use super::composer::{Composer, ComposerEvent};
use super::indicators::PreviewLink;
use super::tokens::{Token, color};
use crate::actions::*;
use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::popover::Popover;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Disableable as _, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, TestSupportExt as _, Window, div,
};
use std::collections::{HashMap, HashSet};
use tempo_client::Client;
use tempo_protocol::{self as p, api};

struct Chat {
    transcript: Entity<TranscriptView>,
    composer: Entity<Composer>,
    _subscriptions: Vec<Subscription>,
}

#[derive(Clone)]
struct QueuedDrag {
    workspace_id: String,
    turn_id: String,
    text: String,
}

impl Render for QueuedDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().p_2().child(self.text.clone())
    }
}

/// Something showed a right or bottom tab; the main window opens the right side (04, Right and
/// bottom panels).
pub struct RevealRight;

struct QueueEditor {
    turn_id: String,
    input: Entity<TextareaState>,
}

/// The base branch picker (04, Top bar): `listBranches` results for the current search, or none
/// while they load.
struct BranchPicker {
    query: Entity<InputState>,
    branches: Option<Result<Vec<String>, String>>,
    generation: u64,
    _search: Option<Task<()>>,
    _query_changed: Subscription,
}

// Non-interactive geometry for the picker opened from More actions.
#[derive(gpui_kit::IntoElement)]
struct BranchPickerAnchor;
impl gpui_kit::component::Selectable for BranchPickerAnchor {
    fn is_selected(&self) -> bool {
        false
    }
    fn selected(self, _: bool) -> Self {
        self
    }
}
impl gpui_kit::RenderOnce for BranchPickerAnchor {
    fn render(self, _: &mut Window, _: &mut gpui_kit::App) -> impl IntoElement {
        div().w(gpui_kit::px(1.)).h(gpui_kit::px(24.))
    }
}

/// Error toasts with the same code replace each other, as the web's `error:<code>` toast id.
struct ErrorToast;

pub(super) const BROWSER_SESSION_ENDED: &str = "Browser session ended.";

pub struct WorkspaceView {
    pub store: Entity<WorkspaceStore>,
    client: Client,
    pub review: Entity<super::review::ReviewPanel>,
    pub processes: Entity<super::processes::ProcessPanel>,
    pub tools: Entity<super::tools::ToolPanel>,
    _tool_events: Subscription,
    review_comments: Vec<String>,
    _review_events: Subscription,
    _review_changed: Subscription,
    active: Option<String>,
    viewing_closed: Vec<String>,
    chats: HashMap<String, Chat>,
    credentials: Option<p::CredentialStatus>,
    library_agents: Vec<p::AgentSummary>,
    agent_library_rev: u64,
    credentials_rev: u64,
    credential_generation: u64,
    _credentials_changed: Option<Subscription>,
    pending_permissions: HashSet<String>,
    previous_mode: HashMap<String, String>,
    seen_permissions: HashSet<String>,
    window_handle: Option<gpui_kit::AnyWindowHandle>,
    toasted_store_error: Option<String>,
    last_state: Option<p::WorkspaceState>,
    error_details_open: bool,
    banner_pending: bool,
    branch_picker: Option<BranchPicker>,
    queue_editor: Option<QueueEditor>,
    queue_pending: bool,
    branch_editor: Option<Entity<InputState>>,
    branch_subscription: Option<Subscription>,
    branch_pending: bool,
    operation: Option<String>,
    operation_session: Option<String>,
    operation_draft: bool,
    operation_pending: bool,
    operation_window: Option<gpui_kit::AnyWindowHandle>,
    revert_checkpoint: Option<String>,
    revert_seq: Option<f64>,
    operation_title: Entity<InputState>,
    operation_body: Entity<TextareaState>,

    closing: Option<String>,
    close_request: bool,
    close_timeout: Option<Task<()>>,
    new_chat_dialog: Option<Entity<super::dialogs::Dialogs>>,
    detail: chat_model::TranscriptDetail,
    /// Opened explicitly this app session, so it stays open while the workspace is quiet.
    pub right_opened: bool,
    pub chat_inset: f32,
    pub show_window_controls: bool,
    _detail_changed: Subscription,
    _store_changed: Subscription,
}

impl gpui_kit::EventEmitter<RevealRight> for WorkspaceView {}

impl WorkspaceView {
    pub fn new(
        store: Entity<WorkspaceStore>,
        client: Client,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let changed = cx.observe_in(&store, window, |this, _, window, cx| this.sync(window, cx));
        let request = client.call::<api::GetCredentialStatus>(Default::default());
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(status) = request.await {
                let _ = this.update_in(cx, |this, _window, cx| {
                    if this.credential_generation != 0 {
                        return;
                    }
                    this.credentials = Some(status);
                    cx.notify();
                });
            }
        })
        .detach();
        let processes =
            cx.new(|cx| super::processes::ProcessPanel::new(store.clone(), client.clone(), cx));
        let review =
            cx.new(|cx| super::review::ReviewPanel::new(store.clone(), client.clone(), window, cx));
        let tools = cx.new(|cx| {
            super::tools::ToolPanel::new(
                store.clone(),
                client.clone(),
                review.clone(),
                processes.clone(),
                cx,
            )
        });
        let tool_events = cx.subscribe(&tools, |this, _, _: &super::tools::RevealTools, cx| {
            this.reveal_right(cx)
        });
        let review_changed = cx.observe(&review, |_, _, cx| cx.notify());
        let review_events = cx.subscribe_in(
            &review,
            window,
            |this, _, event: &super::review::ReviewEvent, window, cx| {
                if let super::review::ReviewEvent::OpenRun(id) = event {
                    this.open_run_transcript(id, window, cx);
                }
                if let super::review::ReviewEvent::CancelRun(id) = event {
                    this.mutate::<api::CancelRun>(
                        p::CancelRunIn {
                            workspace_id: this.store.read(cx).workspace_id.clone(),
                            run_id: id.clone(),
                        },
                        cx,
                    );
                }
                if let super::review::ReviewEvent::RevertRun(id) = event {
                    this.revert_checkpoint = Some(id.clone());
                    this.revert_seq = None;
                    this.operation("Revert", window, cx);
                }
                if let super::review::ReviewEvent::CommentDeleted(id) = event {
                    this.review_comments.retain(|c| c != id);
                    for chat in this.chats.values() {
                        chat.composer.update(cx, |c, cx| {
                            c.review_count = this.review_comments.len();
                            cx.notify();
                        });
                    }
                }
                if let super::review::ReviewEvent::Comments(ids) = event {
                    this.review_comments = ids.clone();
                    for chat in this.chats.values() {
                        chat.composer.update(cx, |c, cx| {
                            c.review_count = ids.len();
                            cx.notify();
                        });
                    }
                    this.focus_composer(window, cx);
                }
                cx.notify();
            },
        );
        let app = crate::app::AppState::try_global(cx);
        let credentials_rev = app
            .as_ref()
            .map(|a| a.read(cx).credentials_rev)
            .unwrap_or(0);
        let credential_changed = app.map(|app| {
            cx.observe_in(&app, window, |this, app, window, cx| {
                let agents_rev = app.read(cx).agent_library_rev;
                if agents_rev != this.agent_library_rev {
                    this.agent_library_rev = agents_rev;
                    this.load_library_agents(window, cx);
                }
                let app = app.read(cx);
                if app.credentials_rev != this.credentials_rev
                    && matches!(app.auth, crate::app::AuthState::SignedIn)
                {
                    this.credentials_rev = app.credentials_rev;
                    let provider = app.credential_changed;
                    this.refresh_credentials(provider, window, cx);
                }
            })
        });
        let detail_changed =
            cx.observe_global_in::<crate::storage::Local>(window, |this, window, cx| {
                if transcript_detail(cx) != this.detail {
                    this.sync(window, cx);
                }
            });
        let mut view = Self {
            detail: transcript_detail(cx),
            right_opened: false,
            tools,
            _tool_events: tool_events,
            chat_inset: 16.,
            show_window_controls: false,
            _detail_changed: detail_changed,
            processes,
            review,
            review_comments: vec![],
            _review_events: review_events,
            _review_changed: review_changed,
            store,
            client,
            active: None,
            viewing_closed: Vec::new(),
            chats: HashMap::new(),
            credentials: None,
            library_agents: vec![],
            agent_library_rev: 0,
            credentials_rev,
            credential_generation: 0,
            _credentials_changed: credential_changed,
            pending_permissions: HashSet::new(),
            previous_mode: HashMap::new(),
            seen_permissions: HashSet::new(),
            window_handle: Some(window.window_handle()),
            toasted_store_error: None,
            last_state: None,
            error_details_open: false,
            banner_pending: false,
            branch_picker: None,
            queue_editor: None,
            queue_pending: false,
            branch_editor: None,
            branch_subscription: None,
            branch_pending: false,
            operation: None,
            operation_session: None,
            operation_draft: false,
            operation_pending: false,
            operation_window: None,
            revert_checkpoint: None,
            revert_seq: None,
            operation_title: cx.new(|cx| InputState::new(window, cx)),
            operation_body: cx.new(|cx| TextareaState::new(window, cx)),

            closing: None,
            close_request: false,
            close_timeout: None,
            new_chat_dialog: None,
            _store_changed: changed,
        };
        view.sync(window, cx);
        view.load_library_agents(window, cx);
        view
    }

    fn edit_branch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.branch_pending || self.branch_editor.is_some() {
            return;
        }
        let Some(workspace) = self.store.read(cx).state.workspace.as_ref() else {
            return;
        };
        if workspace.pushed
            || !matches!(
                workspace.state,
                p::WorkspaceState::Ready | p::WorkspaceState::Working | p::WorkspaceState::Sleeping
            )
        {
            return;
        }
        let branch = workspace.branch.clone();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(branch));
        self.branch_subscription =
            Some(
                cx.subscribe_in(&input, window, |this, _, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                        this.save_branch(cx);
                    }
                }),
            );
        self.branch_editor = Some(input.clone());
        input.update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    fn save_branch(&mut self, cx: &mut Context<Self>) {
        if self.branch_pending {
            return;
        }
        let Some(input) = self.branch_editor.as_ref() else {
            return;
        };
        let branch = input.read(cx).value().trim().to_string();
        if self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .is_some_and(|workspace| workspace.branch == branch)
        {
            self.branch_editor = None;
            self.branch_subscription = None;
            cx.notify();
            return;
        }
        let Ok(branch) = branch.try_into() else {
            self.toast(
                "BRANCH_INVALID".into(),
                crate::errors::error_message("BRANCH_INVALID", None),
                cx,
            );
            cx.notify();
            return;
        };
        let request = self.client.call::<api::RenameBranch>(p::RenameBranchIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
            branch,
        });
        self.branch_pending = true;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.branch_pending = false;
                match result {
                    Ok(_) => {
                        this.branch_editor = None;
                    }
                    Err(error) => this.toast_error(&error, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn load_library_agents(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let request = self.client.call::<api::ListAgents>(p::Empty {});
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(agents) = request.await {
                let _ = this.update_in(cx, |this, _window, cx| {
                    this.library_agents = agents;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn refresh_credentials(
        &mut self,
        changed: Option<p::CredentialProvider>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.credential_generation += 1;
        let generation = self.credential_generation;
        let request = self
            .client
            .call::<api::GetCredentialStatus>(Default::default());
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(status) = request.await {
                let _ = this.update_in(cx, |this, window, cx| {
                    if generation != this.credential_generation {
                        return;
                    }
                    this.credentials = Some(status);
                    if let Some(provider) = changed {
                        this.store.update(cx, |s, cx| {
                            s.state.credential_invalid.retain(|p| *p != provider);
                            cx.notify();
                        });
                    }
                    this.sync(window, cx);
                });
            }
        })
        .detach();
    }
    pub fn handle_action(
        &mut self,
        action: &dyn gpui_kit::Action,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(
            action.name(),
            "tempo::CommitAndPush"
                | "tempo::ToggleRun"
                | "tempo::OpenFile"
                | "tempo::SearchFiles"
                | "tempo::ShowDiff"
                | "tempo::NextFile"
                | "tempo::PreviousFile"
                | "tempo::ToggleDiffScope"
                | "tempo::ShowChanges"
        ) {
            self.reveal_right(cx);
        }
        match action.name() {
            "tempo::NewChat" => self.open_new_chat(window, cx),
            "tempo::ShowChanges" => self.review.update(cx, |r, cx| r.show_changes(cx)),
            "tempo::CloseTab" => self.close_active(window, cx),
            "tempo::CreatePr" => self.operation("Create PR", window, cx),
            "tempo::Merge" => self.operation("Merge", window, cx),
            "tempo::Archive" => self.archive(cx),
            "tempo::CommitAndPush" => self.review.update(cx, |r, cx| r.request_commit(window, cx)),
            "tempo::ToggleRun" => self.processes.update(cx, |p, cx| p.toggle_default_run(cx)),
            "tempo::OpenFile" | "tempo::SearchFiles" => self.review.update(cx, |r, cx| {
                r.open_picker(cx);
                r.focus_query(window, cx);
            }),
            "tempo::ShowDiff" => self.show_diff(window, cx),
            "tempo::NextFile" => self.review.update(cx, |r, cx| r.navigate(true, window, cx)),
            "tempo::PreviousFile" => self
                .review
                .update(cx, |r, cx| r.navigate(false, window, cx)),
            "tempo::ToggleDiffScope" => self.review.update(cx, |r, cx| r.toggle_scope(window, cx)),
            "tempo::MarkFileViewed" => {
                if let Some(diff) = self.review.read(cx).diff.clone() {
                    diff.update(cx, |d, cx| d.mark_viewed(cx));
                }
            }
            "tempo::AttachFile" => {
                if let Some(chat) = self.active.as_ref().and_then(|id| self.chats.get(id)) {
                    chat.composer
                        .update(cx, |_, cx| cx.emit(ComposerEvent::Attach(vec![])));
                }
            }
            "tempo::ModelPicker" => self.focus_model(window, cx),
            "tempo::ExpandAllToolCalls" => self.expand_tools(cx),
            "tempo::StopTurn" => {
                if let Some(id) = self.active.clone() {
                    self.stop(&id, cx);
                }
            }
            _ => {}
        }
    }
    /// ⌘⇧D (04, Diff tab): focus the open diff tab, else open the first changed file's diff.
    pub fn show_diff(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let review = self.review.read(cx);
        if review.document_open && review.diff.is_some() {
            return;
        }
        let open = review
            .document_tabs()
            .into_iter()
            .rev()
            .find(|(key, _)| key.starts_with("diff:"));
        self.review.update(cx, |r, cx| match open {
            Some((key, _)) => r.select_document(&key, window, cx),
            None => r.navigate(true, window, cx),
        });
        cx.notify();
    }

    fn active_agent(&self, cx: &gpui_kit::App) -> Option<p::AgentId> {
        self.active
            .as_ref()
            .and_then(|id| self.store.read(cx).state.sessions.get(id))
            .map(|s| s.agent)
    }

    /// Error codes the banners on screen show; their toasts are skipped (04, Toasts).
    fn banner_codes(&self, cx: &gpui_kit::App) -> Vec<String> {
        let state = &self.store.read(cx).state;
        let mut codes = state
            .workspace
            .as_ref()
            .map(|w| chat_model::banner_codes(&chat_model::workspace_banners(w)))
            .unwrap_or_default();
        if let Some(agent) = self.active_agent(cx)
            && let Some((code, _)) = chat_model::login_banner(
                agent,
                self.credentials.as_ref(),
                &state.credential_invalid,
            )
        {
            codes.push(code.into());
        }
        codes
    }

    /// 04, Toasts: a failed server function shows its UI message, unless a banner shows its code.
    /// A 401 shows Connect to Tempo instead (07).
    fn toast_error(&mut self, error: &tempo_client::ApiError, cx: &mut Context<Self>) {
        if error.is_unauthorized() {
            return;
        }
        let code = error
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "INTERNAL".into());
        if self.banner_codes(cx).contains(&code) {
            return;
        }
        let message = api_error_message(error, self.active_agent(cx));
        self.toast(code, message, cx);
    }

    fn toast(&mut self, key: String, message: String, cx: &mut Context<Self>) {
        self.push_notification(
            Notification::error(message).id1::<ErrorToast>(SharedString::from(key)),
            cx,
        );
    }

    fn push_notification(&mut self, notification: Notification, cx: &mut Context<Self>) {
        let Some(handle) = self.window_handle else {
            return;
        };
        cx.defer(move |cx| {
            let _ = handle.update(cx, |_, window, cx| {
                window.push_notification(notification, cx)
            });
        });
    }

    /// The bottom panel holds the Setup tab (04, `setting_up` and `View output`): show it.
    fn show_setup_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.processes.update(cx, |p, cx| p.show_setup(cx));
        self.reveal_right(cx);
        let Some(panels) = cx
            .try_global::<crate::storage::Local>()
            .map(|local| local.state().panels)
        else {
            return;
        };
        if !panels.bottom {
            window.dispatch_action(Box::new(ToggleBottomPanel), cx);
        }
    }

    /// A banner button's server function; `setup_tab` shows the Setup tab once it succeeds.
    fn banner_call<F: p::Function>(
        &mut self,
        input: F::Input,
        setup_tab: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.banner_pending {
            return;
        }
        self.banner_pending = true;
        let request = self.client.call::<F>(input);
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.banner_pending = false;
                match result {
                    Ok(_) if setup_tab => this.show_setup_tab(window, cx),
                    Ok(_) => {}
                    Err(error) => this.toast_error(&error, cx),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// 04, Empty, loading and error states: one workspace banner.
    fn render_banner(
        &self,
        banner: chat_model::WorkspaceBanner,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        use chat_model::WorkspaceBanner as B;
        let workspace_id = self.store.read(cx).workspace_id.clone();
        match banner {
            B::Progress { title, setup } => v_flex()
                .id("workspace-progress")
                .role(Role::Status)
                .aria_label(title.clone())
                .px_3()
                .py_2()
                .gap_1()
                .border_b_1()
                .border_color(color(Token::Border, cx))
                .child(
                    h_flex()
                        .gap_2()
                        .child(Spinner::new().color(color(Token::Primary, cx)).small())
                        .child(title)
                        .children(setup.then(|| {
                            Button::new("open-setup-tab")
                                .label("Open Setup tab")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.show_setup_tab(window, cx)
                                }))
                        })),
                )
                .into_any_element(),
            B::Error {
                message, detail, ..
            } => {
                let open = self.error_details_open;
                let retry_id = workspace_id.clone();
                v_flex()
                    .id("workspace-error")
                    .role(Role::Alert)
                    .aria_label(message.clone())
                    .px_3()
                    .py_1()
                    .border_b_1()
                    .border_color(color(Token::Destructive, cx))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(div().flex_1().min_w_0().child(message))
                            .child(
                                Button::new("retry-workspace")
                                    .label("Retry")
                                    .disabled(self.banner_pending)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.banner_call::<api::WakeWorkspace>(
                                            p::WakeWorkspaceIn {
                                                workspace_id: retry_id.clone(),
                                            },
                                            false,
                                            window,
                                            cx,
                                        )
                                    })),
                            )
                            .children(detail.is_some().then(|| {
                                Button::new("workspace-error-details")
                                    .ghost()
                                    .label("Details")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.error_details_open = !this.error_details_open;
                                        cx.notify();
                                    }))
                            }))
                            .child(
                                Button::new("archive-failed-workspace")
                                    .ghost()
                                    .label("Archive")
                                    .disabled(self.operation_pending)
                                    .on_click(cx.listener(|this, _, _, cx| this.archive(cx))),
                            ),
                    )
                    .children(detail.filter(|_| open).map(|detail| {
                        div()
                            .id("workspace-error-detail")
                            .max_h(gpui_kit::px(192.))
                            .overflow_y_scroll()
                            .mt_1()
                            .p_2()
                            .font_family("monospace")
                            .text_xs()
                            .child(detail)
                    }))
                    .into_any_element()
            }
            B::SetupFailed => {
                let rerun_id = workspace_id.clone();
                h_flex()
                    .id("setup-failed")
                    .role(Role::Alert)
                    .aria_label("Setup failed.")
                    .px_3()
                    .py_1()
                    .gap_2()
                    .border_b_1()
                    .border_color(color(Token::Warning, cx))
                    .child(div().flex_1().min_w_0().child("Setup failed."))
                    .child(
                        Button::new("rerun-setup")
                            .label("Rerun setup")
                            .disabled(self.banner_pending)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.banner_call::<api::RerunSetup>(
                                    p::RerunSetupIn {
                                        workspace_id: rerun_id.clone(),
                                    },
                                    true,
                                    window,
                                    cx,
                                )
                            })),
                    )
                    .child(
                        Button::new("continue-after-setup")
                            .label("Continue anyway")
                            .disabled(self.banner_pending)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.banner_call::<api::ContinueAfterSetupFailure>(
                                    p::ContinueAfterSetupFailureIn {
                                        workspace_id: workspace_id.clone(),
                                    },
                                    false,
                                    window,
                                    cx,
                                )
                            })),
                    )
                    .child(
                        Button::new("view-setup-output")
                            .ghost()
                            .label("View output")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.show_setup_tab(window, cx)),
                            ),
                    )
                    .into_any_element()
            }
        }
    }

    /// 07 Previews: openPreview's one-time entry link opens in the default browser.
    fn open_preview(&mut self, port: f64, cx: &mut Context<Self>) {
        let request = self.client.call::<api::OpenPreview>(p::OpenPreviewIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
            port,
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(out) => cx.open_url(&out.url),
                Err(e) => this.toast_error(&e, cx),
            });
        })
        .detach();
    }

    fn open_live_view(&mut self, cx: &mut Context<Self>) {
        self.tools.update(cx, |tools, cx| tools.open_browser(cx));
        self.reveal_right(cx);
    }

    fn mutate<F: p::Function>(&mut self, input: F::Input, cx: &mut Context<Self>) {
        if self.operation_pending {
            return;
        }
        self.operation_pending = true;
        let request = self.client.call::<F>(input);
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.operation_pending = false;
                match result {
                    Ok(_) => {
                        this.operation = None;
                        if F::NAME == "archiveWorkspace"
                            && let Some(handle) = crate::app::AppState::try_global(cx)
                                .and_then(|a| a.read(cx).main_window)
                        {
                            let id = this.store.read(cx).workspace_id.clone();
                            cx.defer(move |cx| {
                                let _ = handle.update(cx, |_, window, cx| {
                                    super::sidebar::archive_undo(id, window, cx)
                                });
                            });
                        }
                        if let Some(handle) = this.operation_window.take() {
                            let _ = handle.update(cx, |_, window, cx| window.close_dialog(cx));
                        }
                        this.review.update(cx, |r, cx| r.refresh(cx));
                    }
                    Err(e) => this.toast_error(&e, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn operation(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.operation_pending {
            return;
        }
        self.operation = Some(name.into());
        self.operation_session = self.active.clone();
        self.operation_draft = false;
        let title = self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .map(|w| w.title.clone())
            .unwrap_or_default();
        let title = if name == "Rename chat" {
            self.active
                .as_ref()
                .and_then(|id| self.store.read(cx).state.sessions.get(id))
                .map(|s| s.title.clone())
                .unwrap_or_default()
        } else {
            title
        };
        self.operation_title
            .update(cx, |i, cx| i.set_value(title, window, cx));
        let body = if name == "Create PR" {
            let mut turns: Vec<_> = self.store.read(cx).state.turns.values().cloned().collect();
            turns.sort_by(|a, b| a.seq.total_cmp(&b.seq));
            format!(
                "Created with Tempo.\n\n{}",
                turns
                    .into_iter()
                    .take(20)
                    .map(|turn| format!(
                        "- {}",
                        turn.prompt.text.lines().next().unwrap_or_default()
                    ))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        } else {
            String::new()
        };
        self.operation_body
            .update(cx, |i, cx| i.set_value(body, window, cx));
        self.operation_window = Some(window.window_handle());
        let title = self.operation_title.clone();
        let body = self.operation_body.clone();
        let name = name.to_string();
        let weak = cx.weak_entity();
        let seq = self.revert_seq.unwrap_or_default();
        window.open_dialog(cx, move |dialog, _, cx| {
            let pending = weak.upgrade().is_some_and(|v| v.read(cx).operation_pending);
            let submit = weak.clone();
            let close = weak.clone();
            let mut dialog = dialog.title(name.clone()).overlay_closable(false);
            if matches!(name.as_str(), "Create PR" | "Rename" | "Rename chat") {
                dialog = dialog.child(Input::new(&title));
            }
            if name == "Create PR" {
                let draft = weak.upgrade().is_some_and(|v| v.read(cx).operation_draft);
                let toggle = weak.clone();
                dialog = dialog.child(Textarea::new(&body)).child(
                    Button::new("draft-pr")
                        .label(if draft { "Draft PR ✓" } else { "Draft PR" })
                        .disabled(pending)
                        .on_click(move |_, _, cx| {
                            let _ = toggle.update(cx, |v, cx| {
                                v.operation_draft = !v.operation_draft;
                                cx.notify();
                            });
                        }),
                );
            }
            if name == "Reset preview access" {
                dialog = dialog.child(RESET_PREVIEW_CONFIRM);
            }
            if name == "Merge" {
                dialog = dialog.child("Squash merge this pull request?");
            }
            if name == "Revert" {
                dialog = dialog.child(format!(
                    "Files go back to the end of turn {seq}. A safety checkpoint is saved first."
                ));
            }
            if pending {
                dialog = dialog.child("Working…");
            }
            let button = weak.clone();
            let cancel = weak.clone();
            dialog = dialog.footer(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("confirm-operation")
                            .label("Confirm")
                            .disabled(pending)
                            .on_click(move |_, _, cx| {
                                let _ = button.update(cx, |v, cx| v.submit_operation(cx));
                            }),
                    )
                    .child(
                        Button::new("cancel-operation")
                            .label("Cancel")
                            .disabled(pending)
                            .on_click(move |_, window, cx| {
                                let close = cancel
                                    .update(cx, |v, cx| {
                                        if v.operation_pending {
                                            return false;
                                        }
                                        v.operation = None;
                                        v.operation_window = None;
                                        cx.notify();
                                        true
                                    })
                                    .unwrap_or(true);
                                if close {
                                    window.close_dialog(cx);
                                }
                            }),
                    ),
            );
            dialog
                .on_ok(move |_, _, cx| {
                    let _ = submit.update(cx, |v, cx| v.submit_operation(cx));
                    false
                })
                .on_cancel(move |_, _, cx| {
                    close
                        .update(cx, |v, cx| {
                            if v.operation_pending {
                                return false;
                            }
                            v.operation = None;
                            v.operation_window = None;
                            cx.notify();
                            true
                        })
                        .unwrap_or(true)
                })
        });
        cx.notify();
    }
    fn submit_operation(&mut self, cx: &mut Context<Self>) {
        let id = self.store.read(cx).workspace_id.clone();
        let title = self.operation_title.read(cx).value().to_string();
        let body = self.operation_body.read(cx).value().to_string();
        match self.operation.as_deref() {
            Some("Revert") => {
                if let Some(checkpoint_id) = self.revert_checkpoint.clone() {
                    self.mutate::<api::RevertToCheckpoint>(
                        p::RevertToCheckpointIn {
                            workspace_id: id,
                            checkpoint_id,
                        },
                        cx,
                    );
                }
            }
            Some("Create PR") => self.mutate::<api::CreatePullRequest>(
                p::CreatePullRequestIn {
                    workspace_id: id,
                    title,
                    body,
                    draft: self.operation_draft,
                },
                cx,
            ),
            Some("Merge") => self.mutate::<api::MergePullRequest>(
                p::MergePullRequestIn {
                    workspace_id: id,
                    method: p::MergeMethod::Squash,
                },
                cx,
            ),
            Some("Rename chat") => {
                if let Some(session_id) = self.operation_session.clone() {
                    self.mutate::<api::RenameSession>(
                        p::RenameSessionIn {
                            workspace_id: id,
                            session_id,
                            title,
                        },
                        cx,
                    );
                }
            }
            Some("Rename") => self.mutate::<api::RenameWorkspace>(
                p::RenameWorkspaceIn {
                    workspace_id: id,
                    title,
                },
                cx,
            ),
            Some("Reset preview access") => {
                self.mutate::<api::RotatePreviewKey>(p::RotatePreviewKeyIn { workspace_id: id }, cx)
            }
            _ => {}
        }
    }
    fn archive(&mut self, cx: &mut Context<Self>) {
        self.mutate::<api::ArchiveWorkspace>(
            p::ArchiveWorkspaceIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
            },
            cx,
        );
    }
    fn environment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(w) = self.store.read(cx).state.workspace.clone() {
            super::environments::open_workspace_dialog(self.client.clone(), &w, window, cx);
        }
    }
    fn diagnostics(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let id = self.store.read(cx).workspace_id.clone();
        let view = cx.new(|cx| super::diagnostics::DiagnosticsView::new(client, id, window, cx));
        window.open_dialog(cx, move |d, _, _| {
            d.title("Diagnostics")
                .w(gpui_kit::px(800.))
                .child(div().h(gpui_kit::px(440.)).child(view.clone()))
        });
    }
    fn top_bar(&self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let Some(w) = self.store.read(cx).state.workspace.clone() else {
            return div().into_any_element();
        };
        let changed = self.review.read(cx).dirty || w.has_unpushed_commits == Some(true);
        let primary = if changed {
            Some("Commit and push")
        } else if w.pushed && w.pr_number.is_none() {
            Some("Create PR")
        } else if w.pr_state == Some(p::PrState::Open) {
            Some(if w.checks_state == Some(p::ChecksState::Failure) {
                "View checks"
            } else {
                "Merge"
            })
        } else if matches!(w.pr_state, Some(p::PrState::Merged | p::PrState::Closed)) {
            Some("Archive")
        } else {
            None
        };
        let branch = w.branch.clone();
        let base_branch = self.base_branch_picker(&w, cx);
        let base_label = format!("Base branch: {}", w.base_branch);
        let base_locked = w.pr_number.is_some()
            || matches!(
                w.state,
                p::WorkspaceState::Archived | p::WorkspaceState::Archiving
            );
        let guide_disabled = matches!(
            w.state,
            p::WorkspaceState::Archived | p::WorkspaceState::Archiving
        ) || self.active.is_none();
        let pr_link = crate::app::AppState::try_global(cx).and_then(|app| {
            let hub = app.read(cx).hub.read(cx);
            let project = hub.projects.iter().find(|p| p.id == w.project_id)?;
            super::indicators::pr_link(&project.owner, &project.name, w.pr_number, w.pr_state)
        });
        let id = w.id.clone();
        let sleep = w.state == p::WorkspaceState::Sleeping;
        let weak = cx.weak_entity();
        let instance = match &w.settings.environment.instance {
            p::Instance::InstanceName(name) => name.to_string(),
            p::Instance::CustomInstance(instance) => format!(
                "{} vCPU, {} GiB",
                instance.vcpu,
                (instance.memory_mib as f64 / 1024.).round()
            ),
        };
        let pill = match w.state {
            p::WorkspaceState::Starting => match w
                .op
                .as_ref()
                .map(|op| op.step.as_str())
                .filter(|step| !step.is_empty())
            {
                Some(step) => format!("Starting… {}", chat_model::step_label(step)),
                None => "Starting…".into(),
            },
            p::WorkspaceState::SettingUp => "Running setup".into(),
            p::WorkspaceState::Ready | p::WorkspaceState::Working => {
                format!("Running · {instance}")
            }
            p::WorkspaceState::Stopping => "Going to sleep".into(),
            p::WorkspaceState::Sleeping => "Sleeping".into(),
            p::WorkspaceState::Error => "Error".into(),
            p::WorkspaceState::Creating => "Creating".into(),
            p::WorkspaceState::Archiving => "Archiving".into(),
            p::WorkspaceState::Archived => "Archived".into(),
        };
        let bar = h_flex()
            .group("workspace-branch")
            .flex_wrap()
            .bg(color(Token::Panel, cx))
            .gap_2()
            .p_2()
            .border_b_1()
            .border_color(color(Token::Border, cx))
            .children(
                (w.title != w.slug && w.branch.rsplit('/').next() != Some(w.title.as_str())).then(
                    || {
                        Button::new("workspace-title")
                            .ghost()
                            .small()
                            .label(w.title)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.operation("Rename", window, cx)
                            }))
                    },
                ),
            )
            .child(if let Some(input) = &self.branch_editor {
                div().id("branch-editor").w(gpui_kit::px(220.))
                    .capture_key_down(cx.listener(|this, event: &gpui_kit::KeyDownEvent, _, cx| {
                        if event.keystroke.key == "escape" && !this.branch_pending {
                            this.branch_editor = None;
                            this.branch_subscription = None;
                            cx.stop_propagation(); cx.notify();
                        }
                    }))
                    .child(Input::new(input).aria_label("Branch name").disabled(self.branch_pending))
                    .into_any_element()
            } else {
                Button::new("branch-name").ghost().small()
                    .label(w.branch.clone())
                    .accessibility_label("Rename branch")
                    .tooltip("Double-click to rename branch")
                    .disabled(self.branch_pending || w.pushed || !matches!(w.state, p::WorkspaceState::Ready | p::WorkspaceState::Working | p::WorkspaceState::Sleeping))
                    .on_click(cx.listener(|this, event, window, cx| {
                        if matches!(event, gpui_kit::ClickEvent::Keyboard(_)) || matches!(event, gpui_kit::ClickEvent::Mouse(mouse) if mouse.up.click_count == 2) {
                            this.edit_branch(window, cx);
                        }
                    }))
                    .into_any_element()
            })
            .child(Button::new("copy-branch").ghost().small().icon(gpui_kit::assets::IconName::Copy)
                .opacity(0.).group_hover("workspace-branch", |style| style.opacity(1.)).focus_visible(|style| style.opacity(1.))
                .accessibility_label("Copy branch name").tooltip("Copy branch name")
                .on_click(move |_, _, cx| cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(branch.clone()))))
            .children(pr_link.map(|link| {
                let url = link.url;
                Button::new("pr-link")
                    .label(link.label)
                    .text_color(color(link.token, cx))
                    .accessibility_label("Open the pull request on GitHub")
                    .on_click(move |_, _, cx| cx.open_url(&url))
            }))
            .children(
                super::indicators::preview_links(&w.ports, w.browser_active)
                    .into_iter()
                    .map(|link| match link {
                        PreviewLink::Port(port) => {
                            Button::new(SharedString::from(format!("port-{port}")))
                                .label(format!("{port} ↗"))
                                .on_click(
                                    cx.listener(move |this, _, _, cx| this.open_preview(port, cx)),
                                )
                        }
                        PreviewLink::Live => Button::new("live-view")
                            .accessibility_label("Live")
                            .child(
                                div()
                                    .size(gpui_kit::px(6.))
                                    .rounded_full()
                                    .bg(color(Token::Destructive, cx)),
                            )
                            .child("Live")
                            .on_click(cx.listener(|this, _, _, cx| this.open_live_view(cx))),
                    }),
            )
            .child(div().flex_1())
            .child(if sleep {
                Button::new("wake-pill")
                    .ghost()
                    .small()
                    .label(pill)
                    .tooltip("Wake. Sending a message also wakes it.")
                    .disabled(self.operation_pending)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.mutate::<api::WakeWorkspace>(
                            p::WakeWorkspaceIn {
                                workspace_id: this.store.read(cx).workspace_id.clone(),
                            },
                            cx,
                        )
                    }))
                    .into_any_element()
            } else {
                div()
                    .text_color(color(
                        if w.state == p::WorkspaceState::Error {
                            Token::Destructive
                        } else {
                            Token::MutedForeground
                        },
                        cx,
                    ))
                    .child(pill)
                    .into_any_element()
            })
            .children(primary.map(|label| {
                Button::new("primary-action")
                    .label(label)
                    .disabled(self.operation_pending)
                    .on_click(cx.listener(move |this, _, window, cx| match label {
                        "Commit and push" => {
                            this.reveal_right(cx);
                            this.review.update(cx, |r, cx| r.request_commit(window, cx))
                        }
                        "Archive" => this.archive(cx),
                        "View checks" => {
                            this.reveal_right(cx);
                            this.review.update(cx, |r, cx| r.show_checks(cx))
                        }
                        _ => this.operation(label, window, cx),
                    }))
            }))
            .child(
                Button::new("overflow")
                    .icon(gpui_kit::assets::IconName::Ellipsis)
                    .accessibility_label("More actions")
                    .tooltip("More actions")
                    .dropdown_menu(move |menu, _, _| {
                        let weak_wake = weak.clone();
                        let wake_id = id.clone();
                        let mut menu = menu.item(
                            PopupMenuItem::new(if sleep { "Wake" } else { "Sleep" }).on_click(
                                move |_, _, cx| {
                                    let _ = weak_wake.update(cx, |this, cx| {
                                        if sleep {
                                            this.mutate::<api::WakeWorkspace>(
                                                p::WakeWorkspaceIn {
                                                    workspace_id: wake_id.clone(),
                                                },
                                                cx,
                                            )
                                        } else {
                                            this.mutate::<api::SleepWorkspace>(
                                                p::SleepWorkspaceIn {
                                                    workspace_id: wake_id.clone(),
                                                },
                                                cx,
                                            )
                                        }
                                    });
                                },
                            ),
                        );
                        let base_weak = weak.clone();
                        menu = menu.item(PopupMenuItem::new(base_label.clone()).disabled(base_locked).on_click(move |_, window, cx| {
                            let _ = base_weak.update(cx, |_, cx| {
                                cx.defer_in(window, |this, window, cx| this.open_branch_picker(window, cx));
                            });
                        }));
                        for label in [
                            "Create or update guide",
                            "Open guide",
                            "Open on GitHub",
                            "Copy workspace link",
                            "Rename workspace",
                            "Rename chat",
                            "Reset preview access",
                            "Environment…",
                            "Diagnostics",
                            "Archive",
                        ] {
                            let weak = weak.clone();
                            menu = menu.item(PopupMenuItem::new(label)
                                .disabled(label == "Create or update guide" && guide_disabled)
                                .on_click(
                                move |_, window, cx| {
                                    let _ = weak.update(cx, |this, cx| match label {
                                        "Create or update guide" => {
                                            if let Some(id) = this.active.clone() {
                                                this.send(&id, include_str!("../../../../packages/protocol/pr-guide-prompt.txt"), window, cx);
                                            }
                                        }
                                        "Open guide" => {
                                            cx.open_url(&format!("{}/w/{}?guide=true", this.client.server().origin(), this.store.read(cx).workspace_id));
                                        }
                                        "Rename workspace" => this.operation("Rename", window, cx),
                                        "Open on GitHub" => {
                                            if let Some(w) = &this.store.read(cx).state.workspace {
                                                let app = crate::app::AppState::global(cx);
                                                if let Some(p) = app
                                                    .read(cx)
                                                    .hub
                                                    .read(cx)
                                                    .projects
                                                    .iter()
                                                    .find(|p| p.id == w.project_id)
                                                {
                                                    cx.open_url(&format!(
                                                        "https://github.com/{}/{}",
                                                        p.owner, p.name
                                                    ));
                                                }
                                            }
                                        }
                                        "Copy workspace link" => {
                                            if let Some(url) = crate::app::AppState::global(cx)
                                                .read(cx)
                                                .server_url
                                                .as_ref()
                                            {
                                                cx.write_to_clipboard(
                                                    gpui_kit::ClipboardItem::new_string(format!(
                                                        "{}/w/{}",
                                                        url.trim_end_matches('/'),
                                                        this.store.read(cx).workspace_id
                                                    )),
                                                );
                                            }
                                        }
                                        "Environment…" => this.environment(window, cx),
                                        "Diagnostics" => this.diagnostics(window, cx),
                                        "Archive" => this.archive(cx),
                                        _ => this.operation(label, window, cx),
                                    });
                                },
                            ));
                        }
                        menu
                    }),
            )
            .child(base_branch)
            .child(
                Button::new("toggle-right-side")
                    .icon(gpui_kit::assets::IconName::PanelRight)
                    .accessibility_label("Toggle right side")
                    .tooltip("Toggle right side (⌘⌥B)")
                    .on_click(|_, window, cx| {
                        window.dispatch_action(Box::new(ToggleRightSide), cx)
                    }),
            )
            .into_any_element();
        if self.show_window_controls {
            gpui_kit::component::TitleBar::new()
                .h(gpui_kit::px(40.))
                .border_b_0()
                .bg(color(Token::Panel, cx))
                .child(div().w_full().child(bar))
                .into_any_element()
        } else {
            bar
        }
    }

    /// `→ <base branch>` (04, Top bar): a searchable `listBranches` picker until a PR exists.
    fn base_branch_picker(
        &self,
        w: &p::WorkspaceDetail,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let base = w.base_branch.clone();
        let locked = w.pr_number.is_some()
            || matches!(
                w.state,
                p::WorkspaceState::Archived | p::WorkspaceState::Archiving
            );
        if locked {
            return div().into_any_element();
        }
        let weak = cx.weak_entity();
        let popover = Popover::new("base-branch-picker")
            .trigger(BranchPickerAnchor)
            .anchor(gpui_kit::Anchor::TopRight)
            .open(self.branch_picker.is_some())
            .on_open_change(cx.listener(|this, open: &bool, _, cx| {
                if !*open {
                    this.branch_picker = None;
                    cx.notify();
                }
            }))
            .content(move |_, _, cx| {
                let Some(view) = weak.upgrade() else {
                    return div().into_any_element();
                };
                let Some(picker) = &view.read(cx).branch_picker else {
                    return div().into_any_element();
                };
                let list = match &picker.branches {
                    None => super::skeleton_rows(3).into_any_element(),
                    Some(Err(message)) => {
                        let retry = weak.clone();
                        v_flex()
                            .p_2()
                            .gap_2()
                            .child(message.clone())
                            .child(Button::new("retry-branches").label("Retry").on_click(
                                move |_, _, cx| {
                                    let _ = retry
                                        .update(cx, |this, cx| this.search_branches(false, cx));
                                },
                            ))
                            .into_any_element()
                    }
                    Some(Ok(names)) if names.is_empty() => {
                        div().p_2().child("No branches.").into_any_element()
                    }
                    Some(Ok(names)) => v_flex()
                        .id("base-branch-list")
                        .role(Role::List)
                        .aria_label("Branches")
                        .max_h(gpui_kit::px(240.))
                        .overflow_y_scroll()
                        .children(names.iter().enumerate().map(|(ix, name)| {
                            let pick = weak.clone();
                            let branch = name.clone();
                            Button::new(("base-branch-option", ix))
                                .ghost()
                                .w_full()
                                .accessibility_label(if *name == base {
                                    format!("{name}, current base branch")
                                } else {
                                    name.clone()
                                })
                                .child(
                                    h_flex()
                                        .w_full()
                                        .min_w_0()
                                        .gap_2()
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .text_left()
                                                .truncate()
                                                .font_family("monospace")
                                                .child(name.clone()),
                                        )
                                        .children((*name == base).then(|| {
                                            gpui_kit::component::Icon::new(
                                                gpui_kit::assets::IconName::Check,
                                            )
                                            .small()
                                        })),
                                )
                                .on_click(move |_, _, cx| {
                                    let _ = pick.update(cx, |this, cx| {
                                        this.pick_base_branch(branch.clone(), cx)
                                    });
                                })
                        }))
                        .into_any_element(),
                };
                v_flex()
                    .w(gpui_kit::px(288.))
                    .gap_1()
                    .child(Input::new(&picker.query))
                    .child(list)
                    .into_any_element()
            });
        if let Some(picker) = &self.branch_picker {
            popover
                .track_focus(&picker.query.read(cx).focus_handle(cx))
                .into_any_element()
        } else {
            popover.into_any_element()
        }
    }

    fn open_branch_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search branches"));
        let changed = cx.subscribe(&query, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.search_branches(true, cx);
            }
        });
        query.update(cx, |q, cx| q.focus(window, cx));
        self.branch_picker = Some(BranchPicker {
            query,
            branches: None,
            generation: 0,
            _search: None,
            _query_changed: changed,
        });
        self.search_branches(false, cx);
        cx.notify();
    }

    /// `listBranches {projectId, query?}`, 200 ms after the search changes, as the web.
    fn search_branches(&mut self, debounce: bool, cx: &mut Context<Self>) {
        let Some(w) = self.store.read(cx).state.workspace.clone() else {
            return;
        };
        let Some(picker) = &mut self.branch_picker else {
            return;
        };
        picker.generation += 1;
        let generation = picker.generation;
        let query = picker.query.read(cx).value().trim().to_string();
        let request = self.client.call::<api::ListBranches>(p::ListBranchesIn {
            project_id: w.project_id,
            query: (!query.is_empty()).then_some(query),
        });
        picker._search = Some(cx.spawn(async move |this, cx| {
            if debounce {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(200))
                    .await;
            }
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                let Some(picker) = &mut this.branch_picker else {
                    return;
                };
                if picker.generation != generation {
                    return;
                }
                picker.branches = Some(
                    result
                        .map(|branches| {
                            branches
                                .into_iter()
                                .map(|b| b.name)
                                .filter(|name| *name != w.branch)
                                .collect()
                        })
                        .map_err(|e| api_error_message(&e, None)),
                );
                cx.notify();
            });
        }));
    }

    fn pick_base_branch(&mut self, name: String, cx: &mut Context<Self>) {
        self.branch_picker = None;
        let Some(w) = self.store.read(cx).state.workspace.clone() else {
            return;
        };
        if name != w.base_branch
            && let Ok(base_branch) = name.try_into()
        {
            self.mutate::<api::SetBaseBranch>(
                p::SetBaseBranchIn {
                    workspace_id: w.id,
                    base_branch,
                },
                cx,
            );
        }
        cx.notify();
    }

    fn open_run_transcript(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_chat(id, window, cx);
        let title = self
            .store
            .read(cx)
            .state
            .sessions
            .get(id)
            .map(chat_model::session_title)
            .unwrap_or_else(|| "Run".into());
        if let Some(chat) = self.chats.get(id) {
            let transcript = chat.transcript.clone();
            self.review
                .update(cx, |r, cx| r.open_run_transcript(id, title, transcript, cx));
        }
        self.sync(window, cx);
        cx.emit(RevealRight);
    }
    fn tab_ids(&self, cx: &gpui_kit::App) -> Vec<String> {
        let state = &self.store.read(cx).state;
        let mut ids: Vec<_> = chat_model::sessions(state, false)
            .into_iter()
            .map(|s| s.id.clone())
            .collect();
        ids.extend(
            self.viewing_closed
                .iter()
                .filter(|id| {
                    state
                        .sessions
                        .get(*id)
                        .is_some_and(|s| s.status == p::SessionStatus::Closed)
                })
                .cloned(),
        );
        ids
    }

    pub fn cycle_tab(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.tab_ids(cx);
        if ids.is_empty() {
            return;
        }
        let ix = self
            .active
            .as_ref()
            .and_then(|id| ids.iter().position(|s| s == id))
            .unwrap_or(0);
        let next = if forward {
            (ix + 1) % ids.len()
        } else {
            (ix + ids.len() - 1) % ids.len()
        };
        self.active = Some(ids[next].clone());
        self.sync(window, cx);
        cx.notify();
    }

    pub fn focus_composer(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(chat) = self.active.as_ref().and_then(|id| self.chats.get(id)) {
            chat.composer.update(cx, |c, cx| c.focus(window, cx));
        }
    }

    fn ensure_chat(&mut self, session_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.chats.contains_key(session_id) {
            return;
        }
        let workspace_id = self.store.read(cx).workspace_id.clone();
        let client = self.client.clone();
        let source = workspace_id.clone();
        let transcript = cx.new(|cx| {
            let mut transcript = TranscriptView::new(Vec::new(), cx);
            transcript.set_attachment_source(client, source);
            transcript
        });
        let composer = cx.new(|cx| Composer::new(window, cx));
        let draft = cx
            .global::<crate::storage::Local>()
            .state()
            .draft(&workspace_id, session_id)
            .unwrap_or("")
            .to_string();
        composer.update(cx, |c, cx| c.set_text(&draft, window, cx));
        let session = session_id.to_string();
        let composer_events = cx.subscribe_in(
            &composer,
            window,
            move |this, _, event: &ComposerEvent, window, cx| match event {
                ComposerEvent::Change(text) => {
                    let workspace_id = this.store.read(cx).workspace_id.clone();
                    cx.global_mut::<crate::storage::Local>()
                        .update_state(|state| state.set_draft(&workspace_id, &session, text));
                }
                ComposerEvent::ClearReview => {
                    this.review_comments.clear();
                    for chat in this.chats.values() {
                        chat.composer.update(cx, |c, cx| {
                            c.review_count = 0;
                            cx.notify();
                        });
                    }
                    cx.notify();
                }
                ComposerEvent::Send(text) => this.send(&session, text, window, cx),
                ComposerEvent::Steer(text) => {
                    if let Some(chat) = this.chats.get(&session) {
                        let mut prompt = chat.composer.read(cx).prompt(text);
                        prompt.review_comment_ids = this.review_comments.clone();
                        this.send_prompt_with_delivery(
                            &session,
                            prompt,
                            Some(p::SendPromptInDelivery::Steer),
                            window,
                            cx,
                        );
                    }
                }
                ComposerEvent::AttachImage(image) => {
                    this.attach_image(&session, image.clone(), window, cx)
                }
                ComposerEvent::Attach(paths) => this.attach(&session, paths.clone(), window, cx),
                ComposerEvent::LoadFiles => this.load_files(&session, window, cx),
                ComposerEvent::Stop => this.stop(&session, cx),
                ComposerEvent::TogglePlanMode => this.toggle_plan(&session, window, cx),
                ComposerEvent::SetMode(value) => this.configure(&session, None, value, window, cx),
                ComposerEvent::SetModel { config_id, value } => {
                    this.configure(&session, Some(config_id), value, window, cx)
                }
            },
        );
        let session = session_id.to_string();
        let transcript_events = cx.subscribe_in(
            &transcript,
            window,
            move |this, _, event: &TranscriptEvent, window, cx| match event {
                TranscriptEvent::Permission {
                    request_id,
                    option_id,
                } => this.respond_permission(request_id, option_id, cx),
                TranscriptEvent::RevertCheckpoint { checkpoint_id } => {
                    this.revert_checkpoint = Some(checkpoint_id.clone());
                    this.revert_seq = None;
                    this.operation("Revert", window, cx);
                }
                TranscriptEvent::Revert { turn_id } => {
                    let turn = this.store.read(cx).state.turns.get(turn_id).cloned();
                    if let Some(turn) = turn {
                        if let Some(checkpoint) = turn.checkpoint_id {
                            this.revert_checkpoint = Some(checkpoint);
                            this.revert_seq = Some(turn.seq);
                            this.operation("Revert", window, cx);
                        } else {
                            this.toast(
                                "CHECKPOINT_NOT_FOUND".into(),
                                crate::errors::error_message("CHECKPOINT_NOT_FOUND", None),
                                cx,
                            );
                        }
                    }
                }
                TranscriptEvent::ResolveAgentProposal { proposal_id, apply } => {
                    this.mutate::<api::ResolveAgentProposal>(
                        p::ResolveAgentProposalIn {
                            workspace_id: this.store.read(cx).workspace_id.clone(),
                            proposal_id: proposal_id.clone(),
                            apply: *apply,
                        },
                        cx,
                    )
                }
                TranscriptEvent::RequestAgent { agent_id } => this.mutate::<api::RequestAgent>(
                    p::RequestAgentIn {
                        workspace_id: this.store.read(cx).workspace_id.clone(),
                        agent_id: agent_id.clone(),
                        session_id: Some(session.clone()),
                        text: None,
                    },
                    cx,
                ),
                TranscriptEvent::CancelRun { run_id } => this.mutate::<api::CancelRun>(
                    p::CancelRunIn {
                        workspace_id: this.store.read(cx).workspace_id.clone(),
                        run_id: run_id.clone(),
                    },
                    cx,
                ),
                TranscriptEvent::SendRun { run_id } => this.mutate::<api::SendRunToChat>(
                    p::SendRunToChatIn {
                        workspace_id: this.store.read(cx).workspace_id.clone(),
                        run_id: run_id.clone(),
                    },
                    cx,
                ),
                TranscriptEvent::OpenRun { session_id } => {
                    this.open_run_transcript(session_id, window, cx);
                }
                TranscriptEvent::OpenArtifact {
                    artifact_id,
                    version,
                } => {
                    this.review.update(cx, |r, cx| {
                        r.open_artifact(artifact_id.clone(), Some(*version), window, cx)
                    });
                    cx.emit(RevealRight);
                    cx.notify();
                }
                TranscriptEvent::Retry { turn_id } => {
                    let prompt = this
                        .store
                        .read(cx)
                        .state
                        .turns
                        .get(turn_id)
                        .map(|t| t.prompt.clone());
                    if let Some(prompt) = prompt {
                        this.send_prompt(&session, prompt, window, cx);
                    }
                }
            },
        );
        self.chats.insert(
            session_id.into(),
            Chat {
                transcript,
                composer,
                _subscriptions: vec![composer_events, transcript_events],
            },
        );
    }

    /// The right side starts closed while the workspace sleeps or has no changes and no PR.
    pub fn right_starts_closed(&self, cx: &gpui_kit::App) -> bool {
        let state = &self.store.read(cx).state;
        let Some(w) = &state.workspace else {
            return true;
        };
        let has_changes = self.review.read(cx).has_changes()
            || [w.changes.as_ref(), state.changes.as_ref()]
                .into_iter()
                .flatten()
                .any(|c| !c.files.is_empty());
        right_starts_closed(w.state, has_changes, w.pr_number.is_some())
    }

    pub fn reveal_right(&mut self, cx: &mut Context<Self>) {
        self.right_opened = true;
        cx.emit(RevealRight);
        cx.notify();
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.detail = transcript_detail(cx);
        let store_error = self.store.read(cx).error.clone();
        if store_error != self.toasted_store_error {
            self.toasted_store_error = store_error.clone();
            if let Some(message) = store_error {
                self.toast("channel".into(), message, cx);
            }
        }
        let state = self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .map(|w| w.state);
        if state == Some(p::WorkspaceState::SettingUp) && self.last_state != state {
            self.show_setup_tab(window, cx);
        }
        if state != Some(p::WorkspaceState::Error) {
            self.error_details_open = false;
        }
        self.last_state = state;
        if let Some(id) = self.closing.clone()
            && !self.close_request
            && chat_model::running_turn(&self.store.read(cx).state, &id).is_none()
        {
            self.finish_close(&id, window, cx);
        }
        let ids = self.tab_ids(cx);
        if self.active.as_ref().is_none_or(|id| !ids.contains(id)) {
            self.active = ids.first().cloned();
        }
        if let Some(id) = self.active.clone() {
            self.ensure_chat(&id, window, cx);
        }
        let agent = self
            .active
            .as_ref()
            .and_then(|id| self.store.read(cx).state.sessions.get(id))
            .map(|s| s.agent);
        self.review.update(cx, |r, cx| r.set_agent(agent, cx));
        for (id, chat) in &self.chats {
            let state = &self.store.read(cx).state;
            let read_only = state
                .sessions
                .get(id)
                .is_none_or(|s| s.status == p::SessionStatus::Closed)
                || state.workspace.as_ref().is_some_and(|w| {
                    matches!(
                        w.state,
                        p::WorkspaceState::Archived | p::WorkspaceState::Archiving
                    )
                });
            let rows = chat_model::transcript_rows(state, id, self.detail)
                .into_iter()
                .map(TranscriptRow::from_native)
                .collect();
            let run = state
                .sessions
                .get(id)
                .and_then(|s| s.run_id.as_ref())
                .and_then(|id| state.runs.get(id));
            let run_running = run
                .is_some_and(|r| matches!(r.status, p::RunStatus::Running | p::RunStatus::Queued));
            let working = chat_model::running_turn(state, id).is_some() || run_running;
            let steering = state
                .sessions
                .get(id)
                .is_some_and(|s| s.steering == Some(true));
            let session = state.sessions.get(id).cloned();
            let can_revert = state
                .workspace
                .as_ref()
                .is_some_and(|w| w.running_turn_id.is_none() && w.queue.is_empty());
            let placeholder = match (&session, &state.workspace) {
                (Some(session), Some(w)) if w.state == p::WorkspaceState::Sleeping => format!(
                    "Message {} to wake this workspace",
                    chat_model::agent_label(session.agent)
                ),
                _ => String::new(),
            };
            let agent_proposals = state
                .workspace
                .as_ref()
                .map(|w| w.agent_proposals.clone())
                .unwrap_or_default()
                .into_iter()
                .map(|p| (p.id.clone(), p))
                .collect();
            let runs = state.runs.clone();
            chat.transcript.update(cx, |t, cx| {
                t.read_only = read_only;
                t.runs = runs;
                t.agent_proposals = agent_proposals;
                t.agent = session.as_ref().map(|s| s.agent);
                t.can_revert = can_revert;
                t.sync(rows, cx);
            });
            chat.composer.update(cx, |c, cx| {
                c.read_only = read_only || run_running;
                c.run_running = run_running;
                c.review_count = self.review_comments.len();
                c.working = working;
                c.steering = steering;
                c.set_placeholder(&placeholder, window, cx);
                if let Some(session) = &session {
                    c.sync_session(session, window, cx);
                }
                cx.notify();
            });
        }
        if let Some(id) = &self.active
            && let Some(chat) = self.chats.get(id)
        {
            let pending: Vec<_> = self
                .store
                .read(cx)
                .state
                .permissions
                .values()
                .filter(|p| {
                    p.session_id == *id && self.store.read(cx).state.items.contains_key(&p.item_id)
                })
                .map(|p| p.request_id.clone())
                .collect();
            for request_id in pending {
                if self.seen_permissions.insert(request_id.clone())
                    && chat.composer.read(cx).text(cx).trim().is_empty()
                {
                    chat.transcript
                        .update(cx, |t, cx| t.focus_permission(&request_id, window, cx));
                }
            }
        }
        cx.notify();
    }

    fn send(&mut self, session_id: &str, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chat) = self.chats.get(session_id) else {
            return;
        };
        let mut prompt = chat.composer.read(cx).prompt(text);
        prompt.review_comment_ids = self.review_comments.clone();
        self.send_prompt(session_id, prompt, window, cx);
    }
    fn attach_image(
        &mut self,
        session_id: &str,
        image: gpui_kit::Image,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(chat) = self.chats.get(session_id) else {
            return;
        };
        if chat.composer.read(cx).uploading || chat.composer.read(cx).read_only {
            return;
        }
        let (name, mime) = match image.format() {
            gpui_kit::ImageFormat::Png => ("Pasted image.png", "image/png"),
            gpui_kit::ImageFormat::Jpeg => ("Pasted image.jpg", "image/jpeg"),
            gpui_kit::ImageFormat::Gif => ("Pasted image.gif", "image/gif"),
            gpui_kit::ImageFormat::Webp => ("Pasted image.webp", "image/webp"),
            _ => {
                self.toast(
                    "attachment".into(),
                    "Paste a PNG, JPEG, GIF or WebP image.".into(),
                    cx,
                );
                return;
            }
        };
        if image.bytes().len() as u64 > tempo_client::MAX_ATTACHMENT_BYTES {
            self.toast("attachment".into(), TOO_LARGE.into(), cx);
            return;
        }
        chat.composer.update(cx, |c, cx| {
            c.uploading = true;
            cx.notify();
        });
        let session_id = session_id.to_string();
        let client = self.client.clone();
        let id = self.store.read(cx).workspace_id.clone();
        cx.spawn_in(window, async move |this, cx| {
            let bytes = cx
                .background_executor()
                .spawn(async move { image.bytes().to_vec() })
                .await;
            let result = client.upload_attachment(&id, name, mime, bytes).await;
            let _ = this.update_in(cx, |this, _, cx| {
                if let Some(chat) = this.chats.get(&session_id) {
                    chat.composer.update(cx, |c, cx| {
                        c.uploading = false;
                        if let Ok(out) = &result
                            && let (Some(id), Some(name)) =
                                (out["attachmentId"].as_str(), out["name"].as_str())
                        {
                            c.add_attachment(id.into(), name.into(), cx);
                        }
                        cx.notify();
                    });
                }
                if let Err(e) = result {
                    this.toast_error(&e, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn attach(
        &mut self,
        session_id: &str,
        paths: Vec<std::path::PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(chat) = self.chats.get(session_id) else {
            return;
        };
        if chat.composer.read(cx).read_only || chat.composer.read(cx).uploading {
            return;
        }
        chat.composer.update(cx, |c, cx| {
            c.uploading = true;
            cx.notify();
        });
        let pick = if paths.is_empty() {
            Some(cx.prompt_for_paths(gpui_kit::PathPromptOptions {
                files: true,
                directories: false,
                multiple: true,
                prompt: Some("Attach files".into()),
            }))
        } else {
            None
        };
        let client = self.client.clone();
        let workspace_id = self.store.read(cx).workspace_id.clone();
        let session_id = session_id.to_string();
        cx.spawn_in(window, async move |this, cx| {
            let paths = if let Some(pick) = pick {
                pick.await
                    .ok()
                    .and_then(Result::ok)
                    .flatten()
                    .unwrap_or_default()
            } else {
                paths
            };
            for path in paths {
                let name = path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "attachment".into());
                let bytes = cx
                    .background_executor()
                    .spawn(async move {
                        let file =
                            std::fs::File::open(path).map_err(|_| "Could not read attachment.")?;
                        use std::io::Read as _;
                        let mut bytes = vec![];
                        file.take(tempo_client::MAX_ATTACHMENT_BYTES + 1)
                            .read_to_end(&mut bytes)
                            .map_err(|_| "Could not read attachment.")?;
                        if bytes.len() as u64 > tempo_client::MAX_ATTACHMENT_BYTES {
                            return Err(TOO_LARGE);
                        }
                        Ok(bytes)
                    })
                    .await;
                let result = match bytes {
                    Ok(bytes) => client
                        .upload_attachment(&workspace_id, &name, attachment_mime(&name), bytes)
                        .await
                        .map_err(Err),
                    Err(e) => Err(Ok(e)),
                };
                if this
                    .update_in(cx, |this, _, cx| {
                        match result {
                            Ok(out) => {
                                if let (Some(id), Some(name)) =
                                    (out["attachmentId"].as_str(), out["name"].as_str())
                                    && let Some(chat) = this.chats.get(&session_id)
                                {
                                    chat.composer.update(cx, |c, cx| {
                                        c.add_attachment(id.into(), name.into(), cx)
                                    });
                                }
                            }
                            Err(Ok(message)) => this.toast("attachment".into(), message.into(), cx),
                            Err(Err(error)) => this.toast_error(&error, cx),
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    return;
                }
            }
            let _ = this.update_in(cx, |this, _, cx| {
                if let Some(chat) = this.chats.get(&session_id) {
                    chat.composer.update(cx, |c, cx| {
                        c.uploading = false;
                        cx.notify();
                    });
                }
            });
        })
        .detach();
    }
    fn load_files(&mut self, session_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let agents = self.client.call::<api::ListAgents>(p::Empty {});
        let project_id = self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .map(|w| w.project_id.clone())
            .unwrap_or_default();
        let attachments = self
            .client
            .call::<api::ListProjectAgents>(p::ListProjectAgentsIn { project_id });
        let request = self.client.call::<api::ListFiles>(p::ListFilesIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
        });
        let id = session_id.to_string();
        cx.spawn_in(window, async move |this, cx| {
            let agent_list = agents.await.unwrap_or_default();
            let attached: Vec<_> = attachments
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|a| a.agent.map(|agent| agent.handle.0))
                .collect();
            let result = request
                .await
                .map(|out| out.paths)
                .map_err(|e| api_error_message(&e, None));
            let _ = this.update_in(cx, |this, _, cx| {
                if let Some(chat) = this.chats.get(&id) {
                    chat.composer.update(cx, |c, cx| {
                        c.set_agents(agent_list, cx);
                        c.set_attached_agents(attached, cx);
                        c.set_files(result, cx);
                    });
                }
            });
        })
        .detach();
    }

    fn send_prompt(
        &mut self,
        session_id: &str,
        prompt: p::TurnPrompt,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.send_prompt_with_delivery(session_id, prompt, None, window, cx);
    }

    fn send_prompt_with_delivery(
        &mut self,
        session_id: &str,
        prompt: p::TurnPrompt,
        delivery: Option<p::SendPromptInDelivery>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(chat) = self.chats.get(session_id) else {
            return;
        };
        if chat.composer.read(cx).read_only || chat.composer.read(cx).sending {
            return;
        }
        chat.composer.update(cx, |c, cx| {
            c.sending = true;
            cx.notify();
        });
        if prompt.text.trim_start().starts_with("/agent")
            && prompt.text.split_whitespace().next() == Some("/agent")
        {
            let rest = prompt
                .text
                .trim_start()
                .strip_prefix("/agent")
                .unwrap_or_default()
                .trim_start();
            let (name, text) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            if name.is_empty()
                || !prompt.mentions.is_empty()
                || !prompt.attachment_ids.is_empty()
                || !prompt.review_comment_ids.is_empty()
            {
                chat.composer.update(cx, |c, cx| {
                    c.sending = false;
                    cx.notify();
                });
                self.toast(
                    "AGENT_INVALID".into(),
                    "Use /agent <handle> <text>, with one agent per message.".into(),
                    cx,
                );
                return;
            }
            let Some(agent_id) = self
                .library_agents
                .iter()
                .find(|a| a.handle.0 == name)
                .map(|a| a.id.clone())
            else {
                chat.composer.update(cx, |c, cx| {
                    c.sending = false;
                    cx.notify();
                });
                self.toast("NOT_FOUND".into(), "No agent with that handle.".into(), cx);
                return;
            };
            let request = self.client.call::<api::RequestAgent>(p::RequestAgentIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
                session_id: Some(session_id.into()),
                agent_id,
                text: (!text.is_empty()).then(|| text.into()),
            });
            let session_id = session_id.to_string();
            cx.spawn_in(window, async move |this, cx| {
                let result = request.await;
                let _ = this.update_in(cx, |this, window, cx| {
                    if let Some(chat) = this.chats.get(&session_id) {
                        chat.composer.update(cx, |c, cx| {
                            c.sending = false;
                            if result.is_ok() {
                                c.clear_sent(&prompt, window, cx);
                            }
                            cx.notify();
                        });
                    }
                    if let Err(error) = result {
                        this.toast_error(&error, cx);
                    }
                });
            })
            .detach();
            return;
        }
        let input = p::SendPromptIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
            session_id: session_id.into(),
            text: prompt.text.clone(),
            mentions: prompt.mentions.clone(),
            attachment_ids: prompt.attachment_ids.clone(),
            review_comment_ids: prompt.review_comment_ids.clone(),
            delivery,
        };
        let request = self.client.call::<api::SendPrompt>(input);
        let session_id = session_id.to_string();
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if let Some(chat) = this.chats.get(&session_id) {
                    chat.composer.update(cx, |c, cx| {
                        c.sending = false;
                        if result.is_ok() {
                            c.review_count = 0;
                        }
                        if result.is_ok() {
                            c.clear_sent(&prompt, window, cx);
                        }
                        cx.notify();
                    });
                }
                if result.is_ok() {
                    this.review_comments
                        .retain(|id| !prompt.review_comment_ids.contains(id));
                    this.review
                        .update(cx, |r, cx| r.mark_sent(&prompt.review_comment_ids, cx));
                    for chat in this.chats.values() {
                        chat.composer.update(cx, |c, cx| {
                            c.review_count = this.review_comments.len();
                            cx.notify();
                        });
                    }
                }
                match result {
                    Ok(turn) => this.store.update(cx, |store, cx| {
                        if store.state.turns.contains_key(&turn.id) {
                            return;
                        }
                        store
                            .state
                            .apply(p::WorkspaceServerMessage::Turn(p::WsTurn {
                                type_: p::WsTurnType::Turn,
                                turn,
                            }));
                        cx.notify();
                    }),
                    Err(tempo_client::ApiError::Network(_)) => this.toast(
                        "delivery".into(),
                        "Delivery could not be confirmed. Check the response before retrying."
                            .into(),
                        cx,
                    ),
                    Err(error) => this.toast_error(&error, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn edit_queue(&mut self, turn_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.queue_pending {
            return;
        }
        let Some(turn) = self.store.read(cx).state.turns.get(turn_id) else {
            return;
        };
        if turn.status != p::TurnStatus::Queued || turn.steering_pending == Some(true) {
            return;
        }
        let text = turn.prompt.text.clone();
        let input = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 12));
        input.update(cx, |input, cx| {
            input.set_value(text, window, cx);
            input.focus(window, cx);
        });
        self.queue_editor = Some(QueueEditor {
            turn_id: turn_id.into(),
            input,
        });
        cx.notify();
    }

    fn save_queue(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = &self.queue_editor else {
            return;
        };
        let text = editor.input.read(cx).value().to_string();
        if self.queue_pending || text.trim().is_empty() {
            return;
        }
        self.queue_pending = true;
        let request = self
            .client
            .call::<api::EditQueuedTurn>(p::EditQueuedTurnIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
                turn_id: editor.turn_id.clone(),
                text,
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.queue_pending = false;
                match result {
                    Ok(turn) => {
                        this.queue_editor = None;
                        this.store.update(cx, |store, cx| {
                            if store
                                .state
                                .turns
                                .get(&turn.id)
                                .is_some_and(|t| t.status != p::TurnStatus::Queued)
                            {
                                return;
                            }
                            store
                                .state
                                .apply(p::WorkspaceServerMessage::Turn(p::WsTurn {
                                    type_: p::WsTurnType::Turn,
                                    turn,
                                }));
                            cx.notify();
                        });
                    }
                    Err(error) => this.toast_error(&error, cx),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn delete_queue(&mut self, turn_id: &str, cx: &mut Context<Self>) {
        if self.queue_pending {
            return;
        }
        self.queue_pending = true;
        let turn_id = turn_id.to_string();
        let request = self
            .client
            .call::<api::DeleteQueuedTurn>(p::DeleteQueuedTurnIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
                turn_id: turn_id.clone(),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.queue_pending = false;
                match result {
                    Ok(_) => {
                        if this
                            .queue_editor
                            .as_ref()
                            .is_some_and(|e| e.turn_id == turn_id)
                        {
                            this.queue_editor = None;
                        }
                        this.store.update(cx, |store, cx| {
                            store.state.apply(p::WorkspaceServerMessage::TurnDeleted(
                                p::WsTurnDeleted {
                                    type_: p::WsTurnDeletedType::TurnDeleted,
                                    turn_id,
                                },
                            ));
                            cx.notify();
                        });
                    }
                    Err(error) => this.toast_error(&error, cx),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn move_queue(&mut self, dragged: &QueuedDrag, before: &str, cx: &mut Context<Self>) {
        let store = self.store.read(cx);
        if self.queue_pending || dragged.workspace_id != store.workspace_id {
            return;
        }
        let mut turns: Vec<_> = store
            .state
            .turns
            .values()
            .filter(|t| t.status == p::TurnStatus::Queued)
            .collect();
        turns.sort_by(|a, b| {
            a.queue_pos
                .unwrap_or(f64::INFINITY)
                .total_cmp(&b.queue_pos.unwrap_or(f64::INFINITY))
                .then_with(|| a.id.cmp(&b.id))
        });
        let mut ids: Vec<_> = turns.into_iter().map(|t| t.id.clone()).collect();
        if dragged.turn_id == before
            || !ids.contains(&dragged.turn_id)
            || !ids.iter().any(|id| id == before)
        {
            return;
        }
        let ix = ids.iter().position(|id| id == before).unwrap();
        ids.retain(|id| id != &dragged.turn_id);
        ids.insert(ix, dragged.turn_id.clone());
        let request = self.client.call::<api::ReorderQueue>(p::ReorderQueueIn {
            workspace_id: store.workspace_id.clone(),
            turn_ids: ids,
        });
        self.queue_pending = true;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.queue_pending = false;
                if let Err(error) = result {
                    this.toast_error(&error, cx);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn stop(&mut self, session_id: &str, cx: &mut Context<Self>) {
        if let Some(run_id) = self
            .store
            .read(cx)
            .state
            .sessions
            .get(session_id)
            .and_then(|s| s.run_id.clone())
        {
            let request = self.client.call::<api::CancelRun>(p::CancelRunIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
                run_id,
            });
            cx.spawn(async move |this, cx| {
                if let Err(error) = request.await {
                    let _ = this.update(cx, |this, cx| this.toast_error(&error, cx));
                }
            })
            .detach();
            return;
        }

        let Some(turn) = chat_model::running_turn(&self.store.read(cx).state, session_id) else {
            return;
        };
        let input = p::CancelTurnIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
            turn_id: turn.id.clone(),
        };
        let request = self.client.call::<api::CancelTurn>(input);
        cx.spawn(async move |this, cx| {
            if let Err(error) = request.await {
                let _ = this.update(cx, |this, cx| {
                    this.toast_error(&error, cx);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn toggle_plan(&mut self, session_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let state = &self.store.read(cx).state;
        let Some(session) = state.sessions.get(session_id) else {
            return;
        };
        if matches!(
            session.status,
            p::SessionStatus::Closed | p::SessionStatus::Starting
        ) || chat_model::running_turn(state, session_id).is_some()
        {
            return;
        }
        let Some(mode_id) = chat_model::plan_target(
            session,
            self.previous_mode.get(session_id).map(String::as_str),
        ) else {
            return;
        };
        if let Some(previous) = &session.mode_id {
            self.previous_mode
                .insert(session_id.into(), previous.clone());
        }
        self.configure(session_id, None, &mode_id, window, cx);
    }

    fn configure(
        &mut self,
        session_id: &str,
        config_id: Option<&String>,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(chat) = self.chats.get(session_id) else {
            return;
        };
        let composer = chat.composer.read(cx);
        if composer.read_only || composer.working || composer.starting || composer.configuring {
            return;
        }
        chat.composer.update(cx, |c, cx| {
            c.configuring = true;
            cx.notify();
        });
        let client = self.client.clone();
        let workspace_id = self.store.read(cx).workspace_id.clone();
        let session_id = session_id.to_string();
        let config_id = config_id.cloned();
        let value = value.to_string();
        cx.spawn_in(window, async move |this, cx| {
            let result = if let Some(config_id) = config_id {
                client
                    .call::<api::SetSessionConfig>(p::SetSessionConfigIn {
                        workspace_id,
                        session_id: session_id.clone(),
                        config_id,
                        value: p::SetSessionConfigInValue::String(value),
                    })
                    .await
            } else {
                client
                    .call::<api::SetSessionMode>(p::SetSessionModeIn {
                        workspace_id,
                        session_id: session_id.clone(),
                        mode_id: value,
                    })
                    .await
            };
            let _ = this.update_in(cx, |this, window, cx| {
                if let Some(chat) = this.chats.get(&session_id) {
                    chat.composer.update(cx, |c, _| c.configuring = false);
                }
                if let Err(error) = result {
                    this.toast_error(&error, cx);
                }
                this.sync(window, cx);
            });
        })
        .detach();
    }

    pub fn close_chat(&mut self, session_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing.is_some() {
            return;
        }
        let Some(session) = self.store.read(cx).state.sessions.get(session_id) else {
            return;
        };
        if session.status == p::SessionStatus::Closed {
            self.viewing_closed.retain(|id| id != session_id);
            self.sync(window, cx);
            return;
        }
        if chat_model::running_turn(&self.store.read(cx).state, session_id).is_some() {
            let weak = cx.weak_entity();
            let session_id = session_id.to_string();
            window.open_alert_dialog(cx, move |alert, _, _| {
                let weak = weak.clone();
                let id = session_id.clone();
                alert
                    .title("Stop the agent and close this chat?")
                    .confirm()
                    .ok_text("Stop and close")
                    .ok_variant(ButtonVariant::Danger)
                    .on_ok(move |_, window, cx| {
                        let _ = weak.update(cx, |this, cx| this.confirm_close(&id, window, cx));
                        true
                    })
            });
        } else {
            self.finish_close(session_id, window, cx);
        }
    }

    fn confirm_close(&mut self, session_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(turn) = chat_model::running_turn(&self.store.read(cx).state, session_id) else {
            self.finish_close(session_id, window, cx);
            return;
        };
        if self.closing.is_some() {
            return;
        }
        let request = self.client.call::<api::CancelTurn>(p::CancelTurnIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
            turn_id: turn.id.clone(),
        });
        self.closing = Some(session_id.into());
        self.close_request = true;
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.close_request = false;
                if let Err(error) = result
                    && error.code() != Some(p::ErrorCode::TurnNotActive)
                {
                    this.closing = None;
                    this.toast_error(&error, cx);
                    cx.notify();
                    return;
                }
                this.close_timeout = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_secs(30))
                        .await;
                    let _ = this.update(cx, |this, cx| {
                        this.closing = None;
                        this.toast(
                            "closing".into(),
                            "The agent is still stopping. Try closing the chat again.".into(),
                            cx,
                        );
                        cx.notify();
                    });
                }));
                this.sync(window, cx);
            });
        })
        .detach();
        cx.notify();
    }

    fn finish_close(&mut self, session_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.close_timeout = None;
        self.closing = Some(session_id.into());
        self.close_request = true;
        let id = session_id.to_string();
        let request = self.client.call::<api::CloseSession>(p::CloseSessionIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
            session_id: id.clone(),
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.closing = None;
                this.close_request = false;
                match result {
                    Ok(_) => this.store.update(cx, |store, cx| {
                        if let Some(session) = store.state.sessions.get_mut(&id) {
                            session.status = p::SessionStatus::Closed;
                        }
                        cx.notify();
                    }),
                    Err(error) => this.toast_error(&error, cx),
                }
                this.sync(window, cx);
            });
        })
        .detach();
        cx.notify();
    }

    pub fn expand_tools(&self, cx: &mut Context<Self>) {
        if let Some(chat) = self.active.as_ref().and_then(|id| self.chats.get(id)) {
            chat.transcript.update(cx, |t, cx| t.toggle_tools(cx));
        }
    }

    fn respond_permission(&mut self, request_id: &str, option_id: &str, cx: &mut Context<Self>) {
        if !self.pending_permissions.insert(request_id.into()) {
            return;
        }
        let request = self
            .client
            .call::<api::RespondPermission>(p::RespondPermissionIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
                request_id: request_id.into(),
                option_id: option_id.into(),
            });
        let request_id = request_id.to_string();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending_permissions.remove(&request_id);
                if let Err(error) = result {
                    this.toast_error(&error, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn restore(&mut self, cx: &mut Context<Self>) {
        let request = self
            .client
            .call::<api::RestoreWorkspace>(p::RestoreWorkspaceIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
            });
        cx.spawn(async move |this, cx| {
            if let Err(error) = request.await {
                let _ = this.update(cx, |this, cx| {
                    this.toast_error(&error, cx);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub fn open_new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .is_some_and(|w| {
                matches!(
                    w.state,
                    p::WorkspaceState::Archived | p::WorkspaceState::Archiving
                )
            })
        {
            return;
        }
        if self
            .new_chat_dialog
            .as_ref()
            .is_some_and(|dialog| dialog.read(cx).kind.is_some())
        {
            return;
        }
        let dialogs = cx.new(|cx| super::dialogs::Dialogs::new(window, cx));
        let workspace_id = self.store.read(cx).workspace_id.clone();
        let agent = self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .map(|w| w.settings.agent.default)
            .unwrap_or(p::AgentId::Claude);
        let client = self.client.clone();
        let weak = cx.weak_entity();
        dialogs.update(cx, |dialog, cx| {
            dialog.show_chat(
                client,
                workspace_id,
                agent,
                move |session, window, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.activate_created_chat(session, window, cx)
                    });
                },
                window,
                cx,
            )
        });
        self.new_chat_dialog = Some(dialogs);
        cx.notify();
    }

    fn activate_created_chat(
        &mut self,
        session: p::Session,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active = Some(session.id.clone());
        self.store.update(cx, |store, cx| {
            if !store.state.sessions.contains_key(&session.id) {
                store
                    .state
                    .apply(p::WorkspaceServerMessage::Session(p::WsSession {
                        type_: p::WsSessionType::Session,
                        session,
                    }));
            }
            cx.notify();
        });
        self.sync(window, cx);
        self.focus_composer(window, cx);
        cx.notify();
    }

    pub fn close_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.review.read(cx).document_open {
            self.review.update(cx, |r, cx| {
                r.close_document(cx);
            });
            cx.notify();
            return;
        }
        if let Some(id) = self.active.clone() {
            self.close_chat(&id, window, cx);
        }
    }

    pub fn focus_model(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(chat) = self.active.as_ref().and_then(|id| self.chats.get(id)) {
            chat.composer.update(cx, |c, cx| c.focus_model(window, cx));
        }
    }
}

impl Render for WorkspaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let store = self.store.read(cx);
        if store.not_found {
            return div().p_4().child("Not found.").into_any_element();
        }
        if !store.state.ready {
            let reconnecting = store
                .connection
                .shows_reconnecting_bar(std::time::Instant::now());
            let error = store.error.clone();
            let retry = error.is_some() || reconnecting;
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .p_6()
                .child(
                    v_flex()
                        .id("workspace-loading")
                        .role(if error.is_some() {
                            Role::Alert
                        } else {
                            Role::Status
                        })
                        .aria_label(if retry {
                            "Workspace connection failed"
                        } else {
                            "Loading workspace"
                        })
                        .test_support()
                        .w_full()
                        .max_w(gpui_kit::px(480.))
                        .gap_3()
                        .child(
                            h_flex()
                                .gap_2()
                                .children((!retry).then(|| Spinner::new().small()))
                                .child(div().font_weight(gpui_kit::FontWeight::MEDIUM).child(
                                    if error.is_some() {
                                        "Could not load workspace."
                                    } else if retry {
                                        "Reconnecting…"
                                    } else {
                                        "Loading workspace…"
                                    },
                                )),
                        )
                        .children(error.map(|message| {
                            div()
                                .text_color(color(Token::Destructive, cx))
                                .child(message)
                        }))
                        .children((!retry).then(|| super::skeleton_rows(5)))
                        .children(retry.then(|| {
                            Button::new("retry-workspace")
                                .outline()
                                .label("Retry")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    let client = this.client.clone();
                                    this.store.update(cx, |store, cx| store.retry(&client, cx));
                                }))
                        })),
                )
                .into_any_element();
        }
        let ids = self.tab_ids(cx);
        let selected = self
            .active
            .as_ref()
            .and_then(|id| ids.iter().position(|s| s == id))
            .unwrap_or(0);
        let titles: Vec<_> = ids
            .iter()
            .filter_map(|id| store.state.sessions.get(id))
            .map(|s| {
                (
                    s.run_id
                        .as_ref()
                        .and_then(|id| self.store.read(cx).state.runs.get(id))
                        .map(|run| format!("{} · {}", run.name, run.status))
                        .unwrap_or_else(|| chat_model::session_title(s)),
                    chat_model::session_tooltip(s),
                )
            })
            .collect();
        let closed: Vec<_> = chat_model::sessions(&store.state, true)
            .into_iter()
            .map(|s| (s.id.clone(), chat_model::session_title(s)))
            .collect();
        let reconnecting = store
            .connection
            .shows_reconnecting_bar(std::time::Instant::now());
        let banners = store
            .state
            .workspace
            .as_ref()
            .map(chat_model::workspace_banners)
            .unwrap_or_default();
        let login = self
            .active
            .as_ref()
            .and_then(|id| store.state.sessions.get(id))
            .and_then(|session| {
                chat_model::login_banner(
                    session.agent,
                    self.credentials.as_ref(),
                    &store.state.credential_invalid,
                )
            })
            .map(|(_, text)| text);
        let plan = self
            .active
            .as_ref()
            .and_then(|id| chat_model::running_plan(&store.state, id));
        let archived = store.state.workspace.as_ref().is_some_and(|w| {
            matches!(
                w.state,
                p::WorkspaceState::Archived | p::WorkspaceState::Archiving
            )
        });
        let new_chat = Button::new("new-chat")
            .ghost()
            .small()
            .icon(gpui_kit::assets::IconName::Plus)
            .accessibility_label("New chat")
            .tooltip("New chat (⌘T)")
            .disabled(archived)
            .on_click(cx.listener(|this, _, window, cx| this.open_new_chat(window, cx)));
        let weak = cx.weak_entity();
        let has_closed = !closed.is_empty();
        let closed_menu = Button::new("closed-chat-menu")
            .ghost()
            .small()
            .label(format!("Closed chats ({})", closed.len()))
            .tooltip("Closed chats in this workspace")
            .disabled(closed.is_empty())
            .dropdown_menu(move |menu, _, _| {
                closed.iter().fold(menu, |menu, (id, title)| {
                    let weak = weak.clone();
                    let id = id.clone();
                    menu.item(
                        PopupMenuItem::new(title.clone()).on_click(move |_, window, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                if !this.viewing_closed.contains(&id) {
                                    this.viewing_closed.push(id.clone());
                                }
                                this.active = Some(id.clone());
                                this.sync(window, cx);
                            });
                        }),
                    )
                })
            });
        let chat = self.active.as_ref().and_then(|id| self.chats.get(id));
        let queued: Vec<_> = self
            .active
            .as_ref()
            .into_iter()
            .flat_map(|id| chat_model::queued_turns(&self.store.read(cx).state, id))
            .map(|turn| {
                (
                    turn.id.clone(),
                    turn.prompt.text.clone(),
                    turn.steering_pending == Some(true),
                )
            })
            .collect();
        let content = if let Some(chat) = chat {
            let has_queue = !queued.is_empty();
            v_flex()
                .size_full()
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        // The list and message row contribute 16 pt more than the composer.
                        .px(gpui_kit::px((self.chat_inset - 16.).max(0.)))
                        .child(chat.transcript.clone()),
                )
                .children(has_queue.then(|| {
                    v_flex()
                        .id("queued-messages")
                        .role(Role::List)
                        .aria_label("Queued messages")
                        .children(queued.into_iter().map(|(id, text, pending)| {
                            let edit_id = id.clone();
                            let delete_id = id.clone();
                            let before = id.clone();
                            let drag = QueuedDrag {
                                workspace_id: self.store.read(cx).workspace_id.clone(),
                                turn_id: id.clone(),
                                text: text.clone(),
                            };
                            let read_only = chat.composer.read(cx).read_only || pending;
                            let status = if pending { "Sending now" } else { "Queued" };
                            h_flex()
                                .id(SharedString::from(format!("queued-{id}")))
                                .role(Role::ListItem)
                                .aria_label(format!("{status}: {text}"))
                                .px_3()
                                .py_1()
                                .text_color(color(Token::MutedForeground, cx))
                                .child(format!("{status}: {text}"))
                                .child(
                                    Button::new(SharedString::from(format!("edit-{id}")))
                                        .label("Edit")
                                        .disabled(read_only || self.queue_pending)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.edit_queue(&edit_id, window, cx)
                                        })),
                                )
                                .child(
                                    Button::new(SharedString::from(format!("delete-{id}")))
                                        .label("Delete")
                                        .disabled(read_only || self.queue_pending)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.delete_queue(&delete_id, cx)
                                        })),
                                )
                                .on_drag(drag, |drag: &QueuedDrag, _, _, cx| {
                                    cx.new(|_| drag.clone())
                                })
                                .on_drop(cx.listener(move |this, drag: &QueuedDrag, _, cx| {
                                    if !read_only {
                                        this.move_queue(drag, &before, cx);
                                    }
                                }))
                        }))
                }))
                .children(self.queue_editor.as_ref().map(|editor| {
                    v_flex()
                        .p_3()
                        .child(Textarea::new(&editor.input).disabled(self.queue_pending))
                        .child(
                            h_flex()
                                .child(
                                    Button::new("save-queue-edit")
                                        .label("Save queued message")
                                        .disabled(self.queue_pending)
                                        .on_click(
                                            cx.listener(|this, _, _, cx| this.save_queue(cx)),
                                        ),
                                )
                                .child(
                                    Button::new("cancel-queue-edit")
                                        .label("Cancel")
                                        .disabled(self.queue_pending)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.queue_editor = None;
                                            cx.notify();
                                        })),
                                ),
                        )
                }))
                .child(if archived {
                    div()
                        .p_3()
                        .child(
                            Button::new("restore-workspace")
                                .label("Restore to continue")
                                .on_click(cx.listener(|this, _, _, cx| this.restore(cx))),
                        )
                        .into_any_element()
                } else if chat.composer.read(cx).read_only {
                    div().p_3().child("This chat is closed.").into_any_element()
                } else {
                    v_flex()
                        .children(self.store.read(cx).state.workspace.as_ref().and_then(|w| {
                            super::environments::proposal_banner(w, &self.client, cx)
                        }))
                        .children(login.map(|text| {
                            h_flex()
                                .id("login-banner")
                                .role(Role::Alert)
                                .aria_label(text.clone())
                                .px_3()
                                .py_1()
                                .gap_2()
                                .border_t_1()
                                .border_color(color(Token::Border, cx))
                                .child(div().flex_1().min_w_0().child(text))
                                .child(
                                    Button::new("add-login")
                                        .label("Add login")
                                        .on_click(|_, _, cx| super::settings::open_logins(cx)),
                                )
                        }))
                        .children(plan.map(|(done, total)| {
                            let label = format!("Plan {done}/{total}");
                            div()
                                .id("plan-progress")
                                .role(Role::Status)
                                .aria_label(label.clone())
                                .mx_3()
                                .mt_1()
                                .px_1p5()
                                .rounded_md()
                                .text_xs()
                                .text_color(color(Token::Primary, cx))
                                .child(label)
                        }))
                        .child(
                            div()
                                .px(gpui_kit::px(self.chat_inset))
                                .child(chat.composer.clone()),
                        )
                        .into_any_element()
                })
                .into_any_element()
        } else {
            div()
                .p_4()
                .child("Start a new chat to work in this workspace.")
                .into_any_element()
        };
        let _ = window;
        let tab_ids = ids.clone();
        v_flex()
            .key_context(crate::keymap::WORKSPACE)
            .size_full()
            .on_action(cx.listener(
                |this, action: &super::chat::OpenWorkspaceFileAt, window, cx| {
                    this.review.update(cx, |r, cx| {
                        r.open_file_at(action.path.to_string(), action.line, window, cx)
                    })
                },
            ))
            .on_action(cx.listener(
                |this, action: &super::chat::OpenWorkspaceFile, window, cx| {
                    this.review
                        .update(cx, |r, cx| r.open_file(action.0.to_string(), window, cx));
                },
            ))
            .on_action(cx.listener(|this, _: &ShowDiff, window, cx| {
                this.reveal_right(cx);
                this.show_diff(window, cx)
            }))
            .on_action(cx.listener(|this, _: &OpenFile, _, cx| {
                this.reveal_right(cx);
                this.review.update(cx, |r, cx| r.open_picker(cx))
            }))
            .on_action(cx.listener(|this, _: &SearchFiles, _, cx| {
                this.reveal_right(cx);
                this.review.update(cx, |r, cx| r.open_picker(cx))
            }))
            .on_action(cx.listener(|this, _: &ToggleDiffScope, window, cx| {
                this.reveal_right(cx);
                this.review.update(cx, |r, cx| r.toggle_scope(window, cx))
            }))
            .on_action(cx.listener(|this, _: &NextFile, window, cx| {
                this.reveal_right(cx);
                this.review.update(cx, |r, cx| r.navigate(true, window, cx))
            }))
            .on_action(cx.listener(|this, _: &PreviousFile, window, cx| {
                this.reveal_right(cx);
                this.review
                    .update(cx, |r, cx| r.navigate(false, window, cx))
            }))
            .on_action(cx.listener(|this, _: &super::chat::ShowChanges, _, cx| {
                this.reveal_right(cx);
                this.review.update(cx, |r, cx| r.show_changes(cx))
            }))
            .on_action(cx.listener(|this, _: &ToggleRun, _, cx| {
                this.reveal_right(cx);
                this.processes.update(cx, |p, cx| p.toggle_default_run(cx))
            }))
            .on_action(cx.listener(|this, _: &CommitAndPush, window, cx| {
                this.reveal_right(cx);
                this.review.update(cx, |r, cx| r.request_commit(window, cx))
            }))
            .child(self.top_bar(cx))
            .on_action(
                cx.listener(|this, _: &CreatePr, window, cx| {
                    this.operation("Create PR", window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &Merge, window, cx| this.operation("Merge", window, cx)),
            )
            .on_action(cx.listener(|this, _: &Archive, _, cx| this.archive(cx)))
            .on_action(
                cx.listener(|this, _: &NextTab, window, cx| this.cycle_tab(true, window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &PreviousTab, window, cx| this.cycle_tab(false, window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &FocusComposer, window, cx| this.focus_composer(window, cx)),
            )
            .on_action(cx.listener(|this, _: &StopTurn, _, cx| {
                if let Some(id) = this.active.clone() {
                    this.stop(&id, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| this.close_active(window, cx)))
            .on_action(cx.listener(|this, _: &NewChat, window, cx| this.open_new_chat(window, cx)))
            .on_action(
                cx.listener(|this, _: &ModelPicker, window, cx| this.focus_model(window, cx)),
            )
            .on_action(cx.listener(|this, _: &ExpandAllToolCalls, _, cx| this.expand_tools(cx)))
            .children(reconnecting.then(|| {
                div()
                    .px_3()
                    .py_2()
                    .text_color(color(Token::Warning, cx))
                    .child("Reconnecting…")
            }))
            .children(
                banners
                    .into_iter()
                    .map(|banner| self.render_banner(banner, cx)),
            )
            .child(
                h_flex()
                    .bg(color(Token::Panel, cx))
                    .pl_3()
                    .pr_2()
                    .border_b_1()
                    .border_color(color(Token::Border, cx))
                    .child(
                        TabBar::new("chat-tabs")
                            .underline()
                            .menu(true)
                            .max_width(gpui_kit::px(220.))
                            .flex_1()
                            .min_w_0()
                            .selected_index(selected)
                            .on_click(cx.listener(move |this, ix: &usize, window, cx| {
                                if let Some(id) = ids.get(*ix) {
                                    this.active = Some(id.clone());
                                    this.sync(window, cx);
                                }
                            }))
                            .children(titles.into_iter().zip(tab_ids).map(
                                |((title, about), id)| {
                                    let button_id = SharedString::from(format!("close-chat-{id}"));
                                    let tab = Tab::new().label(SharedString::from(title));
                                    let tab = match about {
                                        Some(about) => {
                                            let tip = SharedString::from(about);
                                            tab.aria_label(tip.clone()).tooltip(
                                                move |window, cx| {
                                                    Tooltip::new(tip.clone()).build(window, cx)
                                                },
                                            )
                                        }
                                        None => tab,
                                    };
                                    tab.suffix(
                                        Button::new(button_id)
                                            .ghost()
                                            .small()
                                            .icon(gpui_kit::assets::IconName::X)
                                            .accessibility_label("Close chat")
                                            .tooltip("Close chat")
                                            .disabled(self.closing.is_some())
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                cx.stop_propagation();
                                                this.close_chat(&id, window, cx);
                                            })),
                                    )
                                },
                            )),
                    )
                    .child(new_chat)
                    .children(has_closed.then_some(closed_menu)),
            )
            .child(div().flex_1().min_h_0().child(content))
            .into_any_element()
    }
}

const TOO_LARGE: &str = "Each attachment must be at most 10 MiB.";
/// 04, Confirmations: Reset preview access.
const RESET_PREVIEW_CONFIRM: &str = "Open previews will stop working. Open them again from Tempo.";

/// The toast text for a failed server function, as the web `errorText`: the server's message,
/// else the error table's.
pub fn api_error_message(error: &tempo_client::ApiError, agent: Option<p::AgentId>) -> String {
    match error {
        tempo_client::ApiError::Server { error, .. } if !error.message.trim().is_empty() => {
            error.message.clone()
        }
        tempo_client::ApiError::Server { error, .. } => {
            crate::errors::error_message(&error.code.to_string(), agent)
        }
        tempo_client::ApiError::TooLarge { .. } => TOO_LARGE.into(),
        _ => crate::errors::error_message("INTERNAL", None),
    }
}

fn transcript_detail(cx: &gpui_kit::App) -> chat_model::TranscriptDetail {
    cx.global::<crate::storage::Local>()
        .config()
        .transcript_detail
}

pub fn right_starts_closed(state: p::WorkspaceState, has_changes: bool, has_pr: bool) -> bool {
    state == p::WorkspaceState::Sleeping || (!has_changes && !has_pr)
}

fn attachment_mime(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "md" | "rs" | "ts" | "js" => "text/plain",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AnyWindowHandle, TestAppContext, test::TestWindowExt as _};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};

    struct LocalServer {
        url: String,
        requests: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
        /// What getBrowserLiveView returns as `url`.
        live_view: Arc<Mutex<Option<String>>>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl LocalServer {
        fn new(turn: &p::Turn, fail: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let log = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let live_view = Arc::new(Mutex::new(Some(LIVE_VIEW_LINK.to_string())));
            let live = live_view.clone();
            let response = serde_json::to_string(turn).unwrap();
            let worker = std::thread::spawn(move || {
                while !stopping.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let head_end = loop {
                        let mut chunk = [0; 4096];
                        let Ok(n) = stream.read(&mut chunk) else {
                            break None;
                        };
                        if n == 0 {
                            break None;
                        }
                        bytes.extend_from_slice(&chunk[..n]);
                        if let Some(ix) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                            break Some(ix + 4);
                        }
                    };
                    let Some(head_end) = head_end else {
                        continue;
                    };
                    let header = String::from_utf8_lossy(&bytes[..head_end]);
                    let path = header.split_whitespace().nth(1).unwrap().to_string();
                    let len = header
                        .lines()
                        .filter_map(|l| l.split_once(':'))
                        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    while bytes.len() < head_end + len {
                        let mut chunk = [0; 4096];
                        let n = stream.read(&mut chunk).unwrap();
                        if n == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&chunk[..n]);
                    }
                    let input = serde_json::from_slice(&bytes[head_end..])
                        .unwrap_or(serde_json::Value::Null);
                    log.lock().unwrap().push((path.clone(), input.clone()));
                    let (status, body) = if fail
                        && [
                            "/setSessionMode",
                            "/setSessionConfig",
                            "/closeSession",
                            "/cancelTurn",
                        ]
                        .iter()
                        .any(|name| path.ends_with(name))
                    {
                        (
                            500,
                            r#"{"code":"INTERNAL","message":"Could not update the chat."}"#.into(),
                        )
                    } else if path.ends_with("/editQueuedTurn") {
                        let mut turn: serde_json::Value = serde_json::from_str(&response).unwrap();
                        turn["prompt"]["text"] = input["text"].clone();
                        (200, turn.to_string())
                    } else if path.ends_with("/sendPrompt") {
                        if fail {
                            (
                                500,
                                r#"{"code":"INTERNAL","message":"Could not send."}"#.to_string(),
                            )
                        } else {
                            (200, response.clone())
                        }
                    } else if path.contains("/attachments/") {
                        (200, "fake png bytes".into())
                    } else if path.ends_with("/listBranches") {
                        (
                            200,
                            r#"[{"name":"main"},{"name":"release"},{"name":"feature/own"}]"#.into(),
                        )
                    } else if fail && path.ends_with("/setBaseBranch") {
                        (
                            409,
                            r#"{"code":"PR_EXISTS","message":"A pull request already exists."}"#
                                .into(),
                        )
                    } else if path.ends_with("/openPreview") {
                        if fail {
                            (404, r#"{"code":"NOT_FOUND","message":"Not found."}"#.into())
                        } else {
                            (200, format!(r#"{{"url":"{PREVIEW_LINK}"}}"#))
                        }
                    } else if path.ends_with("/getBrowserLiveView") {
                        if fail {
                            (404, r#"{"code":"NOT_FOUND","message":"Not found."}"#.into())
                        } else {
                            (
                                200,
                                serde_json::json!({"url": *live.lock().unwrap()}).to_string(),
                            )
                        }
                    } else if path.ends_with("/getCredentialStatus") {
                        (200,r#"{"claude":{"set":true,"updatedAt":null},"anthropic":{"set":true,"updatedAt":null},"openai":{"set":true,"updatedAt":null},"openrouter":{"set":true,"updatedAt":null},"codex":{"set":true,"updatedAt":null,"lastRefresh":null}}"#.into())
                    } else if path.ends_with("/listFiles") {
                        (200, r#"{"paths":["README.md"]}"#.into())
                    } else if path.ends_with("/readFile") {
                        (
                            200,
                            r#"{"content":"cached contents","encoding":"utf8","size":15}"#.into(),
                        )
                    } else {
                        (200, "{}".into())
                    };
                    let content_type = if path.contains("/attachments/") {
                        "image/png"
                    } else {
                        "application/json"
                    };
                    let reply = format!(
                        "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes());
                }
            });
            Self {
                url,
                requests,
                live_view,
                stop,
                worker: Some(worker),
            }
        }
    }
    impl Drop for LocalServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }
    const PREVIEW_LINK: &str = "https://3000-01k7000000000000000000000b.example-previews.com/__tempo/enter?code=k3j9x2m4q8w7e5r1a6s5d4f3g2h1j0k9";
    const LIVE_VIEW_LINK: &str =
        "https://live.example-browser.com/devtools/inspector.html?wss=session&jwt=live-view-token";
    #[test]
    fn right_side_starts_closed_while_sleeping_or_quiet() {
        use p::WorkspaceState::{Ready, Sleeping};
        assert!(super::right_starts_closed(Sleeping, true, true));
        assert!(super::right_starts_closed(Ready, false, false));
        assert!(!super::right_starts_closed(Ready, true, false));
        assert!(!super::right_starts_closed(Ready, false, true));
    }

    fn fixture() -> tempo_client::state::workspace::WorkspaceState {
        let mut state = tempo_client::state::workspace::WorkspaceState::new();
        for line in include_str!(
            "../../../../packages/protocol/fixtures/channel/workspace-first-load.jsonl"
        )
        .lines()
        {
            state.apply(serde_json::from_str(line).unwrap());
        }
        state
    }
    fn mount(
        cx: &mut TestAppContext,
        state: tempo_client::state::workspace::WorkspaceState,
        client: Client,
    ) -> (AnyWindowHandle, Entity<WorkspaceView>) {
        cx.background_executor.allow_parking();
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::keymap::bind(cx);
            cx.set_global(crate::storage::Local::load(None));
            let store = cx.new(|_| {
                let mut store = WorkspaceStore::new(state.workspace.as_ref().unwrap().id.clone());
                store.state = state;
                store
            });
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| WorkspaceView::new(store, client, window, cx))
            })
            .unwrap()
        })
    }
    fn wait_sent(cx: &mut TestAppContext, view: &Entity<WorkspaceView>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if view.read_with(cx, |view, cx| {
                view.active
                    .as_ref()
                    .and_then(|id| view.chats.get(id))
                    .is_some_and(|chat| !chat.composer.read(cx).sending)
            }) {
                return;
            }
            assert!(Instant::now() < deadline, "send did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[gpui_kit::test]
    fn initial_connection_failure_offers_retry_and_hello_removes_loading(cx: &mut TestAppContext) {
        use gpui_kit::test::TestWindowExt as _;
        let mut state = fixture();
        state.ready = false;
        let runtime = tempo_client::Runtime::start().unwrap();
        let client =
            tempo_client::Server::new(&runtime.handle(), "http://127.0.0.1:9", crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
        let (handle, view) = mount(cx, state, client);
        let store = view.read_with(cx, |view, _| view.store.clone());
        store.update(cx, |store, cx| {
            store.connection =
                crate::stores::Connection::Down(Instant::now() - Duration::from_secs(3));
            cx.notify();
        });
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(
                window.find("workspace-loading").role(),
                Some(gpui_kit::Role::Status)
            );
            assert!(window.try_find("retry-workspace").is_some());
            window.click("retry-workspace", cx);
        })
        .unwrap();
        cx.run_until_parked();
        store.read_with(cx, |store, _| assert!(store.error.is_none()));
        store.update(cx, |store, cx| {
            store.state = fixture();
            cx.notify();
        });
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("workspace-loading").is_none());
        })
        .unwrap();
        view.read_with(cx, |view, _| assert!(view.active.is_some()));
    }

    fn toasts(cx: &mut TestAppContext, window: AnyWindowHandle) -> usize {
        cx.run_until_parked();
        cx.update_window(window, |_, window, cx| window.notifications(cx).len())
            .unwrap()
    }

    fn wait_queue(cx: &mut TestAppContext, view: &Entity<WorkspaceView>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if !view.read_with(cx, |v, _| v.queue_pending) {
                return;
            }
            assert!(Instant::now() < deadline, "queue update did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_until(
        cx: &mut TestAppContext,
        view: &Entity<WorkspaceView>,
        done: impl Fn(&WorkspaceView, &gpui_kit::App) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if view.read_with(cx, |view, cx| done(view, cx)) {
                return;
            }
            assert!(Instant::now() < deadline, "chat action did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn toast_text_is_the_server_message_or_the_error_table() {
        let server = |code, message: &str| tempo_client::ApiError::Server {
            status: 409,
            error: p::ErrorBody {
                code,
                message: message.into(),
                detail: Some("internal detail".into()),
            },
        };
        assert_eq!(
            api_error_message(
                &server(p::ErrorCode::PrExists, "A pull request already exists."),
                None
            ),
            "A pull request already exists."
        );
        assert_eq!(
            api_error_message(
                &server(p::ErrorCode::CredentialMissing, ""),
                Some(p::AgentId::Codex)
            ),
            "Add your Codex login in Settings."
        );
        assert_eq!(
            api_error_message(&tempo_client::ApiError::Http { status: 502 }, None),
            "Something went wrong."
        );
        assert_eq!(
            api_error_message(&tempo_client::ApiError::TooLarge { size: 1 << 30 }, None),
            TOO_LARGE
        );
    }

    #[gpui_kit::test]
    fn transcript_loads_image_attachments_from_the_attachment_route(cx: &mut TestAppContext) {
        let mut state = fixture();
        let session = chat_model::sessions(&state, false)[0].id.clone();
        let item = state
            .items
            .values_mut()
            .find(|item| {
                item.session_id == session && matches!(item.content, p::ItemContent::UserMessage(_))
            })
            .unwrap();
        let p::ItemContent::UserMessage(message) = &mut item.content else {
            unreachable!()
        };
        message.attachments = vec![
            p::UserMessageContentAttachmentsItem {
                id: "att-png".into(),
                mime: "image/png".into(),
                name: "design.png".into(),
            },
            p::UserMessageContentAttachmentsItem {
                id: "att-pdf".into(),
                mime: "application/pdf".into(),
                name: "spec.pdf".into(),
            },
        ];
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (_window, view) = mount(cx, state, client);
        wait_until(cx, &view, |view, cx| {
            view.chats[&session]
                .transcript
                .read(cx)
                .has_thumbnail("att-png")
        });
        let requests = server.requests.lock().unwrap();
        let paths: Vec<_> = requests
            .iter()
            .map(|(path, _)| path.as_str())
            .filter(|path| path.contains("/attachments/"))
            .collect();
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("/attachments/att-png"));
    }

    #[gpui_kit::test]
    fn base_branch_picker_lists_other_branches_and_sets_the_pick(cx: &mut TestAppContext) {
        for fail in [false, true] {
            let mut state = fixture();
            state.workspace.as_mut().unwrap().pr_number = None;
            state.workspace.as_mut().unwrap().branch = "feature/own".into();
            let turn = state.turns.values().next().unwrap().clone();
            let server = LocalServer::new(&turn, fail);
            let runtime = tempo_client::Runtime::start().unwrap();
            let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
            let (window, view) = mount(cx, state, client);
            cx.update_window(window, |_, window, cx| {
                view.update(cx, |view, cx| view.open_branch_picker(window, cx))
            })
            .unwrap();
            wait_until(cx, &view, |view, _| {
                view.branch_picker
                    .as_ref()
                    .is_some_and(|p| p.branches.is_some())
            });
            view.read_with(cx, |view, _| {
                let branches = view.branch_picker.as_ref().unwrap().branches.clone();
                assert_eq!(branches, Some(Ok(vec!["main".into(), "release".into()])));
            });
            view.update(cx, |view, cx| view.pick_base_branch("release".into(), cx));
            wait_until(cx, &view, |view, _| !view.operation_pending);
            assert!(view.read_with(cx, |view, _| view.branch_picker.is_none()));
            let requests = server.requests.lock().unwrap().clone();
            let list = requests
                .iter()
                .find(|(path, _)| path.ends_with("/listBranches"))
                .unwrap();
            assert!(list.1["projectId"].is_string() && list.1.get("query").is_none());
            let set = requests
                .iter()
                .find(|(path, _)| path.ends_with("/setBaseBranch"))
                .unwrap();
            assert_eq!(set.1["baseBranch"], "release");
            assert_eq!(toasts(cx, window), usize::from(fail));
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
        }
    }

    #[gpui_kit::test]
    fn error_banner_retries_with_wake_and_skips_toasts_for_its_code(cx: &mut TestAppContext) {
        let mut state = fixture();
        let w = state.workspace.as_mut().unwrap();
        w.state = p::WorkspaceState::Error;
        w.error_code = Some("INTERNAL".into());
        w.error_detail = Some("stack".into());
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, true);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                let id = view.store.read(cx).workspace_id.clone();
                view.banner_call::<api::WakeWorkspace>(
                    p::WakeWorkspaceIn { workspace_id: id },
                    false,
                    window,
                    cx,
                );
                let session = view.active.clone().unwrap();
                view.configure(&session, None, "plan", window, cx);
            })
        })
        .unwrap();
        wait_until(cx, &view, |view, cx| {
            !view.banner_pending
                && view
                    .active
                    .as_ref()
                    .is_some_and(|id| !view.chats[id].composer.read(cx).configuring)
        });
        assert!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/wakeWorkspace"))
        );
        assert_eq!(toasts(cx, window), 0, "the banner already shows INTERNAL");
    }

    #[gpui_kit::test]
    fn sleeping_files_use_cached_reads_without_waking(cx: &mut TestAppContext) {
        let mut state = fixture();
        state.workspace.as_mut().unwrap().state = p::WorkspaceState::Sleeping;
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.review.update(cx, |review, cx| {
                    review.open_picker(cx);
                    review.open_file("README.md".into(), window, cx);
                });
            });
        })
        .unwrap();
        wait_until(cx, &view, |view, cx| view.review.read(cx).file.is_some());
        let requests = server.requests.lock().unwrap();
        assert!(
            requests
                .iter()
                .any(|(path, _)| path.ends_with("/listFiles"))
        );
        assert!(requests.iter().any(|(path, _)| path.ends_with("/readFile")));
        assert!(
            !requests
                .iter()
                .any(|(path, _)| path.ends_with("/wakeWorkspace") || path.ends_with("/getChanges"))
        );
    }

    #[gpui_kit::test]
    fn review_reloads_on_state_changes_never_wake_the_workspace(cx: &mut TestAppContext) {
        let mut state = fixture();
        state.workspace.as_mut().unwrap().state = p::WorkspaceState::Ready;
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.review.update(cx, |review, cx| {
                    review.open_picker(cx);
                    review.open_file("README.md".into(), window, cx);
                });
            });
        })
        .unwrap();
        wait_until(cx, &view, |view, cx| view.review.read(cx).file.is_some());
        for next in [
            p::WorkspaceState::Stopping,
            p::WorkspaceState::Sleeping,
            p::WorkspaceState::Error,
            p::WorkspaceState::Starting,
        ] {
            server.requests.lock().unwrap().clear();
            view.update(cx, |view, cx| {
                view.store.update(cx, |store, cx| {
                    let w = store.state.workspace.as_mut().unwrap();
                    w.state = next;
                    w.rev += 1.;
                    cx.notify();
                })
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            while !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/listReviewComments"))
            {
                assert!(
                    Instant::now() < deadline,
                    "{next:?}: the review did not reload"
                );
                cx.run_until_parked();
                std::thread::sleep(Duration::from_millis(5));
            }
            std::thread::sleep(Duration::from_millis(200));
            cx.run_until_parked();
            let requests = server.requests.lock().unwrap();
            let paths: Vec<_> = requests.iter().map(|(path, _)| path.as_str()).collect();
            let waking = [
                "/getChanges",
                "/getFileDiff",
                "/searchFiles",
                "/wakeWorkspace",
            ];
            let cached = ["/listFiles", "/readFile"];
            for path in &paths {
                assert!(
                    !waking.iter().any(|name| path.ends_with(name)),
                    "{next:?}: {path}"
                );
                if next != p::WorkspaceState::Sleeping {
                    assert!(
                        !cached.iter().any(|name| path.ends_with(name)),
                        "{next:?}: {path}"
                    );
                }
            }
            if next == p::WorkspaceState::Sleeping {
                for name in cached {
                    assert!(paths.iter().any(|path| path.ends_with(name)), "{name}");
                }
            }
        }
    }

    #[gpui_kit::test]
    fn closing_a_running_chat_confirms_and_waits_for_turn_end(cx: &mut TestAppContext) {
        let mut state = fixture();
        let id = chat_model::sessions(&state, false)[0].id.clone();
        let mut turn = state.turns.values().next().unwrap().clone();
        turn.session_id = id.clone();
        turn.status = p::TurnStatus::Running;
        state.turns.clear();
        state.turns.insert(turn.id.clone(), turn.clone());
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.focus_composer(window, cx))
        })
        .unwrap();
        cx.update_window(window, |_, window, cx| window.press("cmd-w", cx))
            .unwrap();
        cx.run_until_parked();
        assert!(
            cx.update_window(window, |_, window, cx| window.has_active_dialog(cx))
                .unwrap()
        );
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/cancelTurn") || path.ends_with("/closeSession"))
        );
        cx.update_window(window, |_, window, cx| {
            window.close_dialog(cx);
            view.update(cx, |view, cx| view.confirm_close(&id, window, cx));
        })
        .unwrap();
        wait_until(cx, &view, |view, _| !view.close_request);
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/closeSession"))
        );
        turn.status = p::TurnStatus::Cancelled;
        view.update(cx, |view, cx| {
            view.store.update(cx, |store, cx| {
                store
                    .state
                    .apply(p::WorkspaceServerMessage::Turn(p::WsTurn {
                        type_: p::WsTurnType::Turn,
                        turn,
                    }));
                cx.notify();
            })
        });
        wait_until(cx, &view, |view, _| view.closing.is_none());
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.store.read(cx).state.sessions[&id].status,
                p::SessionStatus::Closed
            )
        });
        let requests = server.requests.lock().unwrap();
        let paths: Vec<_> = requests
            .iter()
            .map(|(path, _)| path.as_str())
            .filter(|p| p.ends_with("/cancelTurn") || p.ends_with("/closeSession"))
            .collect();
        assert_eq!(
            paths,
            ["/api/v1/rpc/cancelTurn", "/api/v1/rpc/closeSession"]
        );
    }

    #[gpui_kit::test]
    fn failed_close_keeps_the_chat_and_failed_config_keeps_the_saved_mode(cx: &mut TestAppContext) {
        let mut state = fixture();
        let id = chat_model::sessions(&state, false)[0].id.clone();
        state.turns.clear();
        let turn = fixture().turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, true);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let old_mode = state.sessions[&id].mode_id.clone();
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.configure(&id, None, "plan", window, cx))
        })
        .unwrap();
        wait_until(cx, &view, |view, cx| {
            !view.chats[&id].composer.read(cx).configuring
        });
        assert_eq!(toasts(cx, window), 1);
        view.read_with(cx, |view, cx| {
            assert_eq!(view.store.read(cx).state.sessions[&id].mode_id, old_mode);
        });
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.close_chat(&id, window, cx))
        })
        .unwrap();
        wait_until(cx, &view, |view, _| view.closing.is_none());
        view.read_with(cx, |view, cx| {
            assert_ne!(
                view.store.read(cx).state.sessions[&id].status,
                p::SessionStatus::Closed
            )
        });
    }

    #[gpui_kit::test]
    fn created_chat_response_keeps_newer_streamed_session_metadata(cx: &mut TestAppContext) {
        let state = fixture();
        let latest = state.sessions.values().next().unwrap().clone();
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        let mut response = latest.clone();
        response.title = "Older creation response".into();
        response.config_options.clear();
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.activate_created_chat(response, window, cx)
            });
        })
        .unwrap();
        view.read_with(cx, |view, cx| {
            assert_eq!(view.store.read(cx).state.sessions[&latest.id], latest);
        });
    }

    #[gpui_kit::test]
    fn chat_keyboard_shortcut_opens_the_composer(cx: &mut TestAppContext) {
        let state = fixture();
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.focus_composer(window, cx))
        })
        .unwrap();
        cx.update_window(window, |_, window, cx| window.press("cmd-t", cx))
            .unwrap();
        cx.run_until_parked();
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.new_chat_dialog.as_ref().unwrap().read(cx).kind,
                Some("New chat")
            )
        });
        cx.update_window(window, |_, window, cx| window.press("escape", cx))
            .unwrap();
        cx.run_until_parked();
        view.read_with(cx, |view, cx| {
            assert!(
                view.new_chat_dialog
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .kind
                    .is_none()
            )
        });
    }

    #[gpui_kit::test]
    fn stopping_timeout_and_cancel_failure_keep_the_chat_open(cx: &mut TestAppContext) {
        for failure in [false, true] {
            let mut state = fixture();
            let id = chat_model::sessions(&state, false)[0].id.clone();
            let mut turn = state.turns.values().next().unwrap().clone();
            turn.session_id = id.clone();
            turn.status = p::TurnStatus::Running;
            state.turns.clear();
            state.turns.insert(turn.id.clone(), turn.clone());
            let server = LocalServer::new(&turn, failure);
            let runtime = tempo_client::Runtime::start().unwrap();
            let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
            let (window, view) = mount(cx, state, client);
            cx.update_window(window, |_, window, cx| {
                view.update(cx, |view, cx| view.confirm_close(&id, window, cx))
            })
            .unwrap();
            wait_until(cx, &view, |view, _| !view.close_request);
            if !failure {
                cx.background_executor
                    .advance_clock(Duration::from_secs(30));
                cx.run_until_parked();
            }
            assert_eq!(toasts(cx, window), 1);
            view.read_with(cx, |view, cx| {
                assert!(view.closing.is_none());
                assert_ne!(
                    view.store.read(cx).state.sessions[&id].status,
                    p::SessionStatus::Closed
                );
            });
            assert!(
                !server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(path, _)| path.ends_with("/closeSession"))
            );
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
        }
    }

    #[gpui_kit::test]
    fn mentions_reach_queue_and_steering_and_survive_send_failure(cx: &mut TestAppContext) {
        for (steer, fail) in [(false, false), (true, false), (false, true)] {
            let mut state = fixture();
            let id = chat_model::sessions(&state, false)[0].id.clone();
            state.sessions.get_mut(&id).unwrap().steering = Some(true);
            let mut turn = state.turns.values().next().unwrap().clone();
            turn.session_id = id.clone();
            turn.status = p::TurnStatus::Running;
            state.turns.clear();
            state.turns.insert(turn.id.clone(), turn.clone());
            let server = LocalServer::new(&turn, fail);
            let runtime = tempo_client::Runtime::start().unwrap();
            let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
            let (window, view) = mount(cx, state, client);
            cx.update_window(window, |_, window, cx| {
                view.update(cx, |view, cx| {
                    view.chats[&id].composer.update(cx, |c, cx| {
                        c.set_text("Check this file", window, cx);
                        c.add_mention("src/main.rs", cx);
                        cx.emit(if steer {
                            ComposerEvent::Steer("Check this file".into())
                        } else {
                            ComposerEvent::Send("Check this file".into())
                        });
                    });
                });
            })
            .unwrap();
            wait_sent(cx, &view);
            view.read_with(cx, |view, cx| {
                let c = view.chats[&id].composer.read(cx);
                assert_eq!(c.text(cx), if fail { "Check this file" } else { "" });
                assert_eq!(c.prompt(&c.text(cx)).mentions.len(), usize::from(fail));
            });
            let requests = server.requests.lock().unwrap();
            let input: p::SendPromptIn = serde_json::from_value(
                requests
                    .iter()
                    .find(|(path, _)| path.ends_with("/sendPrompt"))
                    .unwrap()
                    .1
                    .clone(),
            )
            .unwrap();
            assert_eq!(
                input.mentions,
                vec![p::Mention {
                    path: "src/main.rs".into()
                }]
            );
            assert_eq!(
                input.delivery,
                steer.then_some(p::SendPromptInDelivery::Steer)
            );
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
        }
    }

    #[gpui_kit::test]
    fn branch_editor_sends_the_manual_override(cx: &mut TestAppContext) {
        let mut state = fixture();
        state.workspace.as_mut().unwrap().pushed = false;
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.edit_branch(window, cx);
                view.branch_editor
                    .as_ref()
                    .unwrap()
                    .update(cx, |input, cx| {
                        input.set_value("feature/my-name", window, cx);
                    });
                view.save_branch(cx);
            });
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if !view.read_with(cx, |view, _| view.branch_pending) {
                break;
            }
            assert!(Instant::now() < deadline, "branch rename did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(view.read_with(cx, |view, _| view.branch_editor.is_none()));
        let requests = server.requests.lock().unwrap();
        let (_, input) = requests
            .iter()
            .find(|(path, _)| path.ends_with("/renameBranch"))
            .unwrap();
        assert_eq!(input["branch"], "feature/my-name");
    }

    #[gpui_kit::test]
    fn steering_event_sends_live_delivery_without_cancelling(cx: &mut TestAppContext) {
        let mut state = fixture();
        let session = chat_model::sessions(&state, false)[0].id.clone();
        state.sessions.get_mut(&session).unwrap().steering = Some(true);
        let mut turn = state.turns.values().next().unwrap().clone();
        turn.session_id = session.clone();
        turn.status = p::TurnStatus::Running;
        state.turns.clear();
        state.turns.insert(turn.id.clone(), turn.clone());
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.chats[&session].composer.update(cx, |composer, cx| {
                    assert!(composer.working && composer.steering);
                    composer.set_text("Use the smaller change", window, cx);
                    cx.emit(ComposerEvent::Steer("Use the smaller change".into()));
                });
            })
        })
        .unwrap();
        wait_sent(cx, &view);
        let requests = server.requests.lock().unwrap();
        let prompt = requests
            .iter()
            .find(|(path, _)| path.ends_with("/sendPrompt"))
            .unwrap();
        assert_eq!(prompt.1["delivery"], "steer");
        assert!(
            !requests
                .iter()
                .any(|(path, _)| path.ends_with("/cancelTurn"))
        );
    }

    #[gpui_kit::test]
    fn review_and_attachment_context_survive_failure_and_clear_on_success(cx: &mut TestAppContext) {
        for fail in [true, false] {
            let state = fixture();
            let session = chat_model::sessions(&state, false)[0].id.clone();
            let turn = state.turns.values().next().unwrap().clone();
            let server = LocalServer::new(&turn, fail);
            let runtime = tempo_client::Runtime::start().unwrap();
            let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
            let (window, view) = mount(cx, state, client);
            cx.update_window(window, |_, window, cx| {
                view.update(cx, |view, cx| {
                    view.review.update(cx, |_, cx| {
                        cx.emit(super::super::review::ReviewEvent::Comments(vec![
                            "review-1".into(),
                        ]))
                    });
                    let chat = &view.chats[&session];
                    chat.composer.update(cx, |c, cx| {
                        c.add_attachment("attachment-1".into(), "design.png".into(), cx);
                        c.set_text("Review this", window, cx);
                        cx.emit(ComposerEvent::Send("Review this".into()));
                    });
                })
            })
            .unwrap();
            wait_sent(cx, &view);
            let requests = server.requests.lock().unwrap();
            let prompt = requests
                .iter()
                .find(|(p, _)| p.ends_with("/sendPrompt"))
                .unwrap();
            assert_eq!(
                prompt.1["reviewCommentIds"],
                serde_json::json!(["review-1"])
            );
            assert_eq!(
                prompt.1["attachmentIds"],
                serde_json::json!(["attachment-1"])
            );
            view.read_with(cx, |v, cx| {
                let composer = v.chats[&session].composer.read(cx);
                assert_eq!(v.review_comments.is_empty(), !fail);
                assert_eq!(
                    composer
                        .prompt(&composer.text(cx))
                        .attachment_ids
                        .is_empty(),
                    !fail
                );
            });
        }
    }

    #[gpui_kit::test]
    fn queue_controls_preserve_draft_and_reorder_the_whole_workspace(cx: &mut TestAppContext) {
        let mut state = fixture();
        let session = chat_model::sessions(&state, false)[0].id.clone();
        let mut turn = state.turns.values().next().unwrap().clone();
        turn.session_id = session.clone();
        turn.status = p::TurnStatus::Queued;
        turn.queue_pos = Some(1.0);
        let first = turn.id.clone();
        state.turns.clear();
        state.turns.insert(first.clone(), turn.clone());
        let mut second = turn.clone();
        second.id = "other-chat-queued".into();
        second.session_id = "other-chat".into();
        second.queue_pos = Some(2.0);
        state.turns.insert(second.id.clone(), second.clone());
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.chats[&session]
                    .composer
                    .update(cx, |c, cx| c.set_text("Unsent draft", window, cx));
                view.edit_queue(&first, window, cx);
                view.queue_editor
                    .as_ref()
                    .unwrap()
                    .input
                    .update(cx, |input, cx| {
                        input.set_value("Edited follow up", window, cx)
                    });
                view.save_queue(cx);
            })
        })
        .unwrap();
        wait_queue(cx, &view);
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.chats[&session].composer.read(cx).text(cx),
                "Unsent draft"
            );
            assert_eq!(
                view.store.read(cx).state.turns[&first].prompt.text,
                "Edited follow up"
            );
        });
        view.update(cx, |view, cx| {
            view.move_queue(
                &QueuedDrag {
                    workspace_id: view.store.read(cx).workspace_id.clone(),
                    turn_id: second.id.clone(),
                    text: "".into(),
                },
                &first,
                cx,
            );
        });
        wait_queue(cx, &view);
        let requests = server.requests.lock().unwrap().clone();
        let reorder = requests
            .iter()
            .find(|(path, _)| path.ends_with("/reorderQueue"))
            .unwrap();
        assert_eq!(reorder.1["turnIds"], serde_json::json!([second.id, first]));
        view.update(cx, |view, cx| view.delete_queue(&first, cx));
        wait_queue(cx, &view);
        view.read_with(cx, |view, cx| {
            assert!(!view.store.read(cx).state.turns.contains_key(&first))
        });
    }

    #[gpui_kit::test]
    fn pending_send_keeps_the_next_draft_and_does_not_submit_again(cx: &mut TestAppContext) {
        let state = fixture();
        let session = chat_model::sessions(&state, false)[0].id.clone();
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.chats[&session].composer.update(cx, |c, cx| {
                    c.sending = true;
                    c.set_text("Next draft", window, cx);
                    c.focus(window, cx);
                });
                view.send(&session, "Next draft", window, cx);
            });
            window.render_frame(cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.chats[&session].composer.read(cx).text(cx),
                "Next draft"
            );
            assert!(view.chats[&session].composer.read(cx).sending);
        });
        assert!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .all(|(path, _)| !path.ends_with("/sendPrompt"))
        );
    }

    #[gpui_kit::test]
    fn enter_sends_rpc_and_clears_only_the_confirmed_draft(cx: &mut TestAppContext) {
        let state = fixture();
        let session = chat_model::sessions(&state, false)[0].id.clone();
        let mut turn = state.turns.values().next().unwrap().clone();
        turn.session_id = session.clone();
        turn.status = p::TurnStatus::Queued;
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                let composer = view.chats[&session].composer.clone();
                composer.update(cx, |c, cx| {
                    c.set_text("Keep my text until sent", window, cx);
                    c.focus(window, cx);
                });
            });
            window.render_frame(cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        wait_sent(cx, &view);
        view.read_with(cx, |view, cx| {
            assert_eq!(view.chats[&session].composer.read(cx).text(cx), "")
        });
        let requests = server.requests.lock().unwrap();
        let input = &requests
            .iter()
            .find(|(path, _)| path.ends_with("/sendPrompt"))
            .unwrap()
            .1;
        assert_eq!(input["text"], "Keep my text until sent");
        assert_eq!(input["sessionId"], session);
        assert_eq!(input["mentions"], serde_json::json!([]));
    }

    #[gpui_kit::test]
    fn focused_permission_keys_send_the_first_allow_and_reject_options(cx: &mut TestAppContext) {
        for (key, expected) in [("enter", "allow_once"), ("backspace", "reject_once")] {
            let mut state = fixture();
            let item = state
                .items
                .values_mut()
                .find(|item| matches!(item.content, p::ItemContent::Permission(_)))
                .unwrap();
            item.status = p::ItemStatus::Pending;
            let p::ItemContent::Permission(permission) = &mut item.content else {
                unreachable!()
            };
            permission.chosen_option_id = None;
            let request = p::PermissionRequest {
                request_id: permission.request_id.clone(),
                session_id: item.session_id.clone(),
                turn_id: item.turn_id.clone().unwrap(),
                item_id: item.id.clone(),
                title: permission.title.clone(),
                options: permission.options.clone(),
            };
            state
                .permissions
                .insert(request.request_id.clone(), request.clone());
            let turn = state.turns.get_mut(&request.turn_id).unwrap();
            turn.status = p::TurnStatus::Running;
            turn.ended_at = None;
            let server = LocalServer::new(turn, false);
            let runtime = tempo_client::Runtime::start().unwrap();
            let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
            let (window, view) = mount(cx, state, client);
            cx.update_window(window, |_, window, cx| {
                window.render_frame(cx);
                window.press(key, cx);
            })
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                cx.run_until_parked();
                if let Some((_, input)) = server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(path, _)| path.ends_with("/respondPermission"))
                {
                    assert_eq!(input["requestId"], request.request_id);
                    assert_eq!(input["optionId"], expected);
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "permission key did not send its request"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
            drop(view);
            cx.run_until_parked();
        }
    }

    #[gpui_kit::test]
    fn failed_send_keeps_draft_and_closed_chat_cannot_send(cx: &mut TestAppContext) {
        let state = fixture();
        let session = chat_model::sessions(&state, false)[0].id.clone();
        let turn = state.turns.values().next().unwrap();
        let server = LocalServer::new(turn, true);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.chats[&session]
                    .composer
                    .update(cx, |c, cx| c.set_text("Retry this draft", window, cx));
                view.send(&session, "Retry this draft", window, cx);
            })
        })
        .unwrap();
        wait_sent(cx, &view);
        assert_eq!(toasts(cx, window), 1);
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.chats[&session].composer.read(cx).text(cx),
                "Retry this draft"
            );
        });
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.store.update(cx, |store, cx| {
                    store.state.sessions.get_mut(&session).unwrap().status =
                        p::SessionStatus::Closed;
                    cx.notify();
                });
                view.viewing_closed.push(session.clone());
                view.sync(window, cx);
                view.send(&session, "Must not send", window, cx);
            })
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(path, _)| path.ends_with("/sendPrompt"))
                .count(),
            1
        );
    }

    #[gpui_kit::test]
    fn port_click_opens_the_link_from_open_preview_in_the_default_browser(cx: &mut TestAppContext) {
        for fail in [false, true] {
            let state = fixture();
            let id = state.workspace.as_ref().unwrap().id.clone();
            let turn = state.turns.values().next().unwrap().clone();
            let server = LocalServer::new(&turn, fail);
            let runtime = tempo_client::Runtime::start().unwrap();
            let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
            let (window, view) = mount(cx, state, client);
            view.update(cx, |view, cx| view.open_preview(3000., cx));
            let deadline = Instant::now() + Duration::from_secs(10);
            while !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/openPreview"))
                || (!fail && cx.opened_url().is_none())
            {
                cx.run_until_parked();
                assert!(Instant::now() < deadline, "openPreview did not finish");
                std::thread::sleep(Duration::from_millis(5));
            }
            let requests = server.requests.lock().unwrap().clone();
            let call = requests
                .iter()
                .find(|(path, _)| path.ends_with("/openPreview"))
                .unwrap();
            assert_eq!(
                call.1,
                serde_json::json!({"workspaceId": id, "port": 3000.0})
            );
            if fail {
                assert_eq!(toasts(cx, window), 1);
            } else {
                assert_eq!(cx.opened_url().as_deref(), Some(PREVIEW_LINK));
                assert_eq!(toasts(cx, window), 0);
            }
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
        }
    }

    #[gpui_kit::test]
    fn live_opens_in_the_tool_area_and_reports_request_failures(cx: &mut TestAppContext) {
        assert_eq!(BROWSER_SESSION_ENDED, "Browser session ended.");
        for (fail, link) in [(true, None), (false, None), (false, Some(LIVE_VIEW_LINK))] {
            let mut state = fixture();
            state.workspace.as_mut().unwrap().browser_active = true;
            let id = state.workspace.as_ref().unwrap().id.clone();
            let turn = state.turns.values().next().unwrap().clone();
            let server = LocalServer::new(&turn, fail);
            *server.live_view.lock().unwrap() = link.map(String::from);
            let runtime = tempo_client::Runtime::start().unwrap();
            let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
            let (window, view) = mount(cx, state, client);
            view.update(cx, |view, cx| view.open_live_view(cx));
            let deadline = Instant::now() + Duration::from_secs(10);
            while !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/getBrowserLiveView"))
                || view.read_with(cx, |view, cx| view.tools.read(cx).browser_pending)
            {
                cx.run_until_parked();
                assert!(
                    Instant::now() < deadline,
                    "getBrowserLiveView did not finish"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            let requests = server.requests.lock().unwrap().clone();
            let call = requests
                .iter()
                .find(|(path, _)| path.ends_with("/getBrowserLiveView"))
                .unwrap();
            assert_eq!(call.1, serde_json::json!({"workspaceId": id}));
            assert!(cx.opened_url().is_none());
            assert_eq!(
                view.read_with(cx, |view, cx| view.tools.read(cx).browser_ready()),
                link.is_some()
            );
            assert!(view.read_with(cx, |view, _| view.right_opened));
            assert_eq!(toasts(cx, window), 0);
            if link.is_some() {
                let store = view.read_with(cx, |view, _| view.store.clone());
                store.update(cx, |store, cx| {
                    store.state.workspace.as_mut().unwrap().browser_active = false;
                    cx.notify();
                });
                cx.run_until_parked();
                assert!(!view.read_with(cx, |view, cx| view.tools.read(cx).browser_ready()));
            }
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
        }
    }

    #[gpui_kit::test]
    fn reset_preview_access_confirms_then_rotates_the_key(cx: &mut TestAppContext) {
        assert_eq!(
            RESET_PREVIEW_CONFIRM,
            "Open previews will stop working. Open them again from Tempo."
        );
        let state = fixture();
        let id = state.workspace.as_ref().unwrap().id.clone();
        let turn = state.turns.values().next().unwrap().clone();
        let server = LocalServer::new(&turn, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, state, client);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.operation("Reset preview access", window, cx)
            })
        })
        .unwrap();
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/rotatePreviewKey")),
            "nothing is reset before the confirmation"
        );
        view.update(cx, |view, cx| view.submit_operation(cx));
        wait_until(cx, &view, |view, _| !view.operation_pending);
        let requests = server.requests.lock().unwrap().clone();
        let call = requests
            .iter()
            .find(|(path, _)| path.ends_with("/rotatePreviewKey"))
            .unwrap();
        assert_eq!(call.1, serde_json::json!({"workspaceId": id}));
        assert!(view.read_with(cx, |view, _| view.operation.is_none()));
    }
}
