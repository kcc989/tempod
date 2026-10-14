use crate::terminal_launch::TerminalApplication;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _, Task,
    Window, div,
};
use tempo_client::{ChannelEvent, Client, TerminalFrame, TerminalHandle};

/// One terminal tool tab. Dropping it closes the channel; the tmux session keeps running.
pub struct RemoteTerminal {
    view: Entity<tempo_terminal::TerminalView>,
    channel: TerminalHandle,
    workspace_id: String,
    terminal_id: String,
    launch_pending: bool,
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
                workspace_id: workspace_id.into(),
                terminal_id: terminal_id.into(),
                launch_pending: false,
                error: None,
                _output: output,
                _input: input_task,
            }
        }))
    }
}
impl RemoteTerminal {
    /// 07: the same cloud session in Terminal or iTerm through the bundled `tempo` bridge.
    fn open_external(&mut self, application: TerminalApplication, cx: &mut Context<Self>) {
        if self.launch_pending {
            return;
        }
        self.launch_pending = true;
        self.error = None;
        let (workspace, terminal) = (self.workspace_id.clone(), self.terminal_id.clone());
        let (send, result) = async_channel::bounded(1);
        std::thread::spawn(move || {
            let _ = send.send_blocking(crate::terminal_launch::open(
                application,
                &workspace,
                &terminal,
            ));
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = result.recv().await {
                let _ = this.update(cx, |t, cx| {
                    t.launch_pending = false;
                    t.error = result.err().map(String::from);
                    cx.notify();
                });
            }
        })
        .detach();
        cx.notify();
    }
}
impl Render for RemoteTerminal {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let launch = |id: &'static str, label: &'static str, app: TerminalApplication| {
            Button::new(id)
                .ghost()
                .small()
                .label(label)
                .disabled(self.launch_pending)
                .on_click(cx.listener(move |this, _, _, cx| this.open_external(app, cx)))
        };
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .px_3()
                    .pt_1()
                    .gap_1()
                    .justify_end()
                    .child(launch(
                        "open-terminal-app",
                        "Open in Terminal",
                        TerminalApplication::Terminal,
                    ))
                    .child(launch(
                        "open-iterm-app",
                        "Open in iTerm",
                        TerminalApplication::ITerm,
                    )),
            )
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
