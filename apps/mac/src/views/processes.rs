use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::Button;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Subscription, Task, Window, div, uniform_list,
};
use std::collections::BTreeMap;
use tempo_client::{ChannelEvent, Client, TerminalFrame, TerminalHandle};
use tempo_protocol::{self as p, api};

struct RemoteTerminal {
    view: Entity<tempo_terminal::TerminalView>,
    _channel: TerminalHandle,
    _output: Task<()>,
    _input: Task<()>,
}
pub struct ProcessPanel {
    store: Entity<WorkspaceStore>,
    client: Client,
    tab: usize,
    script: Option<String>,
    run: Option<String>,
    pending: bool,
    history: Vec<p::ScriptRunWithLog>,
    error: Option<String>,
    terminals: BTreeMap<String, RemoteTerminal>,
    terminal: Option<String>,
    terminal_ids: Vec<String>,
    _changed: Subscription,
}
impl ProcessPanel {
    pub fn new(store: Entity<WorkspaceStore>, client: Client, cx: &mut Context<Self>) -> Self {
        let changed = cx.observe(&store, |_, _, cx| cx.notify());
        let mut this = Self {
            store,
            client,
            tab: 0,
            script: None,
            run: None,
            pending: false,
            history: vec![],
            error: None,
            terminals: BTreeMap::new(),
            terminal: None,
            terminal_ids: vec![],
            _changed: changed,
        };
        this.refresh(cx);
        this.discover_terminals(cx);
        this
    }
    fn id(&self, cx: &gpui_kit::App) -> String {
        self.store.read(cx).workspace_id.clone()
    }
    /// Selects the Setup tab (04: `setting_up` and `View output` open it).
    pub fn show_setup(&mut self, cx: &mut Context<Self>) {
        if self.tab != 0 {
            self.tab = 0;
            cx.notify();
        }
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let request = self
            .client
            .call::<api::ListScriptRuns>(p::ListScriptRunsIn {
                workspace_id: self.id(cx),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(runs) => this.history = runs,
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub fn toggle_default_run(&mut self, cx: &mut Context<Self>) {
        self.script = self.store.read(cx).state.workspace.as_ref().and_then(|w| {
            w.settings
                .scripts
                .run
                .iter()
                .find(|(_, s)| s.default)
                .map(|(id, _)| id.clone())
        });
        self.toggle_run(cx);
    }
    pub fn toggle_run(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let store = self.store.read(cx);
        let Some(workspace) = &store.state.workspace else {
            return;
        };
        let script = self.script.clone().or_else(|| {
            workspace
                .settings
                .scripts
                .run
                .iter()
                .find(|(_, s)| s.default)
                .map(|(id, _)| id.clone())
        });
        let Some(script) = script else {
            self.error = Some("No default run script.".into());
            cx.notify();
            return;
        };
        let running = store
            .state
            .script_runs
            .values()
            .find(|r| {
                r.script_id.as_ref() == Some(&script) && r.status == p::ScriptRunStatus::Running
            })
            .map(|r| r.id.clone())
            .or_else(|| {
                self.history
                    .iter()
                    .find(|r| {
                        !store.state.script_runs.contains_key(&r.id)
                            && r.script_id.as_ref() == Some(&script)
                            && r.status == p::ScriptRunStatus::Running
                    })
                    .map(|r| r.id.clone())
            });
        self.pending = true;
        let id = self.id(cx);
        if let Some(run_id) = running {
            let request = self.client.call::<api::StopScript>(p::StopScriptIn {
                workspace_id: id,
                run_id,
            });
            cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = this.update(cx, |this, cx| {
                    this.pending = false;
                    if let Err(e) = result {
                        super::toast::error_in_main_window(&e, None, cx);
                    }
                    this.refresh(cx);
                    cx.notify();
                });
            })
            .detach();
        } else {
            let request = self.client.call::<api::RunScript>(p::RunScriptIn {
                workspace_id: id,
                script_id: script,
            });
            cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = this.update(cx, |this, cx| {
                    this.pending = false;
                    match result {
                        Ok(run) => this.run = Some(run.id),
                        Err(e) => super::toast::error_in_main_window(&e, None, cx),
                    }
                    this.refresh(cx);
                    cx.notify();
                });
            })
            .detach();
        }
    }
    fn rerun_setup(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.pending = true;
        let request = self.client.call::<api::RerunSetup>(p::RerunSetupIn {
            workspace_id: self.id(cx),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(run) => this.run = Some(run.id),
                    Err(e) => super::toast::error_in_main_window(&e, None, cx),
                }
                this.refresh(cx);
                cx.notify();
            });
        })
        .detach();
    }
    fn continue_setup(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.pending = true;
        let request =
            self.client
                .call::<api::ContinueAfterSetupFailure>(p::ContinueAfterSetupFailureIn {
                    workspace_id: self.id(cx),
                });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if let Err(e) = result {
                    super::toast::error_in_main_window(&e, None, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn discover_terminals(&mut self, cx: &mut Context<Self>) {
        let request = self.client.call::<api::ListTerminals>(p::ListTerminalsIn {
            workspace_id: self.id(cx),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if let Ok(rows) = result {
                    for row in rows {
                        if tempo_client::TERMINAL_IDS.contains(&row.terminal_id.as_str())
                            && !this.terminal_ids.contains(&row.terminal_id)
                        {
                            this.terminal_ids.push(row.terminal_id);
                        }
                    }
                    this.terminal_ids.sort();
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn close_terminal(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.terminal.take() {
            self.terminals.remove(&id);
            self.terminal_ids.retain(|s| s != &id);
        }
        self.terminal = self.terminal_ids.first().cloned();
        if let Some(id) = self.terminal.clone() {
            self.open_terminal(id, cx);
        }
        cx.notify();
    }
    fn open_terminal(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.terminal_ids.contains(&id) {
            self.terminal_ids.push(id.clone());
            self.terminal_ids.sort();
        }
        self.terminal = Some(id.clone());
        if self.terminals.contains_key(&id) {
            cx.notify();
            return;
        }
        let Ok((events, channel)) = self.client.open_terminal(&self.id(cx), &id, 80, 24) else {
            return;
        };
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
                    ChannelEvent::Status(status)
                        if this
                            .update(cx, |this, cx| {
                                this.error = match status {
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
        let terminal_id = id.clone();
        let input_task = cx.spawn(async move |this, cx| {
            while let Ok(event) = remote.input.recv().await {
                let frame = match event {
                    tempo_terminal::TerminalInput::Bytes(bytes) => {
                        tempo_client::TerminalInput::Keys(bytes)
                    }
                    tempo_terminal::TerminalInput::Resize { cols, rows } => {
                        let queued = this
                            .update(cx, |p, _| {
                                p.terminals
                                    .get(&terminal_id)
                                    .is_some_and(|t| t._channel.resize(cols, rows))
                            })
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
        self.terminals.insert(
            id,
            RemoteTerminal {
                view,
                _channel: channel,
                _output: output,
                _input: input_task,
            },
        );
        cx.notify();
    }
    fn add_terminal(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = tempo_client::TERMINAL_IDS
            .iter()
            .find(|id| !self.terminal_ids.iter().any(|s| s == *id))
        {
            self.open_terminal((*id).into(), cx);
        }
    }
}
impl Render for ProcessPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let store = self.store.read(cx);
        let workspace = store.state.workspace.clone();
        let kind = if self.tab == 0 {
            p::ScriptKind::Setup
        } else {
            p::ScriptKind::Run
        };
        let mut runs: Vec<_> = store
            .state
            .script_runs
            .values()
            .filter(|r| r.kind == kind)
            .map(|r| {
                (
                    r.id.clone(),
                    r.started_at,
                    format!(
                        "{} · {}",
                        r.script_id.as_deref().unwrap_or("Setup"),
                        r.status
                    ),
                )
            })
            .collect();
        for run in self.history.iter().filter(|r| r.kind == kind) {
            if !runs.iter().any(|(id, _, _)| id == &run.id) {
                runs.push((
                    run.id.clone(),
                    run.started_at,
                    format!(
                        "{} · {}",
                        run.script_id.as_deref().unwrap_or("Setup"),
                        run.status
                    ),
                ));
            }
        }
        runs.sort_by(|a, b| b.1.total_cmp(&a.1));
        let selected = self
            .run
            .clone()
            .filter(|id| runs.iter().any(|r| &r.0 == id))
            .or_else(|| runs.first().map(|r| r.0.clone()));
        let output = selected
            .as_ref()
            .and_then(|id| {
                store.state.script_output.get(id).cloned().or_else(|| {
                    self.history
                        .iter()
                        .find(|r| &r.id == id)
                        .map(|r| r.log_tail.clone())
                })
            })
            .unwrap_or_default();
        let lines: Vec<String> = output.lines().map(Into::into).collect();
        let scripts: Vec<_> = workspace
            .as_ref()
            .map(|w| w.settings.scripts.run.keys().cloned().collect())
            .unwrap_or_default();
        let warnings = workspace
            .as_ref()
            .and_then(|w| w.settings_warnings.clone())
            .unwrap_or_default();
        let errors = workspace
            .as_ref()
            .and_then(|w| w.settings_errors.clone())
            .unwrap_or_default();
        let no_setup_script = workspace
            .as_ref()
            .is_some_and(|w| w.settings.scripts.setup.trim().is_empty());
        let body = if self.tab == 0 && no_setup_script {
            v_flex()
                .size_full()
                .gap_2()
                .p_3()
                .children(
                    warnings
                        .iter()
                        .chain(&errors)
                        .map(|w| div().p_1().child(w.clone())),
                )
                .child("No setup script.")
                .child(
                    Button::new("open-project-settings")
                        .label("Open project settings")
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(crate::actions::OpenSettings), cx)
                        }),
                )
                .into_any_element()
        } else if self.tab == 2 {
            v_flex()
                .size_full()
                .child(
                    h_flex()
                        .gap_1()
                        .children(self.terminal_ids.iter().map(|id| {
                            let id = id.clone();
                            Button::new(SharedString::from(format!("term-{id}")))
                                .label(id.clone())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.open_terminal(id.clone(), cx)
                                }))
                        }))
                        .child(
                            Button::new("add-terminal")
                                .label("+")
                                .disabled(self.terminal_ids.len() >= 9)
                                .on_click(cx.listener(|this, _, _, cx| this.add_terminal(cx))),
                        ),
                )
                .child(
                    Button::new("close-terminal")
                        .label("Close terminal")
                        .on_click(cx.listener(|this, _, _, cx| this.close_terminal(cx))),
                )
                .child(
                    div().flex_1().min_h_0().children(
                        self.terminal
                            .as_ref()
                            .and_then(|id| self.terminals.get(id))
                            .map(|t| t.view.clone()),
                    ),
                )
                .into_any_element()
        } else {
            v_flex()
                .size_full()
                .p_3()
                .gap_2()
                .children((self.tab == 0).then(|| {
                    div().child(format!(
                        "Setup: {}",
                        workspace
                            .as_ref()
                            .map(|w| w.setup_status.to_string())
                            .unwrap_or_default()
                    ))
                }))
                .children((self.tab == 0).then(|| {
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("rerun-setup")
                                .small()
                                .label("Rerun setup")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, _, cx| this.rerun_setup(cx))),
                        )
                        .children(
                            workspace
                                .as_ref()
                                .is_some_and(|w| w.setup_status == p::SetupStatus::Failed)
                                .then(|| {
                                    Button::new("continue-setup")
                                        .small()
                                        .label("Continue anyway")
                                        .disabled(self.pending)
                                        .on_click(
                                            cx.listener(|this, _, _, cx| this.continue_setup(cx)),
                                        )
                                }),
                        )
                }))
                .children((self.tab == 1).then(|| {
                    h_flex()
                        .gap_1()
                        .children(scripts.into_iter().map(|id: String| {
                            Button::new(SharedString::from(format!("script-{id}")))
                                .label(id.clone())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.script = Some(id.clone());
                                    this.run = None;
                                    cx.notify();
                                }))
                        }))
                        .child(
                            Button::new("toggle-script")
                                .small()
                                .label("Start / Stop")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, _, cx| this.toggle_run(cx))),
                        )
                }))
                .children(
                    warnings
                        .into_iter()
                        .chain(errors)
                        .map(|w| div().p_1().child(w)),
                )
                .child(
                    h_flex()
                        .gap_1()
                        .children(runs.into_iter().map(|(id, _, label)| {
                            Button::new(SharedString::from(format!("run-{id}")))
                                .label(label)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.run = Some(id.clone());
                                    cx.notify();
                                }))
                        })),
                )
                .child(
                    uniform_list(
                        "script-output",
                        lines.len(),
                        cx.processor(move |_, range: std::ops::Range<usize>, _, _| {
                            range
                                .map(|i| {
                                    div()
                                        .font_family("monospace")
                                        .whitespace_nowrap()
                                        .child(lines[i].clone())
                                })
                                .collect()
                        }),
                    )
                    .flex_1(),
                )
                .into_any_element()
        };
        v_flex()
            .size_full()
            .child(
                TabBar::new("process-tabs")
                    .selected_index(self.tab)
                    .children(["Setup", "Run", "Terminal"].map(|t| Tab::new().label(t)))
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.tab = *ix;
                        this.run = None;
                        this.refresh(cx);
                        if *ix == 2 && this.terminal.is_none() {
                            this.add_terminal(cx);
                        }
                        cx.notify();
                    })),
            )
            .children(self.error.clone().map(|e| div().p_2().child(e)))
            .child(div().flex_1().min_h_0().child(body))
    }
}
