use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div,
};
use tempo_client::Client;
use tempo_protocol::{self as p, api};

pub enum RepositoryEvent {
    OpenWorkspace(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RepositoryTab {
    Code,
    Commits,
    PullRequests,
    Issues,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AddMode {
    Create,
    Import,
    Link,
}

struct Inputs {
    name: Entity<InputState>,
    description: Entity<InputState>,
    import_url: Entity<InputState>,
    default_branch: Entity<InputState>,
    reference: Entity<InputState>,
    title: Entity<InputState>,
    head: Entity<InputState>,
    base: Entity<InputState>,
    body: Entity<TextareaState>,
}

pub struct RepositoryView {
    client: Client,
    projects: Vec<p::Project>,
    project: Option<p::Project>,
    detail: Option<p::RepositoryDetail>,
    file: Option<(String, p::GetRepositoryFileOut)>,
    commits: Vec<p::RepositoryCommit>,
    more_commits: bool,
    pull_requests: Vec<p::RepositoryPullRequest>,
    pull_request: Option<p::RepositoryPullRequest>,
    issues: Option<Entity<super::issues::IssuesView>>,
    merge_workspace: Option<p::WorkspaceDetail>,
    workspace_loading: bool,
    tab: RepositoryTab,
    path: String,
    reference: String,
    explicit_ref: bool,
    add_mode: Option<AddMode>,
    pr_form: bool,
    editing_pr: bool,
    draft: bool,
    loading: bool,
    projects_loading: bool,
    pending: bool,
    error: Option<String>,
    generation: u64,
    projects_generation: u64,
    inputs: Inputs,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<RepositoryEvent> for RepositoryView {}

fn parent_path(path: &str) -> String {
    path.rsplit_once('/')
        .map_or("", |(parent, _)| parent)
        .into()
}

fn is_artifacts(project: &p::Project) -> bool {
    project.provider == Some(p::ProjectProvider::Artifacts)
}

fn github_url(project: &p::Project) -> String {
    format!("https://github.com/{}/{}", project.owner, project.name)
}

impl RepositoryView {
    pub fn new(client: Client, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut input = |placeholder: &str| {
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder.to_string()))
        };
        let name = input("Repository name");
        let description = input("Description (optional)");
        let import_url = input("https://example.com/owner/repository.git");
        let default_branch = input("main");
        let reference = input("Branch or commit");
        let title = input("Pull request title");
        let head = input("Head branch");
        let base = input("Base branch");
        let body = cx.new(|cx| TextareaState::new(window, cx).auto_grow(3, 12));
        let mut subscriptions = Vec::new();
        for field in [
            &name,
            &description,
            &import_url,
            &default_branch,
            &reference,
            &title,
            &head,
            &base,
        ] {
            subscriptions.push(cx.observe(field, |_, _, cx| cx.notify()));
        }
        subscriptions.push(cx.observe(&body, |_, _, cx| cx.notify()));
        let mut view = Self {
            client,
            projects: Vec::new(),
            project: None,
            detail: None,
            file: None,
            commits: Vec::new(),
            more_commits: false,
            pull_requests: Vec::new(),
            pull_request: None,
            issues: None,
            merge_workspace: None,
            workspace_loading: false,
            tab: RepositoryTab::Code,
            path: String::new(),
            reference: String::new(),
            explicit_ref: false,
            add_mode: None,
            pr_form: false,
            editing_pr: false,
            draft: false,
            loading: false,
            projects_loading: false,
            pending: false,
            error: None,
            generation: 0,
            projects_generation: 0,
            inputs: Inputs {
                name,
                description,
                import_url,
                default_branch,
                reference,
                title,
                head,
                base,
                body,
            },
            _subscriptions: subscriptions,
        };
        view.refresh_projects(cx);
        view
    }

    fn refresh_projects(&mut self, cx: &mut Context<Self>) {
        self.projects_generation += 1;
        let generation = self.projects_generation;
        self.projects_loading = true;
        self.error = None;
        let request = self.client.call::<api::ListProjects>(Default::default());
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.projects_generation != generation {
                    return;
                }
                this.projects_loading = false;
                match result {
                    Ok(projects) => {
                        this.projects = projects.clone();
                        if let Some(app) = crate::app::AppState::try_global(cx) {
                            let hub = app.read(cx).hub.clone();
                            hub.update(cx, |hub, cx| {
                                hub.projects_generation += 1;
                                hub.projects = projects;
                                hub.projects_ready = true;
                                hub.project_error = false;
                                cx.notify();
                            });
                        }
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn refresh_current(&mut self, cx: &mut Context<Self>) {
        self.refresh_projects(cx);
        if let Some(pr) = &self.pull_request {
            self.open_pull_request(pr.number, cx);
        } else if self.project.is_some() {
            self.load_tab(cx);
        }
    }

    fn select_project(&mut self, project: p::Project, window: &mut Window, cx: &mut Context<Self>) {
        self.generation += 1;
        self.detail = None;
        self.file = None;
        self.commits.clear();
        self.more_commits = false;
        self.pull_requests.clear();
        self.pull_request = None;
        self.issues = None;
        self.merge_workspace = None;
        self.workspace_loading = false;
        self.path.clear();
        self.reference = project.default_branch.clone();
        self.explicit_ref = false;
        self.tab = RepositoryTab::Code;
        self.add_mode = None;
        self.pr_form = false;
        self.editing_pr = false;
        self.error = None;
        self.loading = false;
        self.inputs.reference.update(cx, |input, cx| {
            input.set_value(self.reference.clone(), window, cx)
        });
        self.inputs.base.update(cx, |input, cx| {
            input.set_value(project.default_branch.clone(), window, cx)
        });
        self.project = Some(project);
        self.load_tab(cx);
    }

    fn select_tab(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.generation += 1;
        self.tab = match index {
            1 => RepositoryTab::Commits,
            2 => RepositoryTab::PullRequests,
            3 => RepositoryTab::Issues,
            _ => RepositoryTab::Code,
        };
        self.file = None;
        self.pull_request = None;
        self.pr_form = false;
        if self.tab == RepositoryTab::Issues && self.issues.is_none() {
            let Some(project) = &self.project else {
                return;
            };
            let client = self.client.clone();
            let project_id = project.id.clone();
            self.issues =
                Some(cx.new(|cx| super::issues::IssuesView::new(client, project_id, window, cx)));
            self.loading = false;
            self.error = None;
            cx.notify();
        } else {
            self.load_tab(cx);
        }
    }

    fn load_tab(&mut self, cx: &mut Context<Self>) {
        self.workspace_loading = false;
        let Some(project) = &self.project else {
            return;
        };
        if !is_artifacts(project) {
            cx.notify();
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.error = None;
        match self.tab {
            RepositoryTab::Code => {
                self.detail = None;
                let request = self.client.call::<api::GetRepository>(p::GetRepositoryIn {
                    project_id: project.id.clone(),
                    ref_: self.explicit_ref.then(|| self.reference.clone()),
                    path: Some(self.path.clone()),
                });
                cx.spawn(async move |this, cx| {
                    let result = request.await;
                    let _ = this.update(cx, |this, cx| {
                        if this.generation != generation {
                            return;
                        }
                        this.loading = false;
                        match result {
                            Ok(detail) => this.detail = Some(detail),
                            Err(error) => this.error = Some(error.to_string()),
                        }
                        cx.notify();
                    });
                })
                .detach();
            }
            RepositoryTab::Commits => {
                self.commits.clear();
                let request =
                    self.client
                        .call::<api::ListRepositoryCommits>(p::ListRepositoryCommitsIn {
                            project_id: project.id.clone(),
                            ref_: self.explicit_ref.then(|| self.reference.clone()),
                            offset: Some(0.),
                        });
                cx.spawn(async move |this, cx| {
                    let result = request.await;
                    let _ = this.update(cx, |this, cx| {
                        if this.generation != generation {
                            return;
                        }
                        this.loading = false;
                        match result {
                            Ok(commits) => {
                                this.more_commits = commits.len() == 50;
                                this.commits = commits;
                            }
                            Err(error) => this.error = Some(error.to_string()),
                        }
                        cx.notify();
                    });
                })
                .detach();
            }
            RepositoryTab::PullRequests => {
                let request = self.client.call::<api::ListRepositoryPullRequests>(
                    p::ListRepositoryPullRequestsIn {
                        project_id: project.id.clone(),
                        state: Some(p::ListRepositoryPullRequestsInState::All),
                    },
                );
                cx.spawn(async move |this, cx| {
                    let result = request.await;
                    let _ = this.update(cx, |this, cx| {
                        if this.generation != generation {
                            return;
                        }
                        this.loading = false;
                        match result {
                            Ok(pull_requests) => this.pull_requests = pull_requests,
                            Err(error) => this.error = Some(error.to_string()),
                        }
                        cx.notify();
                    });
                })
                .detach();
            }
            RepositoryTab::Issues => {
                self.loading = false;
                if let Some(issues) = &self.issues {
                    issues.update(cx, |issues, cx| issues.refresh(cx));
                }
            }
        }
        cx.notify();
    }

    fn load_more_commits(&mut self, cx: &mut Context<Self>) {
        if self.loading || !self.more_commits {
            return;
        }
        let Some(project) = &self.project else {
            return;
        };
        self.loading = true;
        let generation = self.generation;
        let request = self
            .client
            .call::<api::ListRepositoryCommits>(p::ListRepositoryCommitsIn {
                project_id: project.id.clone(),
                ref_: self.explicit_ref.then(|| self.reference.clone()),
                offset: Some(self.commits.len() as f64),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(commits) => {
                        this.more_commits = commits.len() == 50;
                        this.commits.extend(commits);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn open_entry(&mut self, entry: p::RepositoryEntry, cx: &mut Context<Self>) {
        if entry.type_ == p::RepositoryEntryType::Tree {
            self.file = None;
            self.path = entry.path;
            self.load_tab(cx);
            return;
        }
        if entry.type_ == p::RepositoryEntryType::Gitlink {
            self.error = Some(format!(
                "Submodule {} points to {}.",
                entry.path, entry.hash
            ));
            cx.notify();
            return;
        }
        let Some(project) = &self.project else {
            return;
        };
        let Ok(reference) = self.reference.clone().try_into() else {
            return;
        };
        let Ok(path) = entry.path.clone().try_into() else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.error = None;
        let request = self
            .client
            .call::<api::GetRepositoryFile>(p::GetRepositoryFileIn {
                project_id: project.id.clone(),
                ref_: reference,
                path,
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(file) => this.file = Some((entry.path, file)),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn add_repository(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(mode) = self.add_mode else {
            return;
        };
        let name = self.inputs.name.read(cx).value().trim().to_string();
        if name.is_empty() {
            return;
        }
        let description = self.inputs.description.read(cx).value().to_string();
        let description = (!description.trim().is_empty()).then_some(description);
        let request: std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<p::Project, tempo_client::ApiError>> + Send,
            >,
        > = match mode {
            AddMode::Create => {
                let Ok(name) = name.try_into() else {
                    return;
                };
                let branch = self
                    .inputs
                    .default_branch
                    .read(cx)
                    .value()
                    .trim()
                    .to_string();
                let default_branch = if branch.is_empty() {
                    None
                } else {
                    branch.try_into().ok()
                };
                Box::pin(
                    self.client
                        .call::<api::CreateRepository>(p::CreateRepositoryIn {
                            name,
                            description,
                            default_branch,
                        }),
                )
            }
            AddMode::Import => {
                let Ok(name) = name.try_into() else {
                    return;
                };
                let Ok(url) = self
                    .inputs
                    .import_url
                    .read(cx)
                    .value()
                    .trim()
                    .to_string()
                    .try_into()
                else {
                    return;
                };
                Box::pin(
                    self.client
                        .call::<api::ImportRepository>(p::ImportRepositoryIn {
                            name,
                            url,
                            description,
                        }),
                )
            }
            AddMode::Link => {
                let Ok(name) = name.try_into() else {
                    return;
                };
                Box::pin(
                    self.client
                        .call::<api::LinkArtifactRepository>(p::LinkArtifactRepositoryIn { name }),
                )
            }
        };
        self.pending = true;
        self.error = None;
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(project) => {
                        this.refresh_projects(cx);
                        this.select_project(project, window, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn open_pull_request(&mut self, number: f64, cx: &mut Context<Self>) {
        let Some(project) = &self.project else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.pr_form = false;
        self.editing_pr = false;
        self.pull_request = None;
        self.merge_workspace = None;
        self.error = None;
        let request =
            self.client
                .call::<api::GetRepositoryPullRequest>(p::GetRepositoryPullRequestIn {
                    project_id: project.id.clone(),
                    number,
                });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(pr) => {
                        this.pull_request = Some(pr);
                        this.load_pr_workspace(cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn create_pull_request(&mut self, cx: &mut Context<Self>) {
        if self.pending || self.read_only() {
            return;
        }
        let Some(project) = &self.project else {
            return;
        };
        let Ok(title) = self
            .inputs
            .title
            .read(cx)
            .value()
            .trim()
            .to_string()
            .try_into()
        else {
            return;
        };
        let Ok(head_branch) = self
            .inputs
            .head
            .read(cx)
            .value()
            .trim()
            .to_string()
            .try_into()
        else {
            return;
        };
        let Ok(base_branch) = self
            .inputs
            .base
            .read(cx)
            .value()
            .trim()
            .to_string()
            .try_into()
        else {
            return;
        };
        self.pending = true;
        self.error = None;
        let generation = self.generation;
        let request = self.client.call::<api::CreateRepositoryPullRequest>(
            p::CreateRepositoryPullRequestIn {
                project_id: project.id.clone(),
                title,
                head_branch,
                base_branch,
                body: self.inputs.body.read(cx).value().to_string(),
                draft: self.draft,
            },
        );
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if this.generation != generation {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(pr) => {
                        this.pr_form = false;
                        this.pull_request = Some(pr.clone());
                        this.pull_requests.insert(0, pr);
                        this.generation += 1;
                        this.load_pr_workspace(cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn update_pull_request(&mut self, close: bool, cx: &mut Context<Self>) {
        let Some(pr) = &self.pull_request else {
            return;
        };
        self.write_pull_request(
            p::UpdateRepositoryPullRequestIn {
                project_id: pr.project_id.clone(),
                number: pr.number,
                state: Some(if close {
                    p::UpdateRepositoryPullRequestInState::Closed
                } else {
                    p::UpdateRepositoryPullRequestInState::Open
                }),
                title: None,
                body: None,
                draft: None,
            },
            cx,
        );
    }

    fn edit_pull_request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pr) = &self.pull_request else {
            return;
        };
        self.inputs.title.update(cx, |input, cx| {
            input.set_value(pr.title.clone(), window, cx)
        });
        self.inputs
            .body
            .update(cx, |input, cx| input.set_value(pr.body.clone(), window, cx));
        self.inputs.head.update(cx, |input, cx| {
            input.set_value(pr.head_branch.clone(), window, cx)
        });
        self.inputs.base.update(cx, |input, cx| {
            input.set_value(pr.base_branch.clone(), window, cx)
        });
        self.draft = pr.state == p::PrState::Draft;
        self.pr_form = true;
        self.editing_pr = true;
        cx.notify();
    }

    fn save_pull_request(&mut self, cx: &mut Context<Self>) {
        let Some(pr) = &self.pull_request else {
            return;
        };
        let Ok(title) = self
            .inputs
            .title
            .read(cx)
            .value()
            .trim()
            .to_string()
            .try_into()
        else {
            return;
        };
        self.write_pull_request(
            p::UpdateRepositoryPullRequestIn {
                project_id: pr.project_id.clone(),
                number: pr.number,
                title: Some(title),
                body: Some(self.inputs.body.read(cx).value().to_string()),
                state: None,
                draft: matches!(pr.state, p::PrState::Open | p::PrState::Draft)
                    .then_some(self.draft),
            },
            cx,
        );
    }

    fn toggle_pull_request_draft(&mut self, cx: &mut Context<Self>) {
        let Some(pr) = &self.pull_request else {
            return;
        };
        self.write_pull_request(
            p::UpdateRepositoryPullRequestIn {
                project_id: pr.project_id.clone(),
                number: pr.number,
                title: None,
                body: None,
                state: None,
                draft: Some(pr.state != p::PrState::Draft),
            },
            cx,
        );
    }

    fn write_pull_request(
        &mut self,
        input: p::UpdateRepositoryPullRequestIn,
        cx: &mut Context<Self>,
    ) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        let generation = self.generation;
        let request = self.client.call::<api::UpdateRepositoryPullRequest>(input);
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if this.generation != generation {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(pr) => {
                        this.pr_form = false;
                        this.editing_pr = false;
                        for row in &mut this.pull_requests {
                            if row.id == pr.id {
                                *row = pr.clone();
                            }
                        }
                        this.pull_request = Some(pr);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn load_pr_workspace(&mut self, cx: &mut Context<Self>) {
        let Some(pr) = self.pull_request.clone() else {
            return;
        };
        self.merge_workspace = None;
        self.workspace_loading = true;
        let generation = self.generation;
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result: Result<Option<p::WorkspaceDetail>, tempo_client::ApiError> = async {
                let workspaces = client
                    .call::<api::ListWorkspaces>(Default::default())
                    .await?;
                let workspace = workspaces.into_iter().find(|workspace| {
                    workspace.project_id == pr.project_id
                        && workspace.branch == pr.head_branch
                        && (workspace.pr_number.is_none() || workspace.pr_number == Some(pr.number))
                        && !matches!(
                            workspace.state,
                            p::WorkspaceState::Archived | p::WorkspaceState::Archiving
                        )
                });
                match workspace {
                    Some(workspace) => client
                        .call::<api::GetWorkspace>(p::GetWorkspaceIn {
                            workspace_id: workspace.id,
                        })
                        .await
                        .map(Some),
                    None => Ok(None),
                }
            }
            .await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.workspace_loading = false;
                match result {
                    Ok(workspace) => this.merge_workspace = workspace,
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn wake_pr_workspace(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(workspace) = &self.merge_workspace else {
            return;
        };
        self.pending = true;
        self.error = None;
        let generation = self.generation;
        let request = self.client.call::<api::WakeWorkspace>(p::WakeWorkspaceIn {
            workspace_id: workspace.id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if this.generation != generation {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(_) => this.load_pr_workspace(cx),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn can_merge(&self) -> bool {
        self.pull_request
            .as_ref()
            .is_some_and(|pr| pr.state == p::PrState::Open)
            && self.merge_workspace.as_ref().is_some_and(|workspace| {
                workspace.state == p::WorkspaceState::Ready
                    && self
                        .pull_request
                        .as_ref()
                        .is_some_and(|pr| workspace.pr_number == Some(pr.number))
                    && workspace.running_turn_id.is_none()
                    && workspace.queue.is_empty()
                    && !matches!(
                        workspace.checks_state,
                        Some(p::ChecksState::Failure | p::ChecksState::Pending)
                    )
            })
            && !self.read_only()
    }

    fn link_pr_workspace(&mut self, cx: &mut Context<Self>) {
        if self.pending || self.read_only() {
            return;
        }
        let Some(workspace) = &self.merge_workspace else {
            return;
        };
        let Some(pr) = &self.pull_request else {
            return;
        };
        self.pending = true;
        self.error = None;
        let generation = self.generation;
        let number = pr.number;
        let request = self
            .client
            .call::<api::CreatePullRequest>(p::CreatePullRequestIn {
                workspace_id: workspace.id.clone(),
                title: pr.title.clone(),
                body: pr.body.clone(),
                draft: pr.state == p::PrState::Draft,
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if this.generation != generation {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(pr) if pr.number == number => this.load_pr_workspace(cx),
                    Ok(_) => this.error = Some(
                        "The workspace is linked to another pull request. Refresh to inspect it."
                            .into(),
                    ),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn merge_pull_request(&mut self, method: p::MergeMethod, cx: &mut Context<Self>) {
        if self.pending || !self.can_merge() {
            return;
        }
        let Some(workspace) = &self.merge_workspace else {
            return;
        };
        let Some(number) = self.pull_request.as_ref().map(|pr| pr.number) else {
            return;
        };
        self.pending = true;
        self.error = None;
        let generation = self.generation;
        let request = self
            .client
            .call::<api::MergePullRequest>(p::MergePullRequestIn {
                workspace_id: workspace.id.clone(),
                method,
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if this.generation != generation {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(_) => this.open_pull_request(number, cx),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn open_pr_workspace(&mut self, cx: &mut Context<Self>) {
        if self.pending || self.workspace_loading {
            return;
        }
        if let Some(workspace) = &self.merge_workspace {
            cx.emit(RepositoryEvent::OpenWorkspace(workspace.id.clone()));
        } else if let Some(pr) = &self.pull_request {
            self.open_workspace(p::NewSource::Pr { number: pr.number }, cx);
        }
    }

    fn open_workspace(&mut self, source: p::NewSource, cx: &mut Context<Self>) {
        if self.pending || self.read_only() {
            return;
        }
        let Some(project) = &self.project else {
            return;
        };
        self.pending = true;
        self.error = None;
        let request = self
            .client
            .call::<api::CreateWorkspace>(p::CreateWorkspaceIn {
                project_id: project.id.clone(),
                source,
                agent_id: None,
                agent: None,
                model: None,
                prompt: None,
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(workspace) => cx.emit(RepositoryEvent::OpenWorkspace(workspace.id)),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn read_only(&self) -> bool {
        self.detail.as_ref().is_none_or(|detail| detail.read_only)
    }

    fn render_add(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let mode = self.add_mode.unwrap_or(AddMode::Create);
        v_flex()
            .gap_3()
            .child(div().text_xl().child("Add an Artifacts repository"))
            .child(
                TabBar::new("add-repository-mode")
                    .selected_index(match mode {
                        AddMode::Create => 0,
                        AddMode::Import => 1,
                        AddMode::Link => 2,
                    })
                    .on_click(cx.listener(|this, index: &usize, _, cx| {
                        this.add_mode = Some(match index {
                            1 => AddMode::Import,
                            2 => AddMode::Link,
                            _ => AddMode::Create,
                        });
                        this.error = None;
                        cx.notify();
                    }))
                    .children(
                        ["Create", "Import", "Link existing"].map(|name| Tab::new().label(name)),
                    ),
            )
            .child("Repository name")
            .child(
                Input::new(&self.inputs.name)
                    .aria_label("Repository name")
                    .disabled(self.pending),
            )
            .children((mode != AddMode::Link).then(|| {
                v_flex().gap_2().child("Description").child(
                    Input::new(&self.inputs.description)
                        .aria_label("Repository description")
                        .disabled(self.pending),
                )
            }))
            .children((mode == AddMode::Create).then(|| {
                v_flex().gap_2().child("Default branch").child(
                    Input::new(&self.inputs.default_branch)
                        .aria_label("Default branch")
                        .disabled(self.pending),
                )
            }))
            .children((mode == AddMode::Import).then(|| {
                v_flex().gap_2().child("Public Git URL").child(
                    Input::new(&self.inputs.import_url)
                        .aria_label("Import URL")
                        .disabled(self.pending),
                )
            }))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("submit-repository")
                            .primary()
                            .label(if self.pending {
                                "Saving…"
                            } else {
                                match mode {
                                    AddMode::Create => "Create repository",
                                    AddMode::Import => "Import repository",
                                    AddMode::Link => "Link repository",
                                }
                            })
                            .disabled(
                                self.pending
                                    || self.inputs.name.read(cx).value().trim().is_empty()
                                    || (mode == AddMode::Import
                                        && self
                                            .inputs
                                            .import_url
                                            .read(cx)
                                            .value()
                                            .trim()
                                            .is_empty()),
                            )
                            .on_click(
                                cx.listener(|this, _, window, cx| this.add_repository(window, cx)),
                            ),
                    )
                    .child(
                        Button::new("cancel-add-repository")
                            .label("Cancel")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.add_mode = None;
                                cx.notify();
                            })),
                    ),
            )
            .into_any_element()
    }

    fn render_code(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if let Some((path, file)) = &self.file {
            return v_flex()
                .gap_3()
                .child(
                    Button::new("back-to-repository-tree")
                        .label("Back to files")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.file = None;
                            cx.notify();
                        })),
                )
                .child(div().font_family("monospace").child(path.clone()))
                .child(format!("{} bytes", file.size))
                .child(
                    if file.encoding == p::GetRepositoryFileOutEncoding::Base64 {
                        div()
                            .child("Binary file. Text preview is unavailable.")
                            .into_any_element()
                    } else {
                        v_flex()
                            .font_family("monospace")
                            .text_sm()
                            .children(file.content.lines().enumerate().map(|(index, line)| {
                                h_flex()
                                    .gap_3()
                                    .child(
                                        div()
                                            .text_color(color(Token::MutedForeground, cx))
                                            .child((index + 1).to_string()),
                                    )
                                    .child(line.to_string())
                            }))
                            .into_any_element()
                    },
                )
                .into_any_element();
        }
        let Some(detail) = &self.detail else {
            return div().into_any_element();
        };
        if detail.empty {
            return v_flex()
                .gap_3()
                .child("This repository is empty. Start a workspace or push a first commit to get started.")
                .child(div().font_family("monospace").child(detail.remote.clone()))
                .into_any_element();
        }
        v_flex()
            .gap_2()
            .children(detail.commit.as_ref().map(|commit| {
                div()
                    .text_color(color(Token::MutedForeground, cx))
                    .child(format!(
                        "{} · {}",
                        commit.hash.chars().take(8).collect::<String>(),
                        commit.message.lines().next().unwrap_or("")
                    ))
            }))
            .child(
                h_flex()
                    .gap_2()
                    .child(if self.path.is_empty() {
                        "/".into()
                    } else {
                        self.path.clone()
                    })
                    .children((!self.path.is_empty()).then(|| {
                        Button::new("repository-parent")
                            .ghost()
                            .label("Up")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.path = parent_path(&this.path);
                                this.load_tab(cx);
                            }))
                    })),
            )
            .children(
                detail
                    .entries
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(index, entry)| {
                        let label = if entry.type_ == p::RepositoryEntryType::Tree {
                            format!("{}/", entry.name)
                        } else {
                            entry.name.clone()
                        };
                        Button::new(("repository-entry", index))
                            .ghost()
                            .label(label)
                            .on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.open_entry(entry.clone(), cx)
                                }),
                            )
                    }),
            )
            .into_any_element()
    }

    fn render_commits(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if self.commits.is_empty() {
            return div().child("No commits on this ref.").into_any_element();
        }
        v_flex()
            .gap_3()
            .children(
                self.commits
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(index, commit)| {
                        let hash = commit.hash.clone();
                        v_flex()
                            .gap_1()
                            .p_3()
                            .border_1()
                            .border_color(color(Token::Border, cx))
                            .child(commit.message)
                            .child(
                                div()
                                    .text_color(color(Token::MutedForeground, cx))
                                    .child(format!("{} · {}", commit.author.name, commit.hash)),
                            )
                            .child(
                                Button::new(("browse-commit", index))
                                    .ghost()
                                    .label("Browse this commit")
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.reference = hash.clone();
                                        this.explicit_ref = true;
                                        this.path.clear();
                                        this.file = None;
                                        this.tab = RepositoryTab::Code;
                                        this.inputs.reference.update(cx, |input, cx| {
                                            input.set_value(hash.clone(), window, cx)
                                        });
                                        this.load_tab(cx);
                                    })),
                            )
                    }),
            )
            .children(self.more_commits.then(|| {
                Button::new("more-repository-commits")
                    .label("Load more commits")
                    .disabled(self.loading)
                    .on_click(cx.listener(|this, _, _, cx| this.load_more_commits(cx)))
            }))
            .into_any_element()
    }

    fn render_merge_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.workspace_loading {
            return div()
                .child("Loading pull request workspace…")
                .into_any_element();
        }
        let Some(workspace) = &self.merge_workspace else {
            return div()
                .text_color(color(Token::MutedForeground, cx))
                .child("Open this pull request in a workspace to prepare a merge.")
                .into_any_element();
        };
        let sleeping = workspace.state == p::WorkspaceState::Sleeping;
        let checks = workspace
            .checks_state
            .map(|state| state.to_string())
            .unwrap_or_else(|| "not reported".into());
        let open = self
            .pull_request
            .as_ref()
            .is_some_and(|pr| pr.state == p::PrState::Open);
        v_flex()
            .gap_2()
            .child(format!(
                "Workspace: {} · {} · Checks: {}",
                workspace.title, workspace.state, checks
            ))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("refresh-pr-workspace")
                            .ghost()
                            .label("Refresh workspace")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.load_pr_workspace(cx))),
                    )
                    .children(sleeping.then(|| {
                        Button::new("wake-pr-workspace")
                            .label("Wake workspace")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.wake_pr_workspace(cx)))
                    }))
                    .children((open && workspace.pr_number.is_none()).then(|| {
                        Button::new("link-pr-workspace")
                            .label("Link pull request to workspace")
                            .disabled(
                                self.pending || self.read_only() || !workspace.pushed || sleeping,
                            )
                            .on_click(cx.listener(|this, _, _, cx| this.link_pr_workspace(cx)))
                    }))
                    .children(open.then(|| {
                        Button::new("squash-repository-pr")
                            .primary()
                            .label("Squash and merge")
                            .disabled(self.pending || !self.can_merge())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.merge_pull_request(p::MergeMethod::Squash, cx)
                            }))
                    }))
                    .children(open.then(|| {
                        Button::new("merge-repository-pr")
                            .label("Merge commit")
                            .disabled(self.pending || !self.can_merge())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.merge_pull_request(p::MergeMethod::Merge, cx)
                            }))
                    })),
            )
            .into_any_element()
    }

    fn render_pull_requests(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if self.pr_form {
            let valid = [&self.inputs.title, &self.inputs.head, &self.inputs.base]
                .iter()
                .all(|input| !input.read(cx).value().trim().is_empty());
            return v_flex()
                .gap_3()
                .child(if self.editing_pr {
                    "Edit pull request"
                } else {
                    "Create pull request"
                })
                .child(
                    Input::new(&self.inputs.title)
                        .aria_label("Pull request title")
                        .disabled(self.pending),
                )
                .child(
                    Input::new(&self.inputs.head)
                        .aria_label("Head branch")
                        .disabled(self.pending || self.editing_pr),
                )
                .child(
                    Input::new(&self.inputs.base)
                        .aria_label("Base branch")
                        .disabled(self.pending || self.editing_pr),
                )
                .child(
                    Textarea::new(&self.inputs.body)
                        .aria_label("Pull request description")
                        .disabled(self.pending),
                )
                .child(
                    Button::new("toggle-pr-draft")
                        .label(if self.draft {
                            "Draft: yes"
                        } else {
                            "Draft: no"
                        })
                        .disabled(self.pending)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.draft = !this.draft;
                            cx.notify();
                        })),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("submit-repository-pr")
                                .primary()
                                .label(if self.pending {
                                    "Saving…"
                                } else if self.editing_pr {
                                    "Save changes"
                                } else {
                                    "Create pull request"
                                })
                                .disabled(
                                    self.pending
                                        || !valid
                                        || (self.read_only() && !self.editing_pr),
                                )
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if this.editing_pr {
                                        this.save_pull_request(cx);
                                    } else {
                                        this.create_pull_request(cx);
                                    }
                                })),
                        )
                        .child(
                            Button::new("cancel-repository-pr")
                                .label("Cancel")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.pr_form = false;
                                    this.editing_pr = false;
                                    cx.notify();
                                })),
                        ),
                )
                .into_any_element();
        }
        if let Some(pr) = &self.pull_request {
            let pr = pr.clone();
            let closed = pr.state == p::PrState::Closed;
            let merge_controls = self.render_merge_controls(cx);
            return v_flex()
                .gap_3()
                .child(
                    Button::new("back-to-pull-requests")
                        .ghost()
                        .label("All pull requests")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.pull_request = None;
                            this.load_tab(cx);
                        })),
                )
                .child(
                    div()
                        .text_xl()
                        .child(format!("#{} {}", pr.number, pr.title)),
                )
                .child(format!(
                    "{} → {} · {}",
                    pr.head_branch, pr.base_branch, pr.state
                ))
                .child(pr.body.clone())
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("open-pr-workspace")
                                .primary()
                                .label("Open in workspace")
                                .disabled(
                                    self.pending
                                        || self.workspace_loading
                                        || (self.read_only() && self.merge_workspace.is_none()),
                                )
                                .on_click(
                                    cx.listener(move |this, _, _, cx| this.open_pr_workspace(cx)),
                                ),
                        )
                        .children((pr.state != p::PrState::Merged).then(|| {
                            Button::new("change-repository-pr-state")
                                .label(if closed {
                                    "Reopen"
                                } else {
                                    "Close pull request"
                                })
                                .disabled(self.pending)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.update_pull_request(!closed, cx)
                                }))
                        })),
                )
                .children((pr.state != p::PrState::Merged).then(|| {
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("edit-repository-pr")
                                .label("Edit title and description")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.edit_pull_request(window, cx)
                                })),
                        )
                        .children(
                            matches!(pr.state, p::PrState::Open | p::PrState::Draft).then(|| {
                                Button::new("change-repository-pr-draft")
                                    .label(if pr.state == p::PrState::Draft {
                                        "Ready for review"
                                    } else {
                                        "Convert to draft"
                                    })
                                    .disabled(self.pending)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.toggle_pull_request_draft(cx)
                                    }))
                            }),
                        )
                }))
                .child(merge_controls)
                .into_any_element();
        }
        v_flex()
            .gap_3()
            .child(
                Button::new("new-repository-pr")
                    .primary()
                    .label("New pull request")
                    .disabled(self.read_only())
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.pr_form = true;
                        this.editing_pr = false;
                        this.draft = false;
                        cx.notify();
                    })),
            )
            .children(
                self.pull_requests
                    .is_empty()
                    .then(|| div().child("No pull requests yet.")),
            )
            .children(
                self.pull_requests
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(index, pr)| {
                        Button::new(("repository-pr", index))
                            .ghost()
                            .label(format!("#{} {} · {}", pr.number, pr.title, pr.state))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_pull_request(pr.number, cx)
                            }))
                    }),
            )
            .into_any_element()
    }

    fn render_project(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(project) = self.project.clone() else {
            return v_flex()
                .gap_3()
                .child("Select a repository to browse its code, commits and pull requests.")
                .children(
                    self.projects
                        .is_empty()
                        .then(|| div().child("Create, import or link a repository to start.")),
                )
                .into_any_element();
        };
        if !is_artifacts(&project) {
            let url = github_url(&project);
            let issues_url = format!("{url}/issues");
            return v_flex()
                .gap_3()
                .child(format!("{}/{}", project.owner, project.name))
                .child("This repository is hosted on GitHub.")
                .child(
                    Button::new("open-github-repository")
                        .label("Open on GitHub")
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                )
                .child(
                    Button::new("open-github-issues")
                        .label("Issues on GitHub")
                        .on_click(move |_, _, cx| cx.open_url(&issues_url)),
                )
                .into_any_element();
        }
        let body = if self.loading {
            div().child("Loading repository…").into_any_element()
        } else {
            match self.tab {
                RepositoryTab::Code => self.render_code(cx),
                RepositoryTab::Commits => self.render_commits(cx),
                RepositoryTab::PullRequests => self.render_pull_requests(cx),
                RepositoryTab::Issues => self.issues.as_ref().map_or_else(
                    || {
                        div()
                            .child("Select Issues to load the discussion.")
                            .into_any_element()
                    },
                    |issues| div().child(issues.clone()).into_any_element(),
                ),
            }
        };
        let base_branch = project.default_branch.clone();
        v_flex()
            .gap_3()
            .child(div().text_xl().child(project.name))
            .children(
                self.detail
                    .as_ref()
                    .and_then(|detail| detail.description.clone())
                    .map(|description| div().child(description)),
            )
            .children(self.read_only().then(|| {
                div()
                    .text_color(color(Token::Warning, cx))
                    .child("This repository is read-only.")
            }))
            .children(self.detail.as_ref().map(|detail| {
                let remote = detail.remote.clone();
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .font_family("monospace")
                            .text_sm()
                            .child(remote.clone()),
                    )
                    .child(
                        Button::new("copy-repository-clone-url")
                            .ghost()
                            .label("Copy clone URL")
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(
                                    remote.clone(),
                                ))
                            }),
                    )
            }))
            .child(
                h_flex()
                    .gap_2()
                    .child(Input::new(&self.inputs.reference).aria_label("Repository ref"))
                    .child(
                        Button::new("load-repository-ref")
                            .label("Browse ref")
                            .disabled(
                                self.pending
                                    || self.inputs.reference.read(cx).value().trim().is_empty(),
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.reference =
                                    this.inputs.reference.read(cx).value().trim().to_string();
                                this.explicit_ref = true;
                                this.path.clear();
                                this.file = None;
                                this.pull_request = None;
                                this.load_tab(cx);
                            })),
                    )
                    .child(
                        Button::new("new-repository-workspace")
                            .label("New workspace")
                            .disabled(self.pending || self.read_only() || self.detail.is_none())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_workspace(
                                    p::NewSource::New {
                                        base_branch: base_branch.clone(),
                                    },
                                    cx,
                                )
                            })),
                    ),
            )
            .child(
                TabBar::new("repository-tabs")
                    .selected_index(match self.tab {
                        RepositoryTab::Code => 0,
                        RepositoryTab::Commits => 1,
                        RepositoryTab::PullRequests => 2,
                        RepositoryTab::Issues => 3,
                    })
                    .on_click(cx.listener(|this, index: &usize, window, cx| {
                        this.select_tab(*index, window, cx)
                    }))
                    .children(
                        ["Code", "Commits", "Pull requests", "Issues"]
                            .map(|name| Tab::new().label(name)),
                    ),
            )
            .child(body)
            .into_any_element()
    }
}

impl Render for RepositoryView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = if self.add_mode.is_some() {
            self.render_add(cx)
        } else {
            self.render_project(cx)
        };
        v_flex()
            .size_full()
            .gap_3()
            .p_4()
            .child(
                h_flex()
                    .justify_between()
                    .child(div().text_xl().child("Repositories"))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("refresh-repositories")
                                    .ghost()
                                    .label("Refresh")
                                    .disabled(self.pending || self.projects_loading)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.refresh_current(cx);
                                    })),
                            )
                            .child(
                                Button::new("add-artifact-repository")
                                    .primary()
                                    .label("Add repository")
                                    .disabled(self.pending)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.add_mode = Some(AddMode::Create);
                                        this.error = None;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .children(
                self.error
                    .clone()
                    .map(|error| div().text_color(color(Token::Destructive, cx)).child(error)),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .gap_4()
                    .child(
                        v_flex()
                            .id("repository-list")
                            .w_64()
                            .gap_2()
                            .overflow_y_scroll()
                            .children(
                                self.projects_loading
                                    .then(|| div().child("Loading repositories…")),
                            )
                            .children(self.projects.clone().into_iter().enumerate().map(
                                |(index, project)| {
                                    let label = if is_artifacts(&project) {
                                        project.name.clone()
                                    } else {
                                        format!("{}/{}", project.owner, project.name)
                                    };
                                    Button::new(("select-repository", index))
                                        .ghost()
                                        .label(label)
                                        .disabled(self.pending)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.select_project(project.clone(), window, cx)
                                        }))
                                },
                            )),
                    )
                    .child(
                        div()
                            .id("repository-content")
                            .flex_1()
                            .min_w_0()
                            .overflow_y_scroll()
                            .child(content),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AnyWindowHandle, TestAppContext};
    use serde_json::{Value, json};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};

    fn project() -> p::Project {
        serde_json::from_value(json!({
            "id":"project-artifacts", "provider":"artifacts", "installationId":null,
            "repoId":null, "artifactRepoId":"repo-1", "cloneUrl":"https://git.example/repo.git",
            "owner":"owner", "name":"repo", "defaultBranch":"main", "settings":{}, "sortOrder":0
        }))
        .unwrap()
    }

    fn pull_request() -> Value {
        json!({
            "id":"pr-1", "projectId":"project-artifacts", "number":1, "title":"Improve repository",
            "body":"Details", "headBranch":"feature", "baseBranch":"main", "state":"open",
            "url":"/repositories/project-artifacts/pulls/1", "headSha":"head", "baseSha":"base",
            "mergeSha":null, "createdAt":1, "updatedAt":1, "mergedAt":null
        })
    }

    struct LocalServer {
        url: String,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        linked: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl LocalServer {
        fn new(fail_file: bool, read_only: bool) -> Self {
            Self::configured(fail_file, read_only, false, false, false)
        }

        fn configured(
            fail_file: bool,
            read_only: bool,
            empty: bool,
            fail_merge: bool,
            sleeping: bool,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let log = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let linked = Arc::new(AtomicBool::new(true));
            let worker_linked = linked.clone();
            let worker = std::thread::spawn(move || {
                let mut pr = pull_request();
                let mut workspace_state = if sleeping {
                    p::WorkspaceState::Sleeping
                } else {
                    p::WorkspaceState::Ready
                };
                while !stopping.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::yield_now();
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
                        if let Some(index) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                            break Some(index + 4);
                        }
                    };
                    let Some(head_end) = head_end else {
                        continue;
                    };
                    let header = String::from_utf8_lossy(&bytes[..head_end]);
                    let path = header.split_whitespace().nth(1).unwrap().to_string();
                    let length = header
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    while bytes.len() < head_end + length {
                        let mut chunk = [0; 4096];
                        let n = stream.read(&mut chunk).unwrap();
                        if n == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&chunk[..n]);
                    }
                    let input: Value = serde_json::from_slice(&bytes[head_end..]).unwrap();
                    log.lock().unwrap().push((path.clone(), input.clone()));
                    let commit = json!({"hash":"commit-1","treeHash":"tree-1","message":"First commit",
                        "author":{"name":"Owner","email":"owner@example.com"},"committer":{"name":"Owner","email":"owner@example.com"},
                        "parents":[],"authoredAt":1,"committedAt":1});
                    let (status, body) = match path.rsplit('/').next().unwrap() {
                        "listProjects" => (200, json!([project()])),
                        "getRepository" if empty && input.get("ref").is_some() => {
                            (404, json!({"code":"NOT_FOUND","message":"Ref not found."}))
                        }
                        "getRepository" => {
                            let nested = input["path"] == "src";
                            let entries = if empty {
                                json!([])
                            } else if nested {
                                json!([{"name":"main.rs","path":"src/main.rs","hash":"file-1","type":"blob"}])
                            } else {
                                json!([{"name":"src","path":"src","hash":"tree-2","type":"tree"}])
                            };
                            (
                                200,
                                json!({"projectId":"project-artifacts","name":"repo","description":"An Artifacts repository",
                                "defaultBranch":"main","remote":"https://git.example/repo.git","readOnly":read_only,
                                "ref":input.get("ref").and_then(Value::as_str).unwrap_or("main"),"empty":empty,"entries":entries,"commit":if empty { Value::Null } else { commit }}),
                            )
                        }
                        "getRepositoryFile" if fail_file => (
                            500,
                            json!({"code":"INTERNAL","message":"Could not load file."}),
                        ),
                        "getRepositoryFile" => (
                            200,
                            json!({"content":"fn main() {}\n","encoding":"utf8","size":13}),
                        ),
                        "listRepositoryCommits" => {
                            (200, if empty { json!([]) } else { json!([commit]) })
                        }
                        "listRepositoryPullRequests" => (200, json!([pr])),
                        "getRepositoryPullRequest" => (200, pr.clone()),
                        "createRepositoryPullRequest" => {
                            pr["title"] = input["title"].clone();
                            pr["body"] = input["body"].clone();
                            pr["headBranch"] = input["headBranch"].clone();
                            pr["baseBranch"] = input["baseBranch"].clone();
                            pr["state"] = json!(if input["draft"] == true {
                                "draft"
                            } else {
                                "open"
                            });
                            (200, pr.clone())
                        }
                        "updateRepositoryPullRequest" => {
                            if let Some(state) = input.get("state") {
                                pr["state"] = state.clone();
                            }
                            if let Some(draft) = input.get("draft") {
                                pr["state"] = json!(if draft == true { "draft" } else { "open" });
                            }
                            if let Some(title) = input.get("title") {
                                pr["title"] = title.clone();
                            }
                            if let Some(body) = input.get("body") {
                                pr["body"] = body.clone();
                            }
                            (200, pr.clone())
                        }
                        "listWorkspaces" => {
                            let mut workspace = workspace(workspace_state);
                            if !worker_linked.load(Ordering::Relaxed) {
                                workspace["prNumber"] = Value::Null;
                                workspace["prState"] = Value::Null;
                            }
                            (200, json!([workspace]))
                        }
                        "getWorkspace" => {
                            let mut workspace = workspace(workspace_state);
                            if !worker_linked.load(Ordering::Relaxed) {
                                workspace["prNumber"] = Value::Null;
                                workspace["prState"] = Value::Null;
                            }
                            (200, workspace)
                        }
                        "createPullRequest" => {
                            worker_linked.store(true, Ordering::Relaxed);
                            (200, json!({"number":pr["number"],"url":pr["url"]}))
                        }
                        "wakeWorkspace" => {
                            workspace_state = p::WorkspaceState::Ready;
                            (200, json!({}))
                        }
                        "mergePullRequest" if fail_merge => (
                            409,
                            json!({"code":"PR_NOT_MERGEABLE","message":"Merge conflict."}),
                        ),
                        "mergePullRequest" => {
                            pr["state"] = json!("merged");
                            (200, json!({}))
                        }
                        "createRepository" | "importRepository" | "linkArtifactRepository" => {
                            (200, json!(project()))
                        }
                        "createWorkspace" => {
                            let message: p::WorkspaceServerMessage = include_str!("../../../../packages/protocol/fixtures/channel/workspace-first-load.jsonl")
                                .lines().find_map(|line| {
                                    let message: p::WorkspaceServerMessage = serde_json::from_str(line).ok()?;
                                    matches!(message, p::WorkspaceServerMessage::Workspace(_)).then_some(message)
                                }).unwrap();
                            let p::WorkspaceServerMessage::Workspace(workspace) = message else {
                                unreachable!();
                            };
                            (200, json!(workspace.workspace))
                        }
                        _ => (
                            404,
                            json!({"code":"NOT_FOUND","message":"Unknown function."}),
                        ),
                    };
                    let body = body.to_string();
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
                linked,
                stop,
                worker: Some(worker),
            }
        }
    }

    fn workspace(state: p::WorkspaceState) -> Value {
        let first: Value = serde_json::from_str(
            include_str!(
                "../../../../packages/protocol/fixtures/channel/workspace-first-load.jsonl"
            )
            .lines()
            .next()
            .unwrap(),
        )
        .unwrap();
        let mut workspace = first["workspace"].clone();
        workspace["projectId"] = json!("project-artifacts");
        workspace["branch"] = json!("feature");
        workspace["prNumber"] = json!(1);
        workspace["prState"] = json!("open");
        workspace["state"] = json!(state);
        workspace["checksState"] = Value::Null;
        workspace["runningTurnId"] = Value::Null;
        workspace["pushed"] = json!(true);
        workspace
    }

    impl Drop for LocalServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    fn mount(cx: &mut TestAppContext, client: Client) -> (AnyWindowHandle, Entity<RepositoryView>) {
        cx.background_executor.allow_parking();
        cx.update(|cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| RepositoryView::new(client, window, cx))
            })
            .unwrap()
        })
    }

    fn settle(cx: &mut TestAppContext, view: &Entity<RepositoryView>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if view.read_with(cx, |view, _| {
                !view.projects_loading && !view.loading && !view.pending && !view.workspace_loading
            }) {
                return;
            }
            assert!(Instant::now() < deadline, "repository RPC did not finish");
            std::thread::yield_now();
        }
    }

    #[gpui_kit::test]
    fn native_repository_browsing_and_pull_requests_use_typed_rpcs(cx: &mut TestAppContext) {
        let server = LocalServer::new(false, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, client);
        settle(cx, &view);
        assert_eq!(view.read_with(cx, |view, _| view.projects.len()), 1);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.select_project(project(), window, cx))
        })
        .unwrap();
        settle(cx, &view);
        view.update(cx, |view, cx| {
            assert_eq!(
                view.detail.as_ref().unwrap().description.as_deref(),
                Some("An Artifacts repository")
            );
            let entry = view.detail.as_ref().unwrap().entries[0].clone();
            view.open_entry(entry, cx);
        });
        settle(cx, &view);
        view.update(cx, |view, cx| {
            assert_eq!(view.path, "src");
            let entry = view.detail.as_ref().unwrap().entries[0].clone();
            view.open_entry(entry, cx);
        });
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(view.file.as_ref().unwrap().1.content, "fn main() {}\n")
        });
        view.update(cx, |view, cx| {
            view.tab = RepositoryTab::Commits;
            view.load_tab(cx);
        });
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(view.commits[0].message, "First commit")
        });
        view.update(cx, |view, cx| {
            view.tab = RepositoryTab::PullRequests;
            view.load_tab(cx);
        });
        settle(cx, &view);
        view.read_with(cx, |view, _| assert_eq!(view.pull_requests[0].number, 1.));
        view.update(cx, |view, cx| view.open_pull_request(1., cx));
        settle(cx, &view);
        view.update(cx, |view, cx| view.update_pull_request(true, cx));
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.pull_request.as_ref().unwrap().state,
                p::PrState::Closed
            )
        });
        view.update(cx, |view, cx| view.update_pull_request(false, cx));
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(view.pull_request.as_ref().unwrap().state, p::PrState::Open)
        });
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.edit_pull_request(window, cx);
                view.inputs
                    .title
                    .update(cx, |input, cx| input.set_value("Revised title", window, cx));
                view.inputs.body.update(cx, |input, cx| {
                    input.set_value("Expanded description", window, cx)
                });
                view.save_pull_request(cx);
            })
        })
        .unwrap();
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(view.pull_request.as_ref().unwrap().title, "Revised title");
            assert_eq!(
                view.pull_request.as_ref().unwrap().body,
                "Expanded description"
            );
            assert!(!view.pr_form);
        });
        view.update(cx, |view, cx| view.toggle_pull_request_draft(cx));
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(view.pull_request.as_ref().unwrap().state, p::PrState::Draft)
        });
        view.update(cx, |view, cx| view.toggle_pull_request_draft(cx));
        settle(cx, &view);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.inputs
                    .title
                    .update(cx, |input, cx| input.set_value("Draft feature", window, cx));
                view.inputs
                    .head
                    .update(cx, |input, cx| input.set_value("feature", window, cx));
                view.inputs
                    .body
                    .update(cx, |input, cx| input.set_value("Review this", window, cx));
                view.draft = true;
                view.create_pull_request(cx);
            })
        })
        .unwrap();
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(view.pull_request.as_ref().unwrap().state, p::PrState::Draft)
        });
        let opened = cx.new(|_| None::<String>);
        let _workspace_event = opened.update(cx, |_, cx| {
            cx.subscribe(&view, |opened, _, event: &RepositoryEvent, _| {
                let RepositoryEvent::OpenWorkspace(id) = event;
                *opened = Some(id.clone());
            })
        });
        view.update(cx, |view, cx| {
            view.open_workspace(p::NewSource::Pr { number: 1. }, cx)
        });
        settle(cx, &view);
        cx.run_until_parked();
        assert!(opened.read_with(cx, |id, _| id.is_some()));
        let requests = server.requests.lock().unwrap();
        let file = requests
            .iter()
            .find(|(path, _)| path.ends_with("/getRepositoryFile"))
            .unwrap();
        assert_eq!(
            file.1,
            json!({"projectId":"project-artifacts","ref":"main","path":"src/main.rs"})
        );
        let create = requests
            .iter()
            .find(|(path, _)| path.ends_with("/createRepositoryPullRequest"))
            .unwrap();
        assert_eq!(create.1["draft"], true);
        assert_eq!(create.1["baseBranch"], "main");
        assert_eq!(create.1["body"], "Review this");
        let workspace = requests
            .iter()
            .find(|(path, _)| path.ends_with("/createWorkspace"))
            .unwrap();
        assert_eq!(workspace.1["source"], json!({"kind":"pr","number":1.0}));
    }

    #[gpui_kit::test]
    fn native_repository_forms_create_import_and_link(cx: &mut TestAppContext) {
        let server = LocalServer::new(false, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, client);
        settle(cx, &view);
        for mode in [AddMode::Create, AddMode::Import, AddMode::Link] {
            cx.update_window(window, |_, window, cx| {
                view.update(cx, |view, cx| {
                    view.add_mode = Some(mode);
                    view.inputs
                        .name
                        .update(cx, |input, cx| input.set_value("repo", window, cx));
                    view.inputs.import_url.update(cx, |input, cx| {
                        input.set_value("https://example.com/repo.git", window, cx)
                    });
                    view.add_repository(window, cx);
                })
            })
            .unwrap();
            settle(cx, &view);
            view.read_with(cx, |view, _| {
                assert_eq!(view.project.as_ref().unwrap().id, "project-artifacts")
            });
        }
        let requests = server.requests.lock().unwrap();
        for operation in [
            "createRepository",
            "importRepository",
            "linkArtifactRepository",
        ] {
            assert!(
                requests
                    .iter()
                    .any(|(path, input)| path.ends_with(operation) && input["name"] == "repo")
            );
        }
        let import = requests
            .iter()
            .find(|(path, _)| path.ends_with("/importRepository"))
            .unwrap();
        assert_eq!(import.1["url"], "https://example.com/repo.git");
    }

    #[gpui_kit::test]
    fn repository_errors_and_read_only_state_are_visible(cx: &mut TestAppContext) {
        let server = LocalServer::new(true, true);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, client);
        settle(cx, &view);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.select_project(project(), window, cx))
        })
        .unwrap();
        settle(cx, &view);
        view.update(cx, |view, cx| {
            assert!(view.read_only());
            view.create_pull_request(cx);
            view.open_entry(
                p::RepositoryEntry {
                    name: "file".into(),
                    path: "file".into(),
                    hash: "hash".into(),
                    type_: p::RepositoryEntryType::Blob,
                },
                cx,
            );
        });
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert!(
                view.error
                    .as_ref()
                    .unwrap()
                    .contains("Could not load file.")
            );
            assert!(view.file.is_none());
        });
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/createRepositoryPullRequest"))
        );
        view.update(cx, |view, cx| {
            view.open_workspace(
                p::NewSource::New {
                    base_branch: "main".into(),
                },
                cx,
            );
            view.pull_request = Some(serde_json::from_value(pull_request()).unwrap());
            view.update_pull_request(true, cx);
        });
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.pull_request.as_ref().unwrap().state,
                p::PrState::Closed
            )
        });
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/createWorkspace"))
        );
    }

    #[gpui_kit::test]
    fn empty_repository_omits_default_ref_and_explicit_missing_ref_shows_error(
        cx: &mut TestAppContext,
    ) {
        let server = LocalServer::configured(false, false, true, false, false);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, client);
        settle(cx, &view);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.select_project(project(), window, cx))
        })
        .unwrap();
        settle(cx, &view);
        view.read_with(cx, |view, cx| {
            assert!(view.detail.as_ref().unwrap().empty);
            assert_eq!(view.inputs.reference.read(cx).value().as_str(), "main");
            assert!(view.error.is_none());
        });
        assert!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .find(|(path, _)| path.ends_with("/getRepository"))
                .unwrap()
                .1
                .get("ref")
                .is_none()
        );
        view.update(cx, |view, cx| {
            view.open_workspace(
                p::NewSource::New {
                    base_branch: "main".into(),
                },
                cx,
            )
        });
        settle(cx, &view);
        assert!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, input)| path.ends_with("/createWorkspace")
                    && input["source"]["kind"] == "new")
        );
        view.update(cx, |view, cx| {
            view.explicit_ref = true;
            view.reference = "missing".into();
            view.load_tab(cx);
        });
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert!(view.error.as_ref().unwrap().contains("Ref not found."))
        });
    }

    fn verify_merge(cx: &mut TestAppContext, method: p::MergeMethod, fail: bool, sleeping: bool) {
        let server = LocalServer::configured(false, false, false, fail, sleeping);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, client);
        settle(cx, &view);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.select_project(project(), window, cx))
        })
        .unwrap();
        settle(cx, &view);
        view.update(cx, |view, cx| view.open_pull_request(1., cx));
        settle(cx, &view);
        if sleeping {
            view.read_with(cx, |view, _| assert!(!view.can_merge()));
            view.update(cx, |view, cx| view.wake_pr_workspace(cx));
            settle(cx, &view);
        }
        view.read_with(cx, |view, _| {
            assert!(view.can_merge());
            assert_eq!(view.merge_workspace.as_ref().unwrap().checks_state, None);
        });
        view.update(cx, |view, cx| view.merge_pull_request(method, cx));
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            if fail {
                assert_eq!(view.pull_request.as_ref().unwrap().state, p::PrState::Open);
                assert!(view.error.as_ref().unwrap().contains("Merge conflict."));
            } else {
                assert_eq!(
                    view.pull_request.as_ref().unwrap().state,
                    p::PrState::Merged
                );
            }
        });
        let requests = server.requests.lock().unwrap();
        let merge = requests
            .iter()
            .find(|(path, _)| path.ends_with("/mergePullRequest"))
            .unwrap();
        assert_eq!(merge.1["method"], json!(method));
        assert_eq!(
            merge.1["workspaceId"],
            workspace(p::WorkspaceState::Ready)["id"]
        );
        assert_eq!(
            requests
                .iter()
                .any(|(path, _)| path.ends_with("/wakeWorkspace")),
            sleeping
        );
    }

    #[gpui_kit::test]
    fn native_pull_request_squash_merge_updates_state(cx: &mut TestAppContext) {
        verify_merge(cx, p::MergeMethod::Squash, false, false);
    }

    #[gpui_kit::test]
    fn native_pull_request_merge_can_wake_a_sleeping_workspace(cx: &mut TestAppContext) {
        verify_merge(cx, p::MergeMethod::Merge, false, true);
    }

    #[gpui_kit::test]
    fn native_pull_request_merge_failure_preserves_open_state(cx: &mut TestAppContext) {
        verify_merge(cx, p::MergeMethod::Squash, true, false);
    }

    #[gpui_kit::test]
    fn repository_pull_request_reuses_and_links_existing_branch_workspace(cx: &mut TestAppContext) {
        let server = LocalServer::new(false, false);
        server.linked.store(false, Ordering::Relaxed);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view) = mount(cx, client);
        settle(cx, &view);
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.select_project(project(), window, cx))
        })
        .unwrap();
        settle(cx, &view);
        view.update(cx, |view, cx| view.open_pull_request(1., cx));
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert!(view.merge_workspace.is_some());
            assert!(!view.can_merge());
        });
        let opened = cx.new(|_| None::<String>);
        let _event = opened.update(cx, |_, cx| {
            cx.subscribe(&view, |opened, _, event: &RepositoryEvent, _| {
                let RepositoryEvent::OpenWorkspace(id) = event;
                *opened = Some(id.clone());
            })
        });
        view.update(cx, |view, cx| view.open_pr_workspace(cx));
        cx.run_until_parked();
        assert!(opened.read_with(cx, |id, _| id.is_some()));
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/createWorkspace"))
        );
        view.update(cx, |view, cx| view.link_pr_workspace(cx));
        settle(cx, &view);
        view.read_with(cx, |view, _| assert!(view.can_merge()));
        assert!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, input)| path.ends_with("/createPullRequest")
                    && input["title"] == "Improve repository")
        );
        view.update(cx, |view, cx| view.update_pull_request(true, cx));
        settle(cx, &view);
        view.update(cx, |view, cx| {
            view.pull_request.as_mut().unwrap().state = p::PrState::Open;
            view.refresh_current(cx);
        });
        settle(cx, &view);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.pull_request.as_ref().unwrap().state,
                p::PrState::Closed
            )
        });
    }

    #[test]
    fn folder_parent_stays_in_repository() {
        assert_eq!(parent_path("src/lib"), "src");
        assert_eq!(parent_path("src"), "");
        assert_eq!(parent_path(""), "");
    }
}
