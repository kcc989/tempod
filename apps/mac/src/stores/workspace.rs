use super::Connection;
use gpui_kit::{Context, Task};
use std::time::{Duration, Instant};
use tempo_client::{
    ChannelEvent, Client, CloseReason, Status, WorkspaceChannelEvent, WorkspaceHandle,
    state::workspace::{WorkspaceEvent, WorkspaceState},
};

pub const MAX_OPEN: usize = 5;
pub const CLOSE_AFTER_HIDDEN: Duration = Duration::from_secs(60);
pub const BACKLOG_PAGE: usize = 500;

pub struct WorkspaceStore {
    pub workspace_id: String,
    pub connection: Connection,
    pub state: WorkspaceState,
    pub hidden_since: Option<Instant>,
    pub not_found: bool,
    pub error: Option<String>,
    channel: Option<WorkspaceHandle>,
    task: Option<Task<()>>,
    close_task: Option<Task<()>>,
    reconnect_bar_task: Option<Task<()>>,
}

impl WorkspaceStore {
    pub fn new(workspace_id: impl Into<String>) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            connection: Connection::Closed,
            state: WorkspaceState::new(),
            hidden_since: None,
            not_found: false,
            error: None,
            channel: None,
            task: None,
            close_task: None,
            reconnect_bar_task: None,
        }
    }

    pub fn since_rev(&self) -> u64 {
        self.state.since_rev()
    }

    pub fn show(&mut self, client: &Client, cx: &mut Context<Self>) {
        self.hidden_since = None;
        self.close_task.take();
        if self.channel.is_none() {
            self.not_found = false;
            let (events, channel) = client.open_workspace(&self.workspace_id, self.since_rev());
            self.channel = Some(channel);
            self.task = Some(cx.spawn(async move |this, cx| {
                while let Ok(event) = events.recv().await {
                    if this.update(cx, |store, cx| store.apply(event, cx)).is_err() {
                        break;
                    }
                }
            }));
        }
    }

    pub fn hide(&mut self, cx: &mut Context<Self>) {
        if self.hidden_since.is_some() {
            return;
        }
        self.hidden_since = Some(Instant::now());
        self.close_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CLOSE_AFTER_HIDDEN).await;
            let _ = this.update(cx, |store, cx| {
                store.close();
                cx.notify();
            });
        }));
    }

    fn close(&mut self) {
        self.channel.take();
        self.task.take();
        self.reconnect_bar_task.take();
        self.connection = Connection::Closed;
    }

    fn apply(&mut self, event: WorkspaceChannelEvent, cx: &mut Context<Self>) {
        match event {
            ChannelEvent::Message(message) => {
                if matches!(message, tempo_protocol::WorkspaceServerMessage::Hello(_)) {
                    self.error = None;
                }
                for event in self.state.apply(message) {
                    match event {
                        WorkspaceEvent::Error { message, .. } => self.error = Some(message),
                        WorkspaceEvent::TurnEnded { .. }
                            if self.hidden_since.is_none()
                                && crate::app::AppState::try_global(cx)
                                    .is_some_and(|a| a.read(cx).workspace_focused) =>
                        {
                            if let Some(client) = crate::app::AppState::try_global(cx)
                                .and_then(|a| a.read(cx).client())
                            {
                                let request = client.call::<tempo_protocol::api::MarkViewed>(
                                    tempo_protocol::MarkViewedIn {
                                        workspace_id: self.workspace_id.clone(),
                                    },
                                );
                                cx.spawn(async move |_, _| {
                                    let _ = request.await;
                                })
                                .detach();
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(channel) = &self.channel {
                    channel.set_since_rev(self.since_rev());
                }
            }
            ChannelEvent::Status(status) => {
                self.reconnect_bar_task.take();
                self.connection = match status {
                    Status::Open => Connection::Open,
                    Status::Down { since } => {
                        self.reconnect_bar_task = Some(cx.spawn(async move |this, cx| {
                            cx.background_executor()
                                .timer(super::RECONNECTING_BAR_AFTER)
                                .await;
                            let _ = this.update(cx, |_, cx| cx.notify());
                        }));
                        Connection::Down(since)
                    }
                    Status::Closed(reason) => {
                        self.not_found = reason == CloseReason::NotFound;
                        self.channel.take();
                        Connection::Closed
                    }
                    Status::Connecting => Connection::Closed,
                };
            }
        }
        cx.notify();
    }

    pub fn should_close_socket(&self, now: Instant) -> bool {
        self.hidden_since
            .is_some_and(|since| now.duration_since(since) >= CLOSE_AFTER_HIDDEN)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AppContext as _, TestAppContext};

    #[test]
    fn a_new_store_asks_for_everything() {
        assert_eq!(WorkspaceStore::new("w").since_rev(), 0);
    }

    #[test]
    fn socket_closes_a_minute_after_hiding() {
        let mut store = WorkspaceStore::new("w");
        let t0 = Instant::now();
        assert!(!store.should_close_socket(t0));
        store.hidden_since = Some(t0);
        assert!(!store.should_close_socket(t0 + Duration::from_secs(59)));
        assert!(store.should_close_socket(t0 + Duration::from_secs(60)));
    }

    #[gpui_kit::test]
    fn showing_cancels_hidden_close_and_reopening_keeps_revision(cx: &mut TestAppContext) {
        cx.background_executor.allow_parking();
        let runtime = tempo_client::Runtime::start().unwrap();
        let client =
            tempo_client::Server::new(&runtime.handle(), "http://127.0.0.1:9", crate::VERSION)
                .unwrap()
                .client(tempo_client::Token::new("test-token"));
        let store = cx.new(|_| WorkspaceStore::new("w"));
        store.update(cx, |store, cx| {
            store.state.items_rev = 100.;
            store.show(&client, cx);
            store.hide(cx);
            store.show(&client, cx);
        });
        cx.run_until_parked();
        store.read_with(cx, |store, _| {
            assert!(store.channel.is_some());
            assert!(store.hidden_since.is_none());
        });
        store.update(cx, |store, cx| store.hide(cx));
        cx.run_until_parked();
        cx.background_executor.advance_clock(CLOSE_AFTER_HIDDEN);
        cx.run_until_parked();
        store.read_with(cx, |store, _| {
            assert!(store.channel.is_none());
            assert_eq!(store.since_rev(), 100);
        });
        store.update(cx, |store, cx| store.show(&client, cx));
        store.read_with(cx, |store, _| {
            assert_eq!(store.channel.as_ref().unwrap().since_rev(), 100)
        });
        store.update(cx, |store, _| store.close());
        cx.run_until_parked();
    }

    #[gpui_kit::test]
    fn channel_fixtures_reach_the_native_store_and_keep_resume_revision(cx: &mut TestAppContext) {
        let store = cx.new(|_| WorkspaceStore::new("w"));
        let fixtures = include_str!(
            "../../../../packages/protocol/fixtures/channel/workspace-reconnect.jsonl"
        );
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/fixtures/channel/workspace-reconnect.expected.json"
        ))
        .unwrap();
        for line in fixtures.lines() {
            let message =
                serde_json::from_str::<tempo_protocol::WorkspaceServerMessage>(line).unwrap();
            store.update(cx, |store, cx| {
                store.apply(ChannelEvent::Message(message), cx)
            });
        }
        store.read_with(cx, |store, _| {
            fn normalize(value: &mut serde_json::Value) {
                match value {
                    serde_json::Value::Number(number) => {
                        *number = serde_json::Number::from_f64(number.as_f64().unwrap()).unwrap();
                    }
                    serde_json::Value::Array(values) => values.iter_mut().for_each(normalize),
                    serde_json::Value::Object(values) => {
                        values.retain(|_, value| !value.is_null());
                        values.values_mut().for_each(normalize);
                    }
                    _ => {}
                }
            }
            let mut actual = serde_json::to_value(&store.state).unwrap();
            let mut expected_state = expected["state"].clone();
            normalize(&mut actual);
            normalize(&mut expected_state);
            assert_eq!(actual, expected_state);
            assert_eq!(
                store.since_rev() as f64,
                expected["state"]["itemsRev"].as_f64().unwrap()
            );
            assert!(store.state.ready);
        });
        store.update(cx, |store, cx| {
            store.apply(
                ChannelEvent::Status(Status::Closed(CloseReason::NotFound)),
                cx,
            )
        });
        store.read_with(cx, |store, _| assert!(store.not_found));
    }
}
