use super::tokens::{Token, color};
use super::tools::Tool;
use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, Window, div,
};
use tempo_client::Client;
use tempo_protocol::{self as p, api};

#[derive(Clone)]
pub enum InfoAction {
    Wake,
    Sleep,
    Environment,
    Diagnostics,
    ResetPreview,
    Archive,
    CopyLink,
    Close,
    OpenChat(String),
    OpenTool(Tool),
    GenerateGuide,
    OpenGuideReview,
}
impl EventEmitter<InfoAction> for WorkspaceInfo {}

pub struct WorkspaceInfo {
    controls_open: bool,
    store: Entity<WorkspaceStore>,
    client: Client,
    query: Entity<InputState>,
    pub(super) branches: Vec<String>,
    pub(super) branch_error: Option<String>,
    branch_generation: u64,
    search_task: Option<Task<()>>,
    pub(super) branch_pending: bool,
    artifacts: Option<Vec<p::Artifact>>,
    artifacts_error: Option<String>,
    metadata_revision: (u64, usize),
    terminals: Vec<String>,
    _subscriptions: Vec<Subscription>,
}
impl WorkspaceInfo {
    pub fn new(
        store: Entity<WorkspaceStore>,
        client: Client,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search branches"));
        let changed = cx.observe(&store, |this, store, cx| {
            let state = &store.read(cx).state;
            let revision = (
                state.changes_seq,
                state
                    .turns
                    .values()
                    .filter(|t| !matches!(t.status, p::TurnStatus::Running | p::TurnStatus::Queued))
                    .count(),
            );
            if revision != this.metadata_revision {
                this.metadata_revision = revision;
                this.refresh(cx);
            }
            cx.notify();
        });
        let searched = cx.subscribe(&query, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.branch_generation += 1;
                this.search_task = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(200))
                        .await;
                    let _ = this.update(cx, |this, cx| this.search_branches(cx));
                }));
            }
        });
        let mut this = Self {
            controls_open: false,
            store,
            client,
            query,
            branches: vec![],
            branch_error: None,
            branch_generation: 0,
            search_task: None,
            branch_pending: false,
            artifacts: None,
            artifacts_error: None,
            metadata_revision: (0, 0),
            terminals: vec![],
            _subscriptions: vec![changed, searched],
        };
        this.refresh(cx);
        this
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .is_some_and(|w| {
                matches!(
                    w.state,
                    p::WorkspaceState::Ready | p::WorkspaceState::Working
                )
            })
        {
            let request = self.client.call::<api::ListTerminals>(p::ListTerminalsIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
            });
            cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = this.update(cx, |this, cx| {
                    if let Ok(rows) = result {
                        this.terminals = rows.into_iter().map(|r| r.terminal_id).collect();
                    }
                    cx.notify();
                });
            })
            .detach();
        } else {
            self.terminals.clear();
        }

        let request = self.client.call::<api::ListArtifacts>(p::ListArtifactsIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(data) => {
                        this.artifacts = Some(data);
                        this.artifacts_error = None;
                    }
                    Err(e) => this.artifacts_error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn search_branches(&mut self, cx: &mut Context<Self>) {
        let Some(w) = self.store.read(cx).state.workspace.clone() else {
            return;
        };
        self.branch_generation += 1;
        let generation = self.branch_generation;
        let query = self.query.read(cx).value().to_string();
        let request = self.client.call::<api::ListBranches>(p::ListBranchesIn {
            project_id: w.project_id,
            query: (!query.is_empty()).then_some(query),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.branch_generation {
                    return;
                }
                match result {
                    Ok(data) => {
                        this.branches = data
                            .into_iter()
                            .map(|b| b.name)
                            .filter(|name| *name != w.branch)
                            .collect();
                        this.branch_error = None;
                    }
                    Err(e) => this.branch_error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn pick_branch(&mut self, branch: String, cx: &mut Context<Self>) {
        if self.branch_pending {
            return;
        }
        let Some(w) = self.store.read(cx).state.workspace.clone() else {
            return;
        };
        if branch == w.base_branch
            || w.pr_number.is_some()
            || matches!(
                w.state,
                p::WorkspaceState::Archived | p::WorkspaceState::Archiving
            )
        {
            return;
        }
        let Ok(base_branch) = branch.try_into() else {
            return;
        };
        let request = self.client.call::<api::SetBaseBranch>(p::SetBaseBranchIn {
            workspace_id: w.id,
            base_branch,
        });
        self.branch_pending = true;
        self.branch_error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.branch_pending = false;
                if let Err(e) = result {
                    this.branch_error = Some(super::toast::error_text(&e, None));
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn row(&self, id: String, label: String, action: InfoAction, cx: &mut Context<Self>) -> Button {
        let icon = match &action {
            InfoAction::OpenChat(_) => gpui_kit::assets::IconName::MessageCircle,
            InfoAction::OpenTool(Tool::Guides) => gpui_kit::assets::IconName::BookOpen,
            InfoAction::OpenTool(Tool::Changes) => gpui_kit::assets::IconName::FileDiff,
            InfoAction::OpenTool(Tool::Artifacts) => gpui_kit::assets::IconName::Boxes,
            InfoAction::OpenTool(_) => gpui_kit::assets::IconName::Terminal,
            InfoAction::Environment => gpui_kit::assets::IconName::Settings,
            InfoAction::Diagnostics => gpui_kit::assets::IconName::Info,
            InfoAction::Archive => gpui_kit::assets::IconName::Archive,
            InfoAction::CopyLink => gpui_kit::assets::IconName::Link,
            _ => gpui_kit::assets::IconName::RotateCcw,
        };
        Button::new(SharedString::from(id))
            .ghost()
            .w_full()
            .small()
            .h(gpui_kit::px(32.))
            .accessibility_label(label.clone())
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_2()
                    .child(gpui_kit::component::Icon::new(icon).small())
                    .child(div().flex_1().min_w_0().text_left().truncate().child(label)),
            )
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(action.clone())))
    }
    fn heading(label: &str, cx: &gpui_kit::App) -> gpui_kit::Div {
        div()
            .mt_4()
            .mb_1()
            .pt_3()
            .border_t_1()
            .border_color(color(Token::Border, cx))
            .text_sm()
            .text_color(color(Token::MutedForeground, cx))
            .child(label.to_string())
    }
    fn branch_picker(&self, w: &p::WorkspaceDetail, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.query.clone();
        let weak = cx.weak_entity();
        let branches = self.branches.clone();
        let error = self.branch_error.clone();
        let workspace = w.clone();
        let pending = self.branch_pending;
        let trigger = Button::new("info-base-branch")
            .accessibility_label(format!("Base branch: {}", w.base_branch))
            .ghost()
            .w_full()
            .child(
                div()
                    .w_full()
                    .text_left()
                    .truncate()
                    .child(format!("Base: {}", w.base_branch)),
            )
            .disabled(
                pending
                    || w.pr_number.is_some()
                    || matches!(
                        w.state,
                        p::WorkspaceState::Archived | p::WorkspaceState::Archiving
                    ),
            );
        Popover::new("info-base-branch-picker")
            .track_focus(&self.query.read(cx).focus_handle(cx))
            .trigger(trigger)
            .on_open_change(cx.listener(|this, open, window, cx| {
                if *open {
                    this.query.update(cx, |q, cx| q.focus(window, cx));
                    this.search_branches(cx);
                }
            }))
            .content(move |_, _, _| {
                let mut body = v_flex()
                    .w(gpui_kit::px(280.))
                    .gap_1()
                    .child(Input::new(&query));
                if let Some(e) = &error {
                    body = body.child(e.clone());
                }
                body.children(
                    branches
                        .iter()
                        .filter(|name| **name != workspace.branch)
                        .enumerate()
                        .map(|(i, name)| {
                            let branch = name.clone();
                            let weak = weak.clone();
                            Button::new(("info-branch", i))
                                .ghost()
                                .w_full()
                                .disabled(pending)
                                .accessibility_label(name.clone())
                                .child(
                                    h_flex()
                                        .w_full()
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .text_left()
                                                .truncate()
                                                .child(name.clone()),
                                        )
                                        .children((name == &workspace.base_branch).then(|| {
                                            gpui_kit::component::Icon::new(
                                                gpui_kit::assets::IconName::Check,
                                            )
                                            .small()
                                        })),
                                )
                                .on_click(move |_, _, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.pick_branch(branch.clone(), cx);
                                    });
                                })
                        }),
                )
                .max_h(gpui_kit::px(300.))
                .id("info-branches")
                .overflow_y_scroll()
                .into_any_element()
            })
    }
}
impl Render for WorkspaceInfo {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (workspace, mut chats, runs, changes) = {
            let s = &self.store.read(cx).state;
            (
                s.workspace.clone(),
                s.sessions
                    .values()
                    .filter(|s| s.status != p::SessionStatus::Closed && s.role_run_id.is_none())
                    .cloned()
                    .collect::<Vec<_>>(),
                s.script_runs
                    .values()
                    .filter(|r| r.status == p::ScriptRunStatus::Running)
                    .cloned()
                    .collect::<Vec<_>>(),
                s.changes.clone(),
            )
        };
        let Some(w) = workspace else {
            return div().p_4().child("Loading workspace…").into_any_element();
        };
        chats.sort_by(|a, b| a.sort_order.total_cmp(&b.sort_order));
        let title = crate::app::AppState::try_global(cx)
            .and_then(|a| {
                a.read(cx)
                    .hub
                    .read(cx)
                    .projects
                    .iter()
                    .find(|p| p.id == w.project_id)
                    .map(|p| format!("{}/{}", p.owner, p.name))
            })
            .unwrap_or_else(|| w.title.clone());
        let sleep = w.state == p::WorkspaceState::Sleeping;
        let changes = changes.or(w.changes.clone());
        let state = match w.state {
            p::WorkspaceState::Sleeping => "Sleeping".into(),
            p::WorkspaceState::Working | p::WorkspaceState::Ready => "Running".into(),
            p::WorkspaceState::Error => "Needs attention".into(),
            _ => w.state.to_string(),
        };
        let body = v_flex()
            .id("workspace-info")
            .w_full()
            .max_h(gpui_kit::relative(1.))
            .p_4()
            .rounded(gpui_kit::px(16.))
            .bg(color(Token::Muted, cx))
            .overflow_y_scroll()
            .gap_2()
            .child(
                h_flex()
                    .child(div().flex_1().min_w_0().truncate().child(title))
                    .child(
                        Button::new("close-workspace-info")
                            .ghost()
                            .small()
                            .icon(gpui_kit::assets::IconName::X)
                            .accessibility_label("Close Info")
                            .tooltip("Close Info")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(InfoAction::Close))),
                    ),
            )
            .child(
                h_flex().child(div().flex_1().child(state)).child(
                    Button::new("info-power")
                        .outline()
                        .small()
                        .label(if sleep { "Wake" } else { "Sleep" })
                        .disabled(!matches!(
                            w.state,
                            p::WorkspaceState::Sleeping
                                | p::WorkspaceState::Ready
                                | p::WorkspaceState::Working
                        ))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(if sleep {
                                InfoAction::Wake
                            } else {
                                InfoAction::Sleep
                            })
                        })),
                ),
            )
            .child(
                Button::new("info-changes")
                    .ghost()
                    .small()
                    .w_full()
                    .h(gpui_kit::px(32.))
                    .accessibility_label("Changes")
                    .child(
                        h_flex()
                            .w_full()
                            .gap_2()
                            .child(
                                gpui_kit::component::Icon::new(
                                    gpui_kit::assets::IconName::FileDiff,
                                )
                                .small(),
                            )
                            .child(div().flex_1().text_left().child("Changes"))
                            .children(changes.map(|c| {
                                h_flex()
                                    .gap_1()
                                    .child(
                                        div()
                                            .text_color(color(Token::Success, cx))
                                            .child(format!("+{}", c.additions)),
                                    )
                                    .child(
                                        div()
                                            .text_color(color(Token::Destructive, cx))
                                            .child(format!("−{}", c.deletions)),
                                    )
                            })),
                    )
                    .on_click(
                        cx.listener(|_, _, _, cx| cx.emit(InfoAction::OpenTool(Tool::Changes))),
                    ),
            )
            .child(self.row(
                "info-guides".into(),
                "Guides".into(),
                InfoAction::OpenTool(Tool::Guides),
                cx,
            ))
            .children((!chats.is_empty()).then(|| Self::heading("Open chats", cx)))
            .children(chats.into_iter().map(|s| {
                self.row(
                    format!("info-chat-{}", s.id),
                    if s.status == p::SessionStatus::Idle {
                        s.title.clone()
                    } else {
                        format!("{} · {}", s.title, s.status)
                    },
                    InfoAction::OpenChat(s.id),
                    cx,
                )
            }))
            .children(
                (!runs.is_empty() || !self.terminals.is_empty())
                    .then(|| Self::heading("Running processes", cx)),
            )
            .children(runs.into_iter().map(|r| {
                self.row(
                    format!("info-process-{}", r.id),
                    format!("{} · Running", r.script_id.unwrap_or("Setup".into())),
                    InfoAction::OpenTool(if r.kind == p::ScriptKind::Setup {
                        Tool::Setup
                    } else {
                        Tool::Run
                    }),
                    cx,
                )
            }))
            .children((!self.terminals.is_empty()).then(|| {
                self.row(
                    "info-terminals".into(),
                    format!("Terminals · {}", self.terminals.len()),
                    InfoAction::OpenTool(Tool::Terminal),
                    cx,
                )
            }))
            .child(Self::heading("Artifacts", cx))
            .child(
                self.row(
                    "info-artifacts".into(),
                    self.artifacts
                        .as_ref()
                        .map(|a| format!("Open artifacts · {}", a.len()))
                        .unwrap_or("Open artifacts".into()),
                    InfoAction::OpenTool(Tool::Artifacts),
                    cx,
                ),
            )
            .children(
                self.artifacts_error
                    .clone()
                    .map(|e| div().text_color(color(Token::MutedForeground, cx)).child(e)),
            )
            .child(
                Button::new("info-controls-disclosure")
                    .ghost()
                    .w_full()
                    .small()
                    .h(gpui_kit::px(32.))
                    .accessibility_label(if self.controls_open {
                        "Workspace controls, expanded"
                    } else {
                        "Workspace controls, collapsed"
                    })
                    .child(
                        h_flex()
                            .w_full()
                            .gap_2()
                            .child(
                                gpui_kit::component::Icon::new(
                                    gpui_kit::assets::IconName::Settings,
                                )
                                .small(),
                            )
                            .child(div().flex_1().text_left().child("Workspace controls"))
                            .child(
                                gpui_kit::component::Icon::new(if self.controls_open {
                                    gpui_kit::assets::IconName::ChevronDown
                                } else {
                                    gpui_kit::assets::IconName::ChevronRight
                                })
                                .small(),
                            ),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.controls_open = !this.controls_open;
                        cx.notify();
                    })),
            )
            .children(self.controls_open.then(|| {
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .font_family("monospace")
                            .child(w.branch.clone()),
                    )
                    .child(self.branch_picker(&w, cx))
                    .child(self.row(
                        "info-copy-link".into(),
                        "Copy workspace link".into(),
                        InfoAction::CopyLink,
                        cx,
                    ))
                    .child(self.row(
                        "info-environment".into(),
                        "Environment…".into(),
                        InfoAction::Environment,
                        cx,
                    ))
                    .child(self.row(
                        "info-diagnostics".into(),
                        "Diagnostics".into(),
                        InfoAction::Diagnostics,
                        cx,
                    ))
                    .child(
                        self.row(
                            "info-preview-access".into(),
                            "Reset preview access".into(),
                            InfoAction::ResetPreview,
                            cx,
                        )
                        .disabled(matches!(
                            w.state,
                            p::WorkspaceState::Archived | p::WorkspaceState::Archiving
                        )),
                    )
                    .child(
                        self.row(
                            "info-archive".into(),
                            "Archive workspace".into(),
                            InfoAction::Archive,
                            cx,
                        )
                        .disabled(!matches!(
                            w.state,
                            p::WorkspaceState::Sleeping
                                | p::WorkspaceState::Ready
                                | p::WorkspaceState::Working
                                | p::WorkspaceState::Error
                        )),
                    )
            }));
        body.into_any_element()
    }
}
