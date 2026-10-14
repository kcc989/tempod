use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Selectable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Window, div,
};
use serde_json::json;
use tempo_protocol::{self as p, api};

struct Hook {
    event: p::HookEvent,
    question: Entity<TextareaState>,
    threshold: Entity<InputState>,
}
struct Row {
    id: String,
    agent_id: String,
    title: String,
    deleted: bool,
    enabled: bool,
    auto_send: bool,
    max_runs: Entity<InputState>,
    timeout: Entity<InputState>,
    hooks: Vec<Hook>,
}
pub struct AgentAttachments {
    client: Option<tempo_client::Client>,
    project_id: String,
    library: Vec<p::AgentSummary>,
    rows: Vec<Row>,
    pending: bool,
    error: Option<String>,
}
const EVENTS: [p::HookEvent; 7] = [
    p::HookEvent::Prompt,
    p::HookEvent::TurnEnded,
    p::HookEvent::BranchPushed,
    p::HookEvent::CheckPassed,
    p::HookEvent::CheckFailed,
    p::HookEvent::RunCompleted,
    p::HookEvent::RunFailed,
];
fn input(
    value: String,
    window: &mut Window,
    cx: &mut Context<AgentAttachments>,
) -> Entity<InputState> {
    cx.new(|cx| {
        let mut s = InputState::new(window, cx);
        s.set_value(value, window, cx);
        s
    })
}
impl AgentAttachments {
    pub fn new(project_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let client = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client());
        let mut this = Self {
            client,
            project_id,
            library: vec![],
            rows: vec![],
            pending: false,
            error: None,
        };
        this.load(window, cx);
        this
    }
    fn row(a: p::AgentAttachment, window: &mut Window, cx: &mut Context<Self>) -> Row {
        Row {
            id: a.id,
            agent_id: a.agent_id,
            title: a
                .agent
                .as_ref()
                .map(|a| format!("{} · @{}", a.name.as_str(), a.handle.0.as_str()))
                .unwrap_or_else(|| "This agent was deleted.".into()),
            deleted: a.agent.is_none(),
            enabled: a.enabled,
            auto_send: a.auto_send,
            max_runs: input(a.max_runs.to_string(), window, cx),
            timeout: input(a.timeout, window, cx),
            hooks: a
                .hooks
                .into_iter()
                .map(|h| {
                    Self::hook(
                        h.event,
                        h.when.map(|v| v.to_string()).unwrap_or_default(),
                        h.threshold.unwrap_or(0.5),
                        window,
                        cx,
                    )
                })
                .collect(),
        }
    }
    fn hook(
        event: p::HookEvent,
        question: String,
        threshold: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Hook {
        Hook {
            event,
            question: cx.new(|cx| {
                let mut s = TextareaState::new(window, cx).auto_grow(2, 4);
                s.set_value(question, window, cx);
                s
            }),
            threshold: input(threshold.to_string(), window, cx),
        }
    }
    fn load(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let project_id = self.project_id.clone();
        cx.spawn_in(_window, async move |this, cx| {
            let library = client.call::<api::ListAgents>(p::Empty {}).await;
            let rows = client
                .call::<api::ListProjectAgents>(p::ListProjectAgentsIn { project_id })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                match (library, rows) {
                    (Ok(library), Ok(rows)) => {
                        this.library = library;
                        this.rows = rows.into_iter().map(|a| Self::row(a, window, cx)).collect();
                        this.error = None;
                    }
                    (Err(e), _) | (_, Err(e)) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn save(
        &mut self,
        ix: Option<usize>,
        agent_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pending {
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        let (enabled, auto_send, max_runs, timeout, hooks) = if let Some(i) = ix {
            let r = &self.rows[i];
            let max = r.max_runs.read(cx).value().parse::<u64>().unwrap_or(0);
            let timeout = r.timeout.read(cx).value().to_string();
            let hooks=r.hooks.iter().map(|h|{let text=h.question.read(cx).value().to_string();json!({"event":h.event,"when":if text.is_empty(){None}else{Some(text)},"threshold":h.threshold.read(cx).value().parse::<f64>().ok()})}).collect::<Vec<_>>();
            (r.enabled, r.auto_send, max, timeout, hooks)
        } else {
            (true, false, 3, "20m".into(), vec![])
        };
        let request = serde_json::from_value::<p::PutProjectAgentIn>(
            json!({"projectId":self.project_id,"agentId":agent_id,"enabled":enabled,"hooks":hooks,"autoSend":auto_send,"maxRuns":max_runs,"timeout":timeout}),
        );
        let request = match request {
            Ok(r) => r,
            Err(e) => {
                self.error = Some(format!("Check the hooks and limits: {e}"));
                cx.notify();
                return;
            }
        };
        self.pending = true;
        cx.spawn_in(window, async move |this, cx| {
            let result = client.call::<api::PutProjectAgent>(request).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(a) => {
                        let id = a.id.clone();
                        let row = Self::row(a, window, cx);
                        if let Some(i) = this.rows.iter().position(|r| r.id == id) {
                            this.rows[i] = row
                        } else {
                            this.rows.push(row)
                        }
                        this.error = None;
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn remove(&mut self, agent_id: String, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.pending {
            return;
        }
        self.pending = true;
        let request = p::DeleteProjectAgentIn {
            project_id: self.project_id.clone(),
            agent_id: agent_id.clone(),
        };
        cx.spawn(async move |this, cx| {
            let result = client.call::<api::DeleteProjectAgent>(request).await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        this.rows.retain(|r| r.agent_id != agent_id);
                        this.error = None
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
impl Render for AgentAttachments {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let available = self
            .library
            .iter()
            .filter(|a| !self.rows.iter().any(|r| r.agent_id == a.id))
            .map(|a| {
                let id = a.id.clone();
                Button::new(SharedString::from(format!("attach-{}", id)))
                    .label(format!("Attach {}", a.name.as_str()))
                    .disabled(self.pending)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.save(None, id.clone(), window, cx)
                    }))
            })
            .collect::<Vec<_>>();
        let rows = self
            .rows
            .iter()
            .enumerate()
            .map(|(ix, r)| {
                let id = r.agent_id.clone();
                let remove_id = id.clone();
                let mut view = v_flex()
                    .gap_2()
                    .p_3()
                    .border_1()
                    .rounded_md()
                    .border_color(color(Token::Border, cx))
                    .child(
                        h_flex().justify_between().child(r.title.clone()).child(
                            Button::new(SharedString::from(format!("remove-{}", r.id)))
                                .ghost()
                                .label("Remove")
                                .disabled(self.pending)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.remove(remove_id.clone(), cx)
                                })),
                        ),
                    );
                if !r.deleted {
                    view = view
                        .child(
                            Switch::new(SharedString::from(format!("enabled-{}", r.id)))
                                .label("Enabled")
                                .checked(r.enabled)
                                .on_click(cx.listener(move |this, on: &bool, _, cx| {
                                    this.rows[ix].enabled = *on;
                                    cx.notify();
                                })),
                        )
                        .child(
                            Switch::new(SharedString::from(format!("auto-send-{}", r.id)))
                                .label("Automatically send result to chat")
                                .checked(r.auto_send)
                                .on_click(cx.listener(move |this, on: &bool, _, cx| {
                                    this.rows[ix].auto_send = *on;
                                    cx.notify();
                                })),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .child("Max runs per change")
                                .child(Input::new(&r.max_runs))
                                .child("Timeout")
                                .child(Input::new(&r.timeout)),
                        )
                        .children(r.hooks.iter().enumerate().map(|(hi, h)| {
                            v_flex()
                                .gap_2()
                                .child(h_flex().flex_wrap().gap_1().children(EVENTS.map(|event| {
                                    Button::new(SharedString::from(format!(
                                        "{}-{hi}-{event}",
                                        r.id
                                    )))
                                    .label(event.to_string())
                                    .selected(h.event == event)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.rows[ix].hooks[hi].event = event;
                                        cx.notify();
                                    }))
                                })))
                                .child("Question (empty means always)")
                                .child(Textarea::new(&h.question))
                                .child("Threshold (0.05 to 0.95)")
                                .child(Input::new(&h.threshold))
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "{}-{hi}-remove",
                                        r.id
                                    )))
                                    .ghost()
                                    .label("Remove hook")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.rows[ix].hooks.remove(hi);
                                        cx.notify();
                                    })),
                                )
                        }))
                        .child(
                            Button::new(SharedString::from(format!("add-hook-{}", r.id)))
                                .label("Add hook")
                                .disabled(r.hooks.len() >= 8)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    let h = Self::hook(
                                        p::HookEvent::BranchPushed,
                                        String::new(),
                                        0.5,
                                        window,
                                        cx,
                                    );
                                    this.rows[ix].hooks.push(h);
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("save-{}", r.id)))
                                .label("Save attachment")
                                .disabled(self.pending)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.save(Some(ix), id.clone(), window, cx)
                                })),
                        );
                }
                view
            })
            .collect::<Vec<_>>();
        v_flex()
            .gap_3()
            .child("Attached agents")
            .children(available)
            .children(rows)
            .children(
                self.error
                    .clone()
                    .map(|e| div().text_color(color(Token::Destructive, cx)).child(e)),
            )
    }
}
