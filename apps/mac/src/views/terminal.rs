use gpui_kit::component::v_flex;
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _, Task,
    Window, div,
};
use tempo_client::{ChannelEvent, Client, TerminalFrame, TerminalHandle};

/// One terminal tool tab. Dropping it closes the channel; the tmux session keeps running.
pub struct RemoteTerminal {
    view: Entity<tempo_terminal::TerminalView>,
    channel: TerminalHandle,
    error: Option<String>,
    _output: Task<()>,
    _input: Task<()>,
}
impl RemoteTerminal {
    pub fn open(
        client: &Client,
        workspace_id: &str,
        terminal_id: &str,
        cx: &mut gpui_kit::App,
    ) -> Option<Entity<Self>> {
        let (events, channel) = client
            .open_terminal(workspace_id, terminal_id, 80, 24)
            .ok()?;
        Some(cx.new(|cx: &mut Context<Self>| {
            let input = channel.input();
            let (io, remote) = tempo_terminal::TerminalIo::pair();
            let view = cx.new(|cx| tempo_terminal::TerminalView::new(io, cx));
            let output = cx.spawn(async move |this, cx| {
                while let Ok(event) = events.recv().await {
                    match event {
                        ChannelEvent::Message(TerminalFrame::Output(bytes)) => {
                            if remote.output.send(bytes).await.is_err() {
                                break;
                            }
                        }
                        // The server ignores a resize sent before the process starts, so send the size again.
                        ChannelEvent::Message(TerminalFrame::Ready) => {
                            let _ = this.update(cx, |t, cx| {
                                let (cols, rows) = t.view.read(cx).state.size();
                                t.channel.resize(cols, rows);
                            });
                        }
                        ChannelEvent::Status(status)
                            if this
                                .update(cx, |t, cx| {
                                    t.error = match status {
                                        tempo_client::Status::Down { .. } => {
                                            Some("Reconnecting…".into())
                                        }
                                        tempo_client::Status::Closed(_) => {
                                            Some("Terminal disconnected.".into())
                                        }
                                        _ => None,
                                    };
                                    cx.notify();
                                })
                                .is_err() =>
                        {
                            break;
                        }
                        _ => {}
                    }
                }
            });
            let input_task = cx.spawn(async move |this, cx| {
                while let Ok(event) = remote.input.recv().await {
                    let frame = match event {
                        tempo_terminal::TerminalInput::Bytes(bytes) => {
                            tempo_client::TerminalInput::Keys(bytes)
                        }
                        tempo_terminal::TerminalInput::Resize { cols, rows } => {
                            let queued = this
                                .update(cx, |t, _| t.channel.resize(cols, rows))
                                .unwrap_or(false);
                            if queued {
                                continue;
                            }
                            tempo_client::TerminalInput::Resize { cols, rows }
                        }
                    };
                    if input.send(frame).await.is_err() {
                        break;
                    }
                }
            });
            Self {
                view,
                channel,
                error: None,
                _output: output,
                _input: input_task,
            }
        }))
    }
}
impl Render for RemoteTerminal {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .size_full()
            .children(self.error.clone().map(|e| div().px_3().pt_2().child(e)))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .px_3()
                    .py_2()
                    .child(self.view.clone()),
            )
    }
}
