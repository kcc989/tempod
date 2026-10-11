use super::chat::{TranscriptEvent, TranscriptRow, TranscriptView};
use super::chat_model;
use super::composer::{Composer, ComposerEvent};
use super::tokens::{Token, color};
use crate::actions::*;
use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::{Button, ButtonVariant};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Disableable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, DismissEvent, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, Window, div,
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

struct QueueEditor {
    turn_id: String,
    input: Entity<TextareaState>,
}

pub struct WorkspaceView {
    pub store: Entity<WorkspaceStore>,
    client: Client,
    pub review: Entity<super::review::ReviewPanel>,
    pub processes: Entity<super::processes::ProcessPanel>,
    review_comments: Vec<String>,
    _review_events: Subscription,
    _review_changed: Subscription,
    active: Option<String>,
    viewing_closed: Vec<String>,
    chats: HashMap<String, Chat>,
    credentials: Option<p::CredentialStatus>,
    credentials_rev: u64,
    credential_generation: u64,
    _credentials_changed: Option<Subscription>,
    pending_permissions: HashSet<String>,
    previous_mode: HashMap<String, String>,
    seen_permissions: HashSet<String>,
    error: Option<String>,
    queue_editor: Option<QueueEditor>,
    queue_pending: bool,
    operation: Option<String>,
    operation_session: Option<String>,
    operation_draft: bool,
    operation_pending: bool,
    plan_open: bool,
    operation_window: Option<gpui_kit::AnyWindowHandle>,
    revert_checkpoint: Option<String>,
    revert_seq: Option<f64>,
    operation_title: Entity<InputState>,
    operation_body: Entity<TextareaState>,

    closing: Option<String>,
    close_request: bool,
    close_timeout: Option<Task<()>>,
    new_chat_menu: Option<Entity<PopupMenu>>,
    new_chat_dismiss: Option<Subscription>,
    _store_changed: Subscription,
}

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
                let _ = this.update_in(cx, |this, window, cx| {
                    if this.credential_generation != 0 {
                        return;
                    }
                    this.credentials = Some(status);
                    if this.new_chat_menu.is_some() {
                        this.open_new_chat(window, cx);
                    }
                    cx.notify();
                });
            }
        })
        .detach();
        let processes =
            cx.new(|cx| super::processes::ProcessPanel::new(store.clone(), client.clone(), cx));
        let review =
            cx.new(|cx| super::review::ReviewPanel::new(store.clone(), client.clone(), window, cx));
        let review_changed = cx.observe(&review, |_, _, cx| cx.notify());
        let review_events = cx.subscribe_in(
            &review,
            window,
            |this, _, event: &super::review::ReviewEvent, window, cx| {
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
                    this.review.update(cx, |r, cx| {
                        r.document_open = false;
                        cx.notify();
                    });
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
        let mut view = Self {
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
            credentials_rev,
            credential_generation: 0,
            _credentials_changed: credential_changed,
            pending_permissions: HashSet::new(),
            previous_mode: HashMap::new(),
            seen_permissions: HashSet::new(),
            error: None,
            queue_editor: None,
            queue_pending: false,
            operation: None,
            operation_session: None,
            operation_draft: false,
            operation_pending: false,
            plan_open: false,
            operation_window: None,
            revert_checkpoint: None,
            revert_seq: None,
            operation_title: cx.new(|cx| InputState::new(window, cx)),
            operation_body: cx.new(|cx| TextareaState::new(window, cx)),

            closing: None,
            close_request: false,
            close_timeout: None,
            new_chat_menu: None,
            new_chat_dismiss: None,
            _store_changed: changed,
        };
        view.sync(window, cx);
        view
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
                    if this.new_chat_menu.is_some() {
                        this.open_new_chat(window, cx);
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
        match action.name() {
            "tempo::NewChat" => self.open_new_chat(window, cx),
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
            "tempo::ShowDiff" | "tempo::NextFile" => {
                self.review.update(cx, |r, cx| r.navigate(true, window, cx))
            }
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
                    Err(e) => this.error = Some(e.to_string()),
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
        self.error = None;
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
        } else if name == "Base branch" {
            self.store
                .read(cx)
                .state
                .workspace
                .as_ref()
                .map(|w| w.base_branch.clone())
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
            let feedback = weak
                .upgrade()
                .map(|v| (v.read(cx).error.clone(), v.read(cx).operation_pending));
            let pending = feedback.as_ref().is_some_and(|(_, pending)| *pending);
            let submit = weak.clone();
            let close = weak.clone();
            let mut dialog = dialog.title(name.clone()).overlay_closable(false);
            if matches!(
                name.as_str(),
                "Create PR" | "Rename" | "Rename chat" | "Base branch"
            ) {
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
            if name == "Rotate preview link" {
                dialog = dialog.child("Old preview links will stop working.");
            }
            if name == "Merge" {
                dialog = dialog.child("Squash merge this pull request?");
            }
            if name == "Revert" {
                dialog = dialog.child(format!(
                    "Files go back to the end of turn {seq}. A safety checkpoint is saved first."
                ));
            }
            if let Some((Some(error), _)) = feedback {
                dialog = dialog.child(div().text_color(color(Token::Destructive, cx)).child(error));
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
            Some("Base branch") => {
                if let Ok(base_branch) = title.try_into() {
                    self.mutate::<api::SetBaseBranch>(
                        p::SetBaseBranchIn {
                            workspace_id: id,
                            base_branch,
                        },
                        cx,
                    )
                }
            }
            Some("Rotate preview link") => self.mutate::<api::RotatePreviewToken>(
                p::RotatePreviewTokenIn { workspace_id: id },
                cx,
            ),
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
        let id = w.id.clone();
        let sleep = w.state == p::WorkspaceState::Sleeping;
        let weak = cx.weak_entity();
        let instance = match &w.settings.environment.instance {
            p::Instance::InstanceName(name) => name.to_string(),
            p::Instance::CustomInstance(instance) => {
                format!("{} CPUs · {} MiB", instance.vcpu, instance.memory_mib)
            }
        };
        let pill = match w.state {
            p::WorkspaceState::Starting => match w.op.as_ref().map(|op| op.step.as_str()) {
                Some("repo.clone") => "Cloning repository…".into(),
                Some("repo.applyCheckpoint") => "Restoring files…".into(),
                Some("home.restore") => "Restoring sessions…".into(),
                _ => "Starting…".into(),
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
        h_flex()
            .gap_2()
            .p_2()
            .border_b_1()
            .border_color(color(Token::Border, cx))
            .child(
                Button::new("workspace-title").label(w.title).on_click(
                    cx.listener(|this, _, window, cx| this.operation("Rename", window, cx)),
                ),
            )
            .child(
                Button::new("copy-branch")
                    .label(branch.clone())
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(branch.clone()))
                    }),
            )
            .child(
                Button::new("base-branch")
                    .label(format!("→ {}", w.base_branch))
                    .disabled(w.pr_number.is_some())
                    .on_click(
                        cx.listener(|this, _, window, cx| {
                            this.operation("Base branch", window, cx)
                        }),
                    ),
            )
            .children(w.ports.into_iter().map(|port| {
                Button::new(SharedString::from(format!("port-{}", port.port)))
                    .label(format!("{} ↗", port.port))
                    .on_click(move |_, _, cx| cx.open_url(&port.url))
            }))
            .child(div().flex_1())
            .child(
                div()
                    .text_color(color(
                        if w.state == p::WorkspaceState::Error {
                            Token::Destructive
                        } else {
                            Token::MutedForeground
                        },
                        cx,
                    ))
                    .child(pill),
            )
            .children(primary.map(|label| {
                Button::new("primary-action")
                    .label(label)
                    .disabled(self.operation_pending)
                    .on_click(cx.listener(move |this, _, window, cx| match label {
                        "Commit and push" => {
                            this.review.update(cx, |r, cx| r.request_commit(window, cx))
                        }
                        "Archive" => this.archive(cx),
                        "View checks" => this.review.update(cx, |r, cx| r.show_checks(cx)),
                        _ => this.operation(label, window, cx),
                    }))
            }))
            .child(
                Button::new("overflow")
                    .label("⋯")
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
                        for label in [
                            "Open on GitHub",
                            "Copy workspace link",
                            "Rename chat",
                            "Rotate preview link",
                            "Diagnostics",
                            "Archive",
                        ] {
                            let weak = weak.clone();
                            menu = menu.item(PopupMenuItem::new(label).on_click(
                                move |_, window, cx| {
                                    let _ = weak.update(cx, |this, cx| match label {
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
            .into_any_element()
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
        let mut ids: Vec<_> = self
            .tab_ids(cx)
            .into_iter()
            .map(|id| format!("chat:{id}"))
            .collect();
        ids.extend(
            self.review
                .read(cx)
                .document_tabs()
                .into_iter()
                .map(|(key, _)| key),
        );
        if ids.is_empty() {
            return;
        }
        let review = self.review.read(cx);
        let active = if review.document_open {
            review.active_document.clone()
        } else {
            self.active.as_ref().map(|id| format!("chat:{id}"))
        };
        let ix = active
            .and_then(|id| ids.iter().position(|s| s == &id))
            .unwrap_or(0);
        let ix = if forward {
            (ix + 1) % ids.len()
        } else {
            (ix + ids.len() - 1) % ids.len()
        };
        let id = &ids[ix];
        if let Some(chat) = id.strip_prefix("chat:") {
            self.active = Some(chat.into());
            self.review.update(cx, |r, cx| {
                r.document_open = false;
                cx.notify();
            });
            self.sync(window, cx);
        } else {
            self.review
                .update(cx, |r, cx| r.select_document(id, window, cx));
        }
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
        let transcript = cx.new(|cx| TranscriptView::new(Vec::new(), cx));
        let composer = cx.new(|cx| Composer::new(window, cx));
        let workspace_id = self.store.read(cx).workspace_id.clone();
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
                TranscriptEvent::Revert { turn_id } => {
                    let turn = this.store.read(cx).state.turns.get(turn_id).cloned();
                    if let Some(turn) = turn {
                        if let Some(checkpoint) = turn.checkpoint_id {
                            this.revert_checkpoint = Some(checkpoint);
                            this.revert_seq = Some(turn.seq);
                            this.operation("Revert", window, cx);
                        } else {
                            this.error = Some("No checkpoint is available for this turn.".into());
                            cx.notify();
                        }
                    }
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

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
            let rows = chat_model::transcript_rows(state, id)
                .into_iter()
                .map(TranscriptRow::from_native)
                .collect();
            let working = chat_model::running_turn(state, id).is_some();
            let steering = state
                .sessions
                .get(id)
                .is_some_and(|s| s.steering == Some(true));
            let session = state.sessions.get(id).cloned();
            chat.transcript.update(cx, |t, cx| {
                t.read_only = read_only;
                t.sync(rows, cx);
            });
            chat.composer.update(cx, |c, cx| {
                c.read_only = read_only;
                c.review_count = self.review_comments.len();
                c.working = working;
                c.steering = steering;
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
                self.error = Some("Paste a PNG, JPEG, GIF or WebP image.".into());
                cx.notify();
                return;
            }
        };
        if image.bytes().len() as u64 > tempo_client::MAX_ATTACHMENT_BYTES {
            self.error = Some("Each attachment must be at most 10 MiB.".into());
            cx.notify();
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
                    this.error = Some(e.to_string());
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
                            return Err("Each attachment must be at most 10 MiB.");
                        }
                        Ok(bytes)
                    })
                    .await;
                let result = match bytes {
                    Ok(bytes) => client
                        .upload_attachment(&workspace_id, &name, attachment_mime(&name), bytes)
                        .await
                        .map_err(|e| e.to_string()),
                    Err(e) => Err(e.into()),
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
                            Err(e) => this.error = Some(e),
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
        let request = self.client.call::<api::ListFiles>(p::ListFilesIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
        });
        let id = session_id.to_string();
        cx.spawn_in(window, async move |this, cx| {
            let result = request
                .await
                .map(|out| out.paths)
                .map_err(|e| e.to_string());
            let _ = this.update_in(cx, |this, _, cx| {
                if let Some(chat) = this.chats.get(&id) {
                    chat.composer.update(cx, |c, cx| c.set_files(result, cx));
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
            let _ =
                this.update_in(cx, |this, window, cx| {
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
                        Err(tempo_client::ApiError::Network(_)) => this.error = Some(
                            "Delivery could not be confirmed. Check the response before retrying."
                                .into(),
                        ),
                        Err(error) => this.error = Some(error.to_string()),
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
                    Err(error) => this.error = Some(error.to_string()),
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
                    Err(error) => this.error = Some(error.to_string()),
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
                    this.error = Some(error.to_string());
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn stop(&mut self, session_id: &str, cx: &mut Context<Self>) {
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
                    this.error = Some(error.to_string());
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
                    this.error = Some(error.to_string());
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
                    this.error = Some(error.to_string());
                    cx.notify();
                    return;
                }
                this.close_timeout = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_secs(30))
                        .await;
                    let _ = this.update(cx, |this, cx| {
                        this.closing = None;
                        this.error =
                            Some("The agent is still stopping. Try closing the chat again.".into());
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
                    Err(error) => this.error = Some(error.to_string()),
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
                    this.error = Some(error.to_string());
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
                    this.error = Some(error.to_string());
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
        let credentials = self.credentials.clone();
        let weak = cx.weak_entity();
        let menu = PopupMenu::build(window, cx, move |menu, _, _| {
            chat_model::AGENTS.iter().fold(menu, |menu, agent| {
                let agent = *agent;
                let enabled = credentials
                    .as_ref()
                    .is_some_and(|c| chat_model::has_login(agent, c));
                let weak = weak.clone();
                menu.item(
                    PopupMenuItem::new(if enabled {
                        chat_model::agent_label(agent).to_string()
                    } else {
                        format!(
                            "{} · {}",
                            chat_model::agent_label(agent),
                            if credentials.is_none() {
                                "Loading logins…"
                            } else {
                                "Add login in Settings"
                            }
                        )
                    })
                    .disabled(!enabled)
                    .on_click(move |_, window, cx| {
                        let _ = weak.update(cx, |this, cx| this.create_chat(agent, window, cx));
                    }),
                )
            })
        });
        self.new_chat_dismiss =
            Some(
                cx.subscribe_in(&menu, window, |this, _, _: &DismissEvent, _, cx| {
                    this.new_chat_menu = None;
                    cx.notify();
                }),
            );
        menu.read(cx).focus_handle(cx).focus(window, cx);
        self.new_chat_menu = Some(menu);
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

    fn create_chat(&mut self, agent: p::AgentId, window: &mut Window, cx: &mut Context<Self>) {
        self.new_chat_menu = None;
        let request = self.client.call::<api::CreateSession>(p::CreateSessionIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
            agent,
            model: None,
            mode_id: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(session) => {
                        this.active = Some(session.id.clone());
                        this.store.update(cx, |store, cx| {
                            store
                                .state
                                .apply(p::WorkspaceServerMessage::Session(p::WsSession {
                                    type_: p::WsSessionType::Session,
                                    session,
                                }));
                            cx.notify();
                        });
                        this.sync(window, cx);
                        this.focus_composer(window, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for WorkspaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let store = self.store.read(cx);
        if store.not_found {
            return div().p_4().child("Not found.").into_any_element();
        }
        if !store.state.ready {
            return super::skeleton_rows(8).into_any_element();
        }
        let ids = self.tab_ids(cx);
        let documents = self.review.read(cx).document_tabs();
        let document_keys: Vec<_> = documents.iter().map(|(key, _)| key.clone()).collect();
        let selected = self
            .active
            .as_ref()
            .and_then(|id| ids.iter().position(|s| s == id))
            .unwrap_or(0);
        let selected = if self.review.read(cx).document_open {
            ids.len()
                + document_keys
                    .iter()
                    .position(|key| Some(key) == self.review.read(cx).active_document.as_ref())
                    .unwrap_or(0)
        } else {
            selected
        };
        let titles: Vec<_> = ids
            .iter()
            .filter_map(|id| store.state.sessions.get(id))
            .map(chat_model::session_title)
            .collect();
        let closed: Vec<_> = chat_model::sessions(&store.state, true)
            .into_iter()
            .map(|s| (s.id.clone(), chat_model::session_title(s)))
            .collect();
        let reconnecting = store
            .connection
            .shows_reconnecting_bar(std::time::Instant::now());
        let error = self.error.clone().or_else(|| store.error.clone());
        let _heading = store
            .state
            .workspace
            .as_ref()
            .map(|w| format!("{} · {} → {}", w.title, w.branch, w.base_branch));
        let workspace_error = store
            .state
            .workspace
            .as_ref()
            .filter(|w| w.state == p::WorkspaceState::Error)
            .map(|w| {
                w.error_code
                    .clone()
                    .unwrap_or_else(|| "Workspace could not start".into())
            });
        let missing_login = self
            .active
            .as_ref()
            .and_then(|id| store.state.sessions.get(id))
            .is_some_and(|session| {
                self.credentials
                    .as_ref()
                    .is_some_and(|credentials| !chat_model::has_login(session.agent, credentials))
            });
        let invalid_logins = store.state.credential_invalid.clone();
        let archived = store.state.workspace.as_ref().is_some_and(|w| {
            matches!(
                w.state,
                p::WorkspaceState::Archived | p::WorkspaceState::Archiving
            )
        });
        let menu = self.new_chat_menu.clone();
        let new_chat = Popover::new("new-chat-popover")
            .open(menu.is_some())
            .trigger(
                Button::new("new-chat-menu")
                    .label("New chat")
                    .disabled(archived),
            )
            .on_open_change(cx.listener(|this, open: &bool, window, cx| {
                if *open {
                    this.open_new_chat(window, cx);
                } else {
                    this.new_chat_menu = None;
                    cx.notify();
                }
            }))
            .content(move |_, _, _| {
                menu.clone()
                    .map(|m| m.into_any_element())
                    .unwrap_or_else(|| div().into_any_element())
            });
        let weak = cx.weak_entity();
        let closed_menu = Button::new("closed-chat-menu")
            .label("Closed chats")
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
        let content =
            if self.review.read(cx).document_open {
                self.review.read(cx).document(cx)
            } else if let Some(chat) = chat {
                v_flex()
                    .size_full()
                    .child(div().flex_1().min_h_0().child(chat.transcript.clone()))
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
                        h_flex()
                            .id(SharedString::from(format!("queued-{id}")))
                            .px_3()
                            .py_1()
                            .text_color(color(Token::MutedForeground, cx))
                            .child(format!(
                                "{}: {text}",
                                if pending { "Sending now" } else { "Queued" }
                            ))
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
                            .on_drag(drag, |drag: &QueuedDrag, _, _, cx| cx.new(|_| drag.clone()))
                            .on_drop(cx.listener(move |this, drag: &QueuedDrag, _, cx| {
                                if !read_only {
                                    this.move_queue(drag, &before, cx);
                                }
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
                        let plan = self
                            .store
                            .read(cx)
                            .state
                            .items
                            .values()
                            .filter(|item| Some(&item.session_id) == self.active.as_ref())
                            .filter_map(|item| match &item.content {
                                p::ItemContent::Plan(plan) => Some((item.updated_at, plan.clone())),
                                _ => None,
                            })
                            .max_by(|a, b| a.0.total_cmp(&b.0))
                            .map(|(_, p)| p);
                        v_flex()
                            .children(plan.map(|plan| {
                                let done = plan
                                    .entries
                                    .iter()
                                    .filter(|e| e.status == "completed")
                                    .count();
                                gpui_kit::component::collapsible::Collapsible::new()
                                    .open(self.plan_open)
                                    .child(
                                        Button::new("plan-progress")
                                            .label(format!(
                                                "Plan · {done}/{} completed",
                                                plan.entries.len()
                                            ))
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.plan_open = !this.plan_open;
                                                cx.notify();
                                            })),
                                    )
                                    .content(v_flex().children(plan.entries.iter().map(|e| {
                                        div().child(format!("{} · {}", e.status, e.content))
                                    })))
                            }))
                            .child(chat.composer.clone())
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
                this.review.update(cx, |r, cx| r.navigate(true, window, cx))
            }))
            .on_action(cx.listener(|this, _: &OpenFile, _, cx| {
                this.review.update(cx, |r, cx| r.open_picker(cx))
            }))
            .on_action(cx.listener(|this, _: &SearchFiles, _, cx| {
                this.review.update(cx, |r, cx| r.open_picker(cx))
            }))
            .on_action(cx.listener(|this, _: &ToggleDiffScope, window, cx| {
                this.review.update(cx, |r, cx| r.toggle_scope(window, cx))
            }))
            .on_action(cx.listener(|this, _: &NextFile, window, cx| {
                this.review.update(cx, |r, cx| r.navigate(true, window, cx))
            }))
            .on_action(cx.listener(|this, _: &PreviousFile, window, cx| {
                this.review
                    .update(cx, |r, cx| r.navigate(false, window, cx))
            }))
            .on_action(cx.listener(|this, _: &ToggleRun, _, cx| {
                this.processes.update(cx, |p, cx| p.toggle_default_run(cx))
            }))
            .on_action(cx.listener(|this, _: &CommitAndPush, window, cx| {
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
            .children(workspace_error.map(|error| {
                h_flex()
                    .p_2()
                    .gap_2()
                    .text_color(color(Token::Destructive, cx))
                    .child(error)
                    .child(
                        Button::new("retry-workspace")
                            .label("Retry")
                            .disabled(self.operation_pending)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.mutate::<api::WakeWorkspace>(
                                    p::WakeWorkspaceIn {
                                        workspace_id: this.store.read(cx).workspace_id.clone(),
                                    },
                                    cx,
                                )
                            })),
                    )
                    .child(
                        Button::new("workspace-error-details")
                            .label("Details")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.diagnostics(window, cx)),
                            ),
                    )
                    .child(
                        Button::new("archive-failed-workspace")
                            .label("Archive")
                            .on_click(cx.listener(|this, _, _, cx| this.archive(cx))),
                    )
            }))
            .children(missing_login.then(|| {
                h_flex()
                    .p_2()
                    .gap_2()
                    .child("This agent needs a login.")
                    .child(
                        Button::new("add-missing-login")
                            .label("Add login")
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(OpenSettings), cx)
                            }),
                    )
            }))
            .children(invalid_logins.into_iter().map(|provider| {
                h_flex()
                    .p_2()
                    .gap_2()
                    .child(format!("The {provider} login needs attention."))
                    .child(
                        Button::new(SharedString::from(format!("fix-login-{provider}")))
                            .label("Add login")
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(OpenSettings), cx)
                            }),
                    )
            }))
            .children(reconnecting.then(|| {
                div()
                    .px_3()
                    .py_2()
                    .text_color(color(Token::Warning, cx))
                    .child("Reconnecting…")
            }))
            .children(error.map(|error| {
                div()
                    .px_3()
                    .py_2()
                    .text_color(color(Token::Destructive, cx))
                    .child(error)
            }))
            .child(
                h_flex()
                    .child(
                        TabBar::new("chat-tabs")
                            .selected_index(selected)
                            .on_click(cx.listener(move |this, ix: &usize, window, cx| {
                                if let Some(id) = ids.get(*ix) {
                                    this.active = Some(id.clone());
                                    this.review.update(cx, |r, cx| {
                                        r.document_open = false;
                                        cx.notify();
                                    });
                                    this.sync(window, cx);
                                } else if let Some(key) =
                                    document_keys.get(ix.saturating_sub(ids.len()))
                                {
                                    this.review
                                        .update(cx, |r, cx| r.select_document(key, window, cx));
                                }
                            }))
                            .children(titles.into_iter().zip(tab_ids).map(|(title, id)| {
                                let button_id = SharedString::from(format!("close-chat-{id}"));
                                Tab::new().label(SharedString::from(title)).suffix(
                                    Button::new(button_id)
                                        .icon(gpui_kit::assets::IconName::X)
                                        .accessibility_label("Close chat")
                                        .tooltip("Close chat")
                                        .disabled(self.closing.is_some())
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            cx.stop_propagation();
                                            this.close_chat(&id, window, cx);
                                        })),
                                )
                            }))
                            .children(documents.into_iter().map(|(key, title)| {
                                let close_key = key.clone();
                                Tab::new().label(SharedString::from(title)).suffix(
                                    Button::new(SharedString::from(format!(
                                        "close-document-{key}"
                                    )))
                                    .icon(gpui_kit::assets::IconName::X)
                                    .accessibility_label("Close file tab")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.review.update(cx, |r, cx| {
                                            r.close_document_key(&close_key, cx)
                                        });
                                    })),
                                )
                            })),
                    )
                    .child(new_chat)
                    .child(closed_menu),
            )
            .child(div().flex_1().min_h_0().child(content))
            .into_any_element()
    }
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
                    } else if path.ends_with("/getCredentialStatus") {
                        (200,r#"{"claude":{"set":true,"updatedAt":null},"anthropic":{"set":true,"updatedAt":null},"openai":{"set":true,"updatedAt":null},"openrouter":{"set":true,"updatedAt":null},"codex":{"set":true,"updatedAt":null,"lastRefresh":null}}"#.into())
                    } else {
                        (200, "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes());
                }
            });
            Self {
                url,
                requests,
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
        view.read_with(cx, |view, cx| {
            assert!(view.error.is_some());
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
    fn chat_keyboard_shortcut_opens_the_agent_menu(cx: &mut TestAppContext) {
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
        view.read_with(cx, |view, _| assert!(view.new_chat_menu.is_some()));
        cx.update_window(window, |_, window, cx| window.press("escape", cx))
            .unwrap();
        cx.run_until_parked();
        view.read_with(cx, |view, _| assert!(view.new_chat_menu.is_none()));
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
            view.read_with(cx, |view, cx| {
                assert!(view.closing.is_none());
                assert!(view.error.is_some());
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
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.chats[&session].composer.read(cx).text(cx),
                "Retry this draft"
            );
            assert_eq!(view.error.as_deref(), Some("Could not send."));
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
}
