use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, StatefulInteractiveElement as _, Styled as _, Window, div,
};
use tempo_protocol::{self as p, api};

pub struct EventsView {
    client: tempo_client::Client,
    workspace_id: String,
    change: Entity<InputState>,
    events: Vec<p::LifecycleLogEvent>,
    attachments: Vec<p::AgentAttachment>,
    trace: String,
    error: Option<String>,
}
impl EventsView {
    pub fn new(
        client: tempo_client::Client,
        workspace_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            client,
            workspace_id,
            change: cx.new(|cx| InputState::new(window, cx).placeholder("Change ID")),
            events: vec![],
            attachments: vec![],
            trace: String::new(),
            error: None,
        }
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let change = self.change.read(cx).value().trim().to_string();
        let request = self
            .client
            .call::<api::ListLifecycleEvents>(p::ListLifecycleEventsIn {
                workspace_id: self.workspace_id.clone(),
                change_id: (!change.is_empty()).then_some(change),
                before_seq: None,
                limit: Some(500.),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(page) => {
                        this.events = page.events;
                        this.error = None;
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let workspace_id = self.workspace_id.clone();
        cx.spawn(async move |this, cx| {
            let result = client
                .call::<api::GetTrace>(p::GetTraceIn {
                    workspace_id: workspace_id.clone(),
                    event_id: id,
                })
                .await;
            let attachments = match client
                .call::<api::GetWorkspace>(p::GetWorkspaceIn { workspace_id })
                .await
            {
                Ok(w) => client
                    .call::<api::ListProjectAgents>(p::ListProjectAgentsIn {
                        project_id: w.project_id,
                    })
                    .await
                    .unwrap_or_default(),
                Err(_) => vec![],
            };
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(trace) => {
                        this.attachments = attachments.clone();
                        this.trace = format!(
                            "Trace\n{}\nAgent hooks\n{}",
                            serde_json::to_string_pretty(&trace).unwrap_or_default(),
                            serde_json::to_string_pretty(&attachments).unwrap_or_default()
                        )
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
impl Render for EventsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("lifecycle-events")
            .size_full()
            .overflow_y_scroll()
            .gap_2()
            .child(
                h_flex().gap_2().child(Input::new(&self.change)).child(
                    Button::new("refresh-events")
                        .label("Refresh")
                        .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                ),
            )
            .children(
                self.events
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(i, event)| {
                        let value = serde_json::to_value(&event.event).unwrap_or_default();
                        let id = value["id"].as_str().unwrap_or_default().to_string();
                        let mut label = format!(
                            "{} · {} · {}",
                            event.seq,
                            value["type"].as_str().unwrap_or_default(),
                            value["changeId"].as_str().unwrap_or("No change")
                        );
                        if value["type"] == "run.decided" {
                            let payload = &value["payload"];
                            let question = self
                                .attachments
                                .iter()
                                .find(|a| Some(a.id.as_str()) == payload["attachmentId"].as_str())
                                .and_then(|a| {
                                    a.hooks
                                        .get(payload["hookIndex"].as_u64().unwrap_or_default()
                                            as usize)
                                })
                                .and_then(|h| h.when.as_ref().map(|q| q.as_str()))
                                .unwrap_or("Always / hook removed");
                            let probability = payload["p"]
                                .as_f64()
                                .map(|p| format!("{:.0}%", p * 100.0))
                                .unwrap_or_else(|| {
                                    if payload["outcome"] == "error" {
                                        "No answer"
                                    } else {
                                        "Always"
                                    }
                                    .into()
                                });
                            label.push_str(&format!(
                                " · {} · {} · {} · threshold {} · {}",
                                payload["handle"].as_str().unwrap_or_default(),
                                payload["outcome"].as_str().unwrap_or_default(),
                                probability,
                                payload["threshold"],
                                question
                            ));
                        }
                        Button::new(("event", i)).ghost().label(label).on_click(
                            cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)),
                        )
                    }),
            )
            .child(div().font_family("monospace").child(self.trace.clone()))
            .children(self.error.clone().map(|e| div().child(e)))
    }
}
