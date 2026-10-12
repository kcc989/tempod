use super::Connection;
use gpui_kit::{Context, Task};
use tempo_client::{ChannelEvent, ChannelHandle, Client, Status, state::hub::HubState};
use tempo_protocol::{Project, api::ListProjects};

pub struct HubStore {
    pub connection: Connection,
    pub state: HubState,
    pub projects: Vec<Project>,
    pub project_error: bool,
    pub projects_ready: bool,
    channel: Option<ChannelHandle>,
    task: Option<Task<()>>,
    projects_task: Option<Task<()>>,
    reconnect_bar_task: Option<Task<()>>,
}

impl HubStore {
    pub fn new() -> Self {
        Self {
            connection: Connection::Closed,
            state: HubState::new(),
            projects: Vec::new(),
            project_error: false,
            projects_ready: false,
            channel: None,
            task: None,
            projects_task: None,
            reconnect_bar_task: None,
        }
    }

    pub fn connect(&mut self, client: &Client, cx: &mut Context<Self>) {
        let (events, channel) = client.open_hub();
        self.channel = Some(channel);
        self.task = Some(cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                if this
                    .update(cx, |hub, cx| {
                        match event {
                            ChannelEvent::DecodeError(_) => {}
                            ChannelEvent::Message(message) => {
                                let events = hub.state.apply(message);
                                let config = cx.global::<crate::storage::Local>().config();
                                if config.notifications && !crate::platform::app_is_active() {
                                    for event in events {
                                        let kind = match event.kind {
                                            tempo_client::state::hub::NotifyKind::Finished => {
                                                crate::platform::NotifyKind::Finished
                                            }
                                            tempo_client::state::hub::NotifyKind::NeedsInput => {
                                                crate::platform::NotifyKind::NeedsInput
                                            }
                                            tempo_client::state::hub::NotifyKind::Error => {
                                                crate::platform::NotifyKind::Error
                                            }
                                        };
                                        let notice =
                                            crate::platform::notice(kind, &event.workspace);
                                        let sound = config.sound;
                                        let (tx, rx) = async_channel::bounded(1);
                                        crate::platform::notification_permission(
                                            move |permission| {
                                                let _ = tx.try_send(permission);
                                            },
                                        );
                                        cx.spawn(async move |this, cx| {
                                            if let Ok(permission) = rx.recv().await {
                                                let _ = this.update(cx, |_, cx| {
                                                    let config = cx
                                                        .global::<crate::storage::Local>()
                                                        .config();
                                                    if crate::platform::should_notify(
                                                        crate::platform::app_is_active(),
                                                        permission,
                                                        config.notifications,
                                                    ) {
                                                        crate::platform::notify(&notice, sound);
                                                    }
                                                });
                                            }
                                        })
                                        .detach();
                                    }
                                }
                            }
                            ChannelEvent::Status(status) => {
                                hub.reconnect_bar_task.take();
                                hub.connection = match status {
                                    Status::Open => Connection::Open,
                                    Status::Down { since } => {
                                        hub.reconnect_bar_task =
                                            Some(cx.spawn(async move |this, cx| {
                                                cx.background_executor()
                                                    .timer(super::RECONNECTING_BAR_AFTER)
                                                    .await;
                                                let _ = this.update(cx, |_, cx| cx.notify());
                                            }));
                                        Connection::Down(since)
                                    }
                                    _ => Connection::Closed,
                                }
                            }
                        }
                        crate::platform::set_badge_count(hub.state.attention_count());
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
        let request = client.call::<ListProjects>(Default::default());
        self.projects_task = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |hub, cx| {
                match result {
                    Ok(projects) => hub.projects = projects,
                    Err(_) => hub.project_error = true,
                }
                hub.projects_ready = true;
                cx.notify();
            });
        }));
    }
}

impl Default for HubStore {
    fn default() -> Self {
        Self::new()
    }
}
