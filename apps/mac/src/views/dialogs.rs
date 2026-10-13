use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::{Disableable as _, Selectable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div,
};
use tempo_protocol::{self as p, api};

pub struct Dialogs {
    pub kind: Option<&'static str>,
    workspace_id: Option<String>,
    chat_created: Option<Box<dyn Fn(p::Session, &mut Window, &mut gpui_kit::App)>>,
    created_chat: Option<p::Session>,
    modal_window: Option<gpui_kit::AnyWindowHandle>,
    client: Option<tempo_client::Client>,
    projects: Vec<p::Project>,
    project: Option<String>,
    source: usize,
    branch: Entity<InputState>,
    prompt: Entity<TextareaState>,
    agent: Option<p::AgentId>,
    models: Vec<p::AgentModelOptions>,
    model: Option<String>,
    /// A custom agent picked in the model menu; its base agent is `agent` (04, New workspace).
    custom_agent: Option<String>,
    custom_agents: Vec<p::CustomAgentSummary>,
    models_loading: bool,
    workspace_options: bool,
    branches: Vec<p::ListBranchesItem>,
    branch_search: Option<gpui_kit::Task<()>>,
    prs: Vec<p::ListOpenPullRequestsItem>,
    installations: Vec<p::ListInstallationsItem>,
    repos: Vec<p::ListInstallationReposItem>,
    repo_search: Entity<InputState>,
    installation: Option<f64>,
    history: Vec<p::WorkspaceSummary>,
    delete: Option<p::WorkspaceSummary>,
    confirm: Entity<InputState>,
    /// The GitHub App's install page (`GET /api/setup/status` → `installUrl`), when known.
    pub install_url: Option<String>,
    installations_loading: bool,
    pending: bool,
    keep_open: bool,
    error: Option<String>,
    _inputs_changed: Vec<gpui_kit::Subscription>,
}
impl Dialogs {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let branch = cx.new(|cx| InputState::new(window, cx).placeholder("Branch or PR number"));
        let branch_changed = cx.subscribe(
            &branch,
            |this, _, event: &gpui_kit::component::input::InputEvent, cx| {
                if matches!(event, gpui_kit::component::input::InputEvent::Change) {
                    this.search_branches(cx);
                }
            },
        );
        let confirm =
            cx.new(|cx| InputState::new(window, cx).placeholder("Type the workspace slug"));
        let mut inputs_changed = vec![cx.observe(&confirm, |_, _, cx| cx.notify())];
        let repo_search = cx.new(|cx| InputState::new(window, cx).placeholder("Search repos"));
        inputs_changed.push(cx.observe(&repo_search, |_, _, cx| cx.notify()));
        inputs_changed.push(branch_changed);
        Self {
            kind: None,
            workspace_id: None,
            chat_created: None,
            created_chat: None,
            modal_window: None,
            client: None,
            projects: vec![],
            project: None,
            source: 0,
            branch,
            prompt: cx.new(|cx| {
                TextareaState::new(window, cx).placeholder("What do you want to work on?")
            }),
            agent: None,
            models: vec![],
            model: None,
            custom_agent: None,
            custom_agents: vec![],
            models_loading: false,
            workspace_options: false,
            branches: vec![],
            branch_search: None,
            prs: vec![],
            installations: vec![],
            repos: vec![],
            repo_search,
            installation: None,
            history: vec![],
            delete: None,
            confirm,
            install_url: None,
            installations_loading: false,
            _inputs_changed: inputs_changed,
            pending: false,
            keep_open: false,
            error: None,
        }
    }
    pub fn show(&mut self, kind: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let app = crate::app::AppState::global(cx);
        self.client = app.read(cx).client();
        self.projects = app.read(cx).hub.read(cx).projects.clone();
        self.kind = Some(kind);
        self.workspace_id = app.read(cx).active_workspace.clone();
        self.modal_window = Some(window.window_handle());
        let form = cx.entity();
        let weak = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let weak = weak.clone();
            dialog
                .title(kind)
                .w(gpui_kit::px(680.))
                .child(form.clone())
                .on_close(move |_, _, cx| {
                    let _ = weak.update(cx, |d, cx| {
                        d.kind = None;
                        cx.notify();
                    });
                })
        });
        if kind == "New workspace" {
            self.source = 0;
            self.workspace_options = false;
            window.focus(&self.prompt.read(cx).focus_handle(cx), cx);
        } else if kind == "Add project" {
            self.repo_search
                .update(cx, |input, cx| input.set_value("", window, cx));
            window.focus(&self.repo_search.read(cx).focus_handle(cx), cx);
        } else {
            window.focus(&self.branch.read(cx).focus_handle(cx), cx);
        }
        self.error = None;
        self.delete = None;
        if let Some(project) = self.projects.first().cloned() {
            self.select_project(project.id, window, cx);
        }
        if kind == "New workspace" {
            self.load_models(cx);
        }
        if kind == "Rename workspace" {
            let title = app
                .read(cx)
                .active_workspace
                .as_ref()
                .and_then(|id| app.read(cx).hub.read(cx).state.workspaces.get(id))
                .map(|w| w.title.clone())
                .unwrap_or_default();
            self.branch
                .update(cx, |i, cx| i.set_value(title, window, cx));
        }
        if kind == "Add project" {
            self.load_installations(cx);
        }
        if kind == "History" {
            self.load_history(cx);
        }
        cx.notify();
    }
    pub fn show_chat(
        &mut self,
        client: tempo_client::Client,
        workspace_id: String,
        agent: p::AgentId,
        on_created: impl Fn(p::Session, &mut Window, &mut gpui_kit::App) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.kind = Some("New chat");
        self.client = Some(client);
        self.workspace_id = Some(workspace_id);
        self.agent = Some(agent);
        self.chat_created = Some(Box::new(on_created));
        self.modal_window = Some(window.window_handle());
        let form = cx.entity();
        let weak = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let weak = weak.clone();
            dialog
                .title("New chat")
                .w(gpui_kit::px(680.))
                .child(form.clone())
                .on_close(move |_, _, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.kind = None;
                        cx.notify();
                    });
                })
        });
        window.focus(&self.prompt.read(cx).focus_handle(cx), cx);
        self.load_models(cx);
        cx.notify();
    }

    fn create_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending
            || self.models_loading
            || (self.model.is_none() && self.custom_agent.is_none())
        {
            return;
        }
        let (Some(client), Some(workspace_id), Some(agent)) =
            (self.client.clone(), self.workspace_id.clone(), self.agent)
        else {
            return;
        };
        let created = self.created_chat.clone();
        let custom_agent_id = self.custom_agent.clone();
        let model = if custom_agent_id.is_some() {
            None
        } else {
            self.model.clone()
        };
        let text = self.prompt.read(cx).value().trim().to_string();
        self.pending = true;
        cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let session = match created {
                    Some(session) => session,
                    None => {
                        client
                            .call::<api::CreateSession>(p::CreateSessionIn {
                                workspace_id: workspace_id.clone(),
                                agent,
                                custom_agent_id,
                                model,
                                mode_id: None,
                            })
                            .await?
                    }
                };
                let _ = this.update_in(cx, |this, _, cx| {
                    this.created_chat = Some(session.clone());
                    cx.notify();
                });
                if !text.is_empty() {
                    client
                        .call::<api::SendPrompt>(p::SendPromptIn {
                            workspace_id,
                            session_id: session.id.clone(),
                            text,
                            mentions: vec![],
                            attachment_ids: vec![],
                            review_comment_ids: vec![],
                            delivery: None,
                        })
                        .await?;
                }
                Ok::<_, tempo_client::ApiError>(session)
            }
            .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(session) => {
                        if let Some(callback) = this.chat_created.take() {
                            callback(session, window, cx);
                        }
                        this.close(cx);
                    }
                    Err(error) => super::toast::error(&error, this.agent, window, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn load_models(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        let agents = client.call::<api::ListCustomAgents>(p::Empty {});
        cx.spawn(async move |this, cx| {
            let result = agents.await;
            let _ = this.update(cx, |this, cx| {
                if let Ok(agents) = result {
                    this.custom_agents = agents;
                }
                cx.notify();
            });
        })
        .detach();
        let request = client.call::<api::ListModels>(Default::default());
        self.models_loading = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.models_loading = false;
                match result {
                    Ok(models) => {
                        this.models = models;
                        let preferred = if this.kind == Some("New chat") {
                            this.agent
                        } else {
                            this.projects
                                .iter()
                                .find(|p| Some(&p.id) == this.project.as_ref())
                                .and_then(|p| p.settings.agent.as_ref())
                                .and_then(|a| a.default)
                        };
                        let entry = this
                            .models
                            .iter()
                            .find(|m| Some(m.agent) == preferred)
                            .or_else(|| this.models.first());
                        if let Some(entry) = entry {
                            this.agent = Some(entry.agent);
                            this.model = entry
                                .options
                                .iter()
                                .find(|o| o.value == entry.current_value)
                                .or_else(|| entry.options.first())
                                .map(|o| o.value.clone());
                        } else {
                            this.agent = None;
                            this.model = None;
                        }
                    }
                    Err(e) => {
                        this.model = None;
                        this.error = Some(e.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn load_installations(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        self.installations_loading = true;
        self.error = None;
        let status = client.server().setup_status();
        cx.spawn(async move |this, cx| {
            if let Ok(status) = status.await {
                let _ = this.update(cx, |this, cx| {
                    this.install_url = status.install_url;
                    cx.notify();
                });
            }
        })
        .detach();
        let request = client.call::<api::ListInstallations>(Default::default());
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.installations_loading = false;
                match result {
                    Ok(out) => {
                        if let Some(first) = out.first().map(|i| i.installation_id)
                            && this.installation.is_none()
                        {
                            this.select_installation(first, cx);
                        }
                        this.installations = out;
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn close(&mut self, cx: &mut Context<Self>) {
        self.kind = None;
        if let Some(handle) = self.modal_window.take() {
            cx.defer(move |cx| {
                let _ = handle.update(cx, |_, window, cx| window.close_dialog(cx));
            });
        }
        cx.notify();
    }
    fn search_branches(&mut self, cx: &mut Context<Self>) {
        if self.kind != Some("New workspace") || self.source == 2 {
            return;
        }
        self.branch_search = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(250))
                .await;
            let request = this
                .update(cx, |this, cx| {
                    let id = this.project.clone()?;
                    let query = this.branch.read(cx).value().to_string();
                    Some((id, query, this.client.clone()?))
                })
                .ok()
                .flatten();
            let Some((id, query, client)) = request else {
                return;
            };
            let result = client
                .call::<api::ListBranches>(p::ListBranchesIn {
                    project_id: id.clone(),
                    query: Some(query.clone()),
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.project.as_ref() != Some(&id)
                    || this.branch.read(cx).value().as_ref() != query
                {
                    return;
                }
                match result {
                    Ok(out) => this.branches = out,
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        }));
    }
    pub fn select_project(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.project = Some(id.clone());
        if let Some(p) = self.projects.iter().find(|p| p.id == id) {
            self.branch.update(cx, |i, cx| {
                i.set_value(p.default_branch.clone(), window, cx)
            });
        }
        self.branches.clear();
        self.prs.clear();
        let Some(client) = &self.client else {
            return;
        };
        let branches = client.call::<api::ListBranches>(p::ListBranchesIn {
            project_id: id.clone(),
            query: None,
        });
        let prs = client.call::<api::ListOpenPullRequests>(p::ListOpenPullRequestsIn {
            project_id: id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let branches = branches.await;
            let prs = prs.await;
            let _ = this.update(cx, |this, cx| {
                if this.project.as_ref() != Some(&id) {
                    return;
                }
                if let Ok(out) = branches {
                    this.branches = out;
                }
                if let Ok(out) = prs {
                    this.prs = out;
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.prompt.read(cx).value().trim().to_string();
        if self.pending
            || (!text.is_empty()
                && (self.models_loading || (self.model.is_none() && self.custom_agent.is_none())))
        {
            return;
        }
        let Some(client) = &self.client else {
            return;
        };
        let Some(project_id) = self.project.clone() else {
            return;
        };
        let branch = self.branch.read(cx).value().to_string();
        let source = match self.source {
            0 => p::NewSource::New {
                base_branch: branch,
            },
            1 => p::NewSource::Branch { branch },
            _ => match branch.parse::<f64>() {
                Ok(number) if number >= 1. && number.fract() == 0. => p::NewSource::Pr { number },
                _ => {
                    self.error = Some("Select a pull request.".into());
                    cx.notify();
                    return;
                }
            },
        };
        let prompt = if text.is_empty() {
            None
        } else {
            match text.try_into() {
                Ok(text) => Some(p::CreateWorkspaceInPrompt { text }),
                Err(_) => {
                    self.error = Some("The prompt is invalid.".into());
                    cx.notify();
                    return;
                }
            }
        };
        let request = client.call::<api::CreateWorkspace>(p::CreateWorkspaceIn {
            project_id,
            source,
            agent: self.agent,
            model: if self.custom_agent.is_some() {
                None
            } else {
                self.model.clone()
            },
            custom_agent_id: self.custom_agent.clone(),
            prompt,
        });
        self.pending = true;
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(w) => {
                        crate::app::AppState::global(cx).update(cx, |a, cx| {
                            a.show_workspace(&w.id, cx);
                        });
                        this.prompt.update(cx, |i, cx| i.set_value("", window, cx));
                        if !this.keep_open {
                            this.close(cx);
                        }
                    }
                    Err(e) => super::toast::error(&e, this.agent, window, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn select_installation(&mut self, id: f64, cx: &mut Context<Self>) {
        self.installation = Some(id);
        let Some(client) = &self.client else {
            return;
        };
        let request = client.call::<api::ListInstallationRepos>(p::ListInstallationReposIn {
            installation_id: id,
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.installation != Some(id) {
                    return;
                }
                match result {
                    Ok(repos) => this.repos = repos,
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn link(&mut self, repo_id: f64, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let (Some(client), Some(installation_id)) = (&self.client, self.installation) else {
            return;
        };
        let request = client.call::<api::LinkProject>(p::LinkProjectIn {
            installation_id,
            repo_id,
        });
        self.pending = true;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(project) => {
                        let linked = format!("Linked {}/{}", project.owner, project.name);
                        crate::app::AppState::global(cx)
                            .read(cx)
                            .hub
                            .clone()
                            .update(cx, |h, cx| {
                                h.projects.retain(|p| p.id != project.id);
                                h.projects.push(project);
                                cx.notify();
                            });
                        if let Some(handle) = this.modal_window {
                            cx.defer(move |cx| {
                                let _ = handle.update(cx, |_, window, cx| {
                                    super::toast::success(linked, window, cx)
                                });
                            });
                        }
                        this.close(cx);
                    }
                    Err(e) => super::toast::error_in_main_window(&e, None, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn load_history(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        let request = client.call::<api::ListWorkspaces>(p::ListWorkspacesIn {
            include_archived: Some(true),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(out) => {
                        this.history = out
                            .into_iter()
                            .filter(|w| w.state == p::WorkspaceState::Archived)
                            .collect()
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn mutate<F: p::Function>(&mut self, input: F::Input, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(client) = &self.client else {
            return;
        };
        self.pending = true;
        let request = client.call::<F>(input);
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if let Err(e) = result {
                    super::toast::error_in_main_window(&e, None, cx);
                } else {
                    this.delete = None;
                    if F::NAME == "renameWorkspace" {
                        this.close(cx);
                    } else {
                        this.load_history(cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
}
impl Render for Dialogs {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(kind) = self.kind else {
            return div().into_any_element();
        };
        let choices: Vec<_> = self
            .models
            .iter()
            .filter(|_| !self.models_loading)
            .flat_map(|entry| {
                entry.options.iter().map(|option| {
                    (
                        entry.agent,
                        option.value.clone(),
                        format!(
                            "{} · {}",
                            option.name,
                            super::chat_model::agent_label(entry.agent)
                        ),
                    )
                })
            })
            .collect();
        // Custom agents whose base agent has a login (it reports models), after the models.
        let custom: Vec<(p::AgentId, String, String)> = self
            .custom_agents
            .iter()
            .filter(|a| !self.models_loading && self.models.iter().any(|m| m.agent == a.base_agent))
            .map(|a| {
                (
                    a.base_agent,
                    a.id.clone(),
                    format!(
                        "{} · {}",
                        a.name.as_str(),
                        super::chat_model::agent_label(a.base_agent)
                    ),
                )
            })
            .collect();
        let model_label = match &self.custom_agent {
            Some(id) => custom
                .iter()
                .find(|(_, c, _)| c == id)
                .map(|(_, _, label)| label.clone()),
            None => choices
                .iter()
                .find(|(agent, value, _)| {
                    Some(*agent) == self.agent && Some(value) == self.model.as_ref()
                })
                .map(|(_, _, label)| label.clone()),
        }
        .unwrap_or_else(|| {
            if self.models_loading {
                "Loading models…".into()
            } else {
                "Select model".into()
            }
        });
        let weak = cx.weak_entity();
        let model_picker = Button::new("workspace-model")
            .label(model_label)
            .disabled(self.pending || self.created_chat.is_some())
            .dropdown_menu(move |menu, _, _| {
                let menu = choices.iter().fold(menu, |menu, (agent, value, label)| {
                    let weak = weak.clone();
                    let agent = *agent;
                    let value = value.clone();
                    menu.item(PopupMenuItem::new(label.clone()).on_click(move |_, _, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.agent = Some(agent);
                            this.model = Some(value.clone());
                            this.custom_agent = None;
                            cx.notify();
                        });
                    }))
                });
                let menu = if custom.is_empty() {
                    menu
                } else {
                    menu.separator()
                };
                let menu = custom.iter().fold(menu, |menu, (agent, id, label)| {
                    let weak = weak.clone();
                    let agent = *agent;
                    let id = id.clone();
                    menu.item(PopupMenuItem::new(label.clone()).on_click(move |_, _, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.agent = Some(agent);
                            this.custom_agent = Some(id.clone());
                            cx.notify();
                        });
                    }))
                });
                menu.item(
                    PopupMenuItem::new("Manage agents…")
                        .on_click(|_, _, cx| super::settings::open_agents(cx)),
                )
            });
        let projects: Vec<_> = self
            .projects
            .iter()
            .map(|p| (p.id.clone(), format!("{}/{}", p.owner, p.name)))
            .collect();
        let label = projects
            .iter()
            .find(|(id, _)| Some(id) == self.project.as_ref())
            .map(|(_, label)| label.clone())
            .unwrap_or_else(|| "Choose a project".into());
        let weak = cx.weak_entity();
        let project_picker =
            Button::new("workspace-project")
                .label(label)
                .dropdown_menu(move |menu, _, _| {
                    projects.iter().fold(menu, |menu, (id, label)| {
                        let weak = weak.clone();
                        let id = id.clone();
                        menu.item(PopupMenuItem::new(label.clone()).on_click(
                            move |_, window, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    this.select_project(id.clone(), window, cx)
                                });
                            },
                        ))
                    })
                });
        let create_workspace = Button::new("create-workspace")
            .label("Create")
            .disabled(
                self.pending
                    || self.project.is_none()
                    || (!self.prompt.read(cx).value().trim().is_empty()
                        && (self.models_loading
                            || (self.model.is_none() && self.custom_agent.is_none()))),
            )
            .on_click(cx.listener(|this, _, window, cx| this.create(window, cx)));
        let body = match kind {
            "New workspace" => v_flex()
                .gap_2()
                .child(
                    h_flex().gap_2().child(project_picker).child(
                        Button::new("workspace-options")
                            .label("Workspace options")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.workspace_options = !this.workspace_options;
                                cx.notify();
                            })),
                    ),
                )
                .children(self.workspace_options.then(|| {
                    v_flex()
                        .child(
                            h_flex().gap_2().children(
                                ["New branch", "Existing branch", "Pull request"]
                                    .into_iter()
                                    .enumerate()
                                    .map(|(ix, label)| {
                                        Button::new(label).label(label).on_click(cx.listener(
                                            move |this, _, _, cx| {
                                                this.source = ix;
                                                cx.notify();
                                            },
                                        ))
                                    }),
                            ),
                        )
                        .child(Input::new(&self.branch))
                        .children((self.source != 2).then(|| {
                            h_flex().gap_1().children(self.branches.iter().map(|b| {
                                let name = b.name.clone();
                                Button::new(SharedString::from(format!("branch-{name}")))
                                    .label(name.clone())
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.branch.update(cx, |i, cx| {
                                            i.set_value(name.clone(), window, cx)
                                        })
                                    }))
                            }))
                        }))
                        .children((self.source == 2).then(|| {
                            v_flex().children(self.prs.iter().map(|p| {
                                let number = p.number;
                                Button::new(SharedString::from(format!("pr-{number}")))
                                    .label(format!("#{} {}", p.number, p.title))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.branch.update(cx, |i, cx| {
                                            i.set_value(number.to_string(), window, cx)
                                        })
                                    }))
                            }))
                        }))
                }))
                .child(
                    div()
                        .min_h(gpui_kit::px(180.))
                        .child(Textarea::new(&self.prompt)),
                )
                .children(self.models_loading.then(|| div().child("Loading models…")))
                .child(
                    h_flex()
                        .gap_2()
                        .justify_between()
                        .child(model_picker)
                        .child(create_workspace),
                )
                .children((!self.models_loading && self.model.is_none()).then(|| {
                    Button::new("retry-models")
                        .label("Retry loading models")
                        .on_click(cx.listener(|this, _, _, cx| this.load_models(cx)))
                }))
                .children(self.workspace_options.then(|| {
                    Button::new("keep-open")
                        .label(if self.keep_open {
                            "Keep open ✓"
                        } else {
                            "Keep open"
                        })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.keep_open = !this.keep_open;
                            cx.notify();
                        }))
                }))
                .into_any_element(),
            "New chat" => v_flex()
                .gap_2()
                .child(
                    div()
                        .min_h(gpui_kit::px(180.))
                        .child(Textarea::new(&self.prompt)),
                )
                .children(self.models_loading.then(|| div().child("Loading models…")))
                .child(
                    h_flex().gap_2().child(model_picker).child(
                        Button::new("create-chat")
                            .label("Create chat")
                            .disabled(
                                self.pending
                                    || self.models_loading
                                    || (self.model.is_none() && self.custom_agent.is_none()),
                            )
                            .on_click(
                                cx.listener(|this, _, window, cx| this.create_chat(window, cx)),
                            ),
                    ),
                )
                .into_any_element(),
            "Rename workspace" => v_flex()
                .child(Input::new(&self.branch))
                .child(
                    Button::new("rename-workspace")
                        .label("Save")
                        .disabled(self.pending)
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(workspace_id) = this.workspace_id.clone() {
                                let title = this.branch.read(cx).value().to_string();
                                this.mutate::<api::RenameWorkspace>(
                                    p::RenameWorkspaceIn {
                                        workspace_id,
                                        title,
                                    },
                                    cx,
                                );
                            }
                        })),
                )
                .into_any_element(),
            "Add project" => {
                let muted = super::tokens::color(super::tokens::Token::MutedForeground, cx);
                let query = self.repo_search.read(cx).value().trim().to_lowercase();
                let shown: Vec<_> = self
                    .repos
                    .iter()
                    .filter(|repo| {
                        format!("{}/{}", repo.owner, repo.name)
                            .to_lowercase()
                            .contains(&query)
                    })
                    .collect();
                let linked: Vec<f64> = crate::app::AppState::try_global(cx)
                    .map(|a| {
                        a.read(cx)
                            .hub
                            .read(cx)
                            .projects
                            .iter()
                            .map(|p| p.repo_id)
                            .collect()
                    })
                    .unwrap_or_default();
                if self.installations_loading {
                    super::skeleton_rows(4).into_any_element()
                } else if self.installations.is_empty() && self.error.is_none() {
                    let install = self.install_url.clone();
                    v_flex()
                        .gap_2()
                        .items_center()
                        .p_4()
                        .child(
                            div()
                                .font_weight(gpui_kit::FontWeight::MEDIUM)
                                .child("Install the GitHub App"),
                        )
                        .child(div().text_sm().text_color(muted).child(if install.is_some() {
                            "Install it on an account or org, then pick the repos it can reach."
                        } else {
                            "The install link shows here once the GitHub App exists."
                        }))
                        .children(install.map(|url| {
                            Button::new("install-github-app")
                                .label("Install the GitHub App")
                                .on_click(move |_, _, cx| cx.open_url(&url))
                        }))
                        .into_any_element()
                } else {
                    v_flex()
                        .gap_2()
                        .child(Input::new(&self.repo_search))
                        .child(
                            h_flex()
                                .gap_1()
                                .children(self.installations.iter().map(|i| {
                                    let id = i.installation_id;
                                    Button::new(SharedString::from(format!("installation-{id}")))
                                        .label(i.account_login.clone())
                                        .selected(self.installation == Some(id))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.select_installation(id, cx)
                                        }))
                                })),
                        )
                        .child(
                            v_flex()
                                .id("installation-repos")
                                .role(gpui_kit::Role::List)
                                .aria_label("Repos")
                                .max_h(gpui_kit::px(360.))
                                .overflow_y_scroll()
                                .children(shown.is_empty().then(|| {
                                    div().py_2().text_color(muted).child(if query.is_empty() {
                                        "No repos."
                                    } else {
                                        "No matching repos."
                                    })
                                }))
                                .children(shown.into_iter().map(|r| {
                                    let id = r.repo_id;
                                    let name = format!("{}/{}", r.owner, r.name);
                                    h_flex()
                                        .id(SharedString::from(format!("repo-row-{id}")))
                                        .role(gpui_kit::Role::ListItem)
                                        .aria_label(name.clone())
                                        .gap_2()
                                        .py_1()
                                        .child(
                                            div().flex_1().min_w_0().truncate().child(name.clone()),
                                        )
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(muted)
                                                .child(r.default_branch.clone()),
                                        )
                                        .child(if linked.contains(&id) {
                                            div()
                                                .text_xs()
                                                .text_color(muted)
                                                .child("Linked")
                                                .into_any_element()
                                        } else {
                                            Button::new(SharedString::from(format!("repo-{id}")))
                                                .label("Link")
                                                .accessibility_label(format!("Link {name}"))
                                                .disabled(self.pending)
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.link(id, cx)
                                                }))
                                                .into_any_element()
                                        })
                                })),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .justify_between()
                                .child(
                                    div().text_xs().text_color(muted).child(
                                        "Repo missing? Give the app access to it on GitHub.",
                                    ),
                                )
                                .children(self.install_url.clone().map(|url| {
                                    Button::new("manage-github-app")
                                        .label("Manage on GitHub")
                                        .on_click(move |_, _, cx| cx.open_url(&url))
                                })),
                        )
                        .into_any_element()
                }
            }
            "History" => v_flex()
                .gap_2()
                .children(self.history.iter().map(|w| {
                    let restore = w.id.clone();
                    let deleted = w.clone();
                    h_flex()
                        .gap_2()
                        .child(w.title.clone())
                        .child(
                            Button::new(SharedString::from(format!("restore-{}", w.id)))
                                .label("Restore")
                                .disabled(self.pending)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.mutate::<api::RestoreWorkspace>(
                                        p::RestoreWorkspaceIn {
                                            workspace_id: restore.clone(),
                                        },
                                        cx,
                                    )
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("delete-{}", w.id)))
                                .label("Delete")
                                .disabled(self.pending)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.delete = Some(deleted.clone());
                                    cx.notify();
                                })),
                        )
                }))
                .children(self.delete.clone().map(|w| {
                    let id = w.id;
                    v_flex()
                        .child(format!("Type {} to delete this workspace.", w.slug))
                        .child(Input::new(&self.confirm))
                        .child(
                            Button::new("confirm-delete")
                                .label("Delete permanently")
                                .disabled(
                                    self.pending
                                        || self.confirm.read(cx).value().as_str() != w.slug,
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.mutate::<api::DeleteWorkspace>(
                                        p::DeleteWorkspaceIn {
                                            workspace_id: id.clone(),
                                        },
                                        cx,
                                    )
                                })),
                        )
                }))
                .into_any_element(),
            _ => div().into_any_element(),
        };
        v_flex()
            .capture_key_down(
                cx.listener(|this, event: &gpui_kit::KeyDownEvent, window, cx| {
                    if event.keystroke.key == "escape" {
                        if !this.pending {
                            this.close(cx);
                            cx.notify();
                        }
                        cx.stop_propagation();
                    } else if event.keystroke.key == "enter"
                        && (event.keystroke.modifiers.platform
                            || (matches!(this.kind, Some("New workspace" | "New chat"))
                                && !event.keystroke.modifiers.shift
                                && !event.keystroke.modifiers.alt
                                && this.prompt.read(cx).focus_handle(cx).is_focused(window)))
                    {
                        window.dispatch_action(Box::new(crate::actions::ConfirmDialog), cx);
                        cx.stop_propagation();
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::actions::DismissDialog, _, cx| {
                    if !this.pending {
                        this.close(cx);
                        cx.notify();
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::actions::ConfirmDialog, window, cx| {
                    if this.kind == Some("New workspace") {
                        this.create(window, cx);
                    } else if this.kind == Some("New chat") {
                        this.create_chat(window, cx);
                    }
                }),
            )
            .id("workspace-dialog")
            .max_h(gpui_kit::px(550.))
            .overflow_y_scroll()
            .p_4()
            .gap_2()
            .children((kind != "New workspace" && kind != "New chat").then_some(kind))
            .children(self.error.clone().map(|e| {
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_color(super::tokens::color(super::tokens::Token::Destructive, cx))
                            .child(e),
                    )
                    .children(matches!(kind, "Add project" | "History").then(|| {
                        Button::new("retry-dialog")
                            .label("Retry")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if kind == "History" {
                                    this.error = None;
                                    this.load_history(cx);
                                } else {
                                    this.load_installations(cx);
                                }
                            }))
                    }))
            }))
            .child(body)
            .child(
                Button::new("close-dialog")
                    .label("Cancel")
                    .disabled(self.pending)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.close(cx);
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
}
