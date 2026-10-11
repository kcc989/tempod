use super::chat::{TranscriptEvent, TranscriptRow, TranscriptView};
use super::chat_model;
use super::composer::{Composer, ComposerEvent};
use super::tokens::{Token, color};
use crate::actions::*;
use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::{Button, ButtonVariant};
use gpui_kit::component::input::{Textarea, TextareaState};
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
    active: Option<String>,
    viewing_closed: Vec<String>,
    chats: HashMap<String, Chat>,
    credentials: Option<p::CredentialStatus>,
    pending_permissions: HashSet<String>,
    previous_mode: HashMap<String, String>,
    seen_permissions: HashSet<String>,
    error: Option<String>,
    queue_editor: Option<QueueEditor>,
    queue_pending: bool,
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
                    this.credentials = Some(status);
                    if this.new_chat_menu.is_some() {
                        this.open_new_chat(window, cx);
                    }
                    cx.notify();
                });
            }
        })
        .detach();
        let mut view = Self {
            store,
            client,
            active: None,
            viewing_closed: Vec::new(),
            chats: HashMap::new(),
            credentials: None,
            pending_permissions: HashSet::new(),
            previous_mode: HashMap::new(),
            seen_permissions: HashSet::new(),
            error: None,
            queue_editor: None,
            queue_pending: false,
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
                ComposerEvent::Send(text) => this.send(&session, text, window, cx),
                ComposerEvent::Steer(text) => {
                    if let Some(chat) = this.chats.get(&session) {
                        let prompt = chat.composer.read(cx).prompt(text);
                        this.send_prompt_with_delivery(
                            &session,
                            prompt,
                            Some(p::SendPromptInDelivery::Steer),
                            window,
                            cx,
                        );
                    }
                }
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
        let prompt = chat.composer.read(cx).prompt(text);
        self.send_prompt(session_id, prompt, window, cx);
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
        let selected = self
            .active
            .as_ref()
            .and_then(|id| ids.iter().position(|s| s == id))
            .unwrap_or(0);
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
        let heading = store
            .state
            .workspace
            .as_ref()
            .map(|w| format!("{} · {} → {}", w.title, w.branch, w.base_branch));
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
        let content = if let Some(chat) = chat {
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
                    div().child(chat.composer.clone()).into_any_element()
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
            .children(heading.map(|heading| {
                div()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(color(Token::Border, cx))
                    .child(heading)
            }))
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
                                    this.sync(window, cx);
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
                            })),
                    )
                    .child(new_chat)
                    .child(closed_menu),
            )
            .child(div().flex_1().min_h_0().child(content))
            .into_any_element()
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
