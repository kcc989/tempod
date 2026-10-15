//! The Deploys tab of a native repository (12, Clients): deployments, detail with the log,
//! Deploy/Cancel/Redeploy/Roll back, production errors and the owner deploy configuration.

use super::ci_model::{CiTone, short_sha};
use super::deploy_model::{self as model, Action, Page};
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::{Disableable as _, Selectable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement as _,
    Render, Styled as _, Subscription, Window, div,
};
use std::time::Duration;
use tempo_client::Client;
use tempo_protocol::{self as p, api};

const LIVE: Duration = Duration::from_secs(5);

pub enum DeploysEvent {
    OpenWorkspace(String),
}

pub struct DeploysView {
    client: Client,
    project_id: String,
    deployments: Vec<p::Deployment>,
    deployment: Option<p::Deployment>,
    log: Option<p::GetDeploymentLogOut>,
    config: Option<p::DeployConfig>,
    errors: Vec<p::ProductionError>,
    webhook: Option<p::GetIssuesWebhookOut>,
    secret: Option<String>,
    page: Page,
    target: Option<String>,
    loading: bool,
    pending: bool,
    generation: u64,
    error: Option<String>,
    problem: Option<(String, bool)>,
    branch: Entity<InputState>,
    source: Entity<TextareaState>,
    _subscriptions: Vec<Subscription>,
}

impl DeploysView {
    pub fn new(
        client: Client,
        project_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let branch =
            cx.new(|cx| InputState::new(window, cx).placeholder("Branch, e.g. main".to_string()));
        let source = cx.new(|cx| TextareaState::new(window, cx).auto_grow(6, 20));
        let subscriptions = vec![
            cx.observe(&branch, |_, _, cx| cx.notify()),
            cx.observe(&source, |_, _, cx| cx.notify()),
        ];
        let mut view = Self {
            client,
            project_id,
            deployments: vec![],
            deployment: None,
            log: None,
            config: None,
            errors: vec![],
            webhook: None,
            secret: None,
            page: Page::default(),
            target: None,
            loading: false,
            pending: false,
            generation: 0,
            error: None,
            problem: None,
            branch,
            source,
            _subscriptions: subscriptions,
        };
        view.load_deployments(cx);
        view.load_errors(cx);
        view.load_config(window, cx);
        view.load_webhook(cx);
        view
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.load_deployments(cx);
        self.load_errors(cx);
        if let Some(deployment) = &self.deployment {
            let id = deployment.id.clone();
            self.open_deployment(id, cx);
        }
    }

    fn load_deployments(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.error = None;
        let request = self
            .client
            .call::<api::ListDeployments>(self.page.input(&self.project_id));
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(deployments) => this.deployments = deployments,
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn load_errors(&mut self, cx: &mut Context<Self>) {
        let request = self
            .client
            .call::<api::ListProductionErrors>(p::ListProductionErrorsIn {
                project_id: self.project_id.clone(),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(errors) => this.errors = errors,
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn start_fix(&mut self, error_id: String, cx: &mut Context<Self>) {
        let Ok(error_id) = error_id.parse() else {
            return;
        };
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        let request = self.client.call::<api::StartErrorFix>(p::StartErrorFixIn {
            project_id: self.project_id.clone(),
            error_id,
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(out) => {
                        this.load_errors(cx);
                        cx.emit(DeploysEvent::OpenWorkspace(out.workspace_id));
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn load_webhook(&mut self, cx: &mut Context<Self>) {
        let request = self
            .client
            .call::<api::GetIssuesWebhook>(p::GetIssuesWebhookIn {
                project_id: self.project_id.clone(),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(webhook) => this.webhook = Some(webhook),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn rotate_secret(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        let request = self
            .client
            .call::<api::RotateIssuesWebhook>(p::RotateIssuesWebhookIn {
                project_id: self.project_id.clone(),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(out) => {
                        this.webhook = Some(p::GetIssuesWebhookOut {
                            url: out.url,
                            secret_set: true,
                        });
                        this.secret = Some(out.secret);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn load_config(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let request = self
            .client
            .call::<api::GetDeployConfig>(p::GetDeployConfigIn {
                project_id: self.project_id.clone(),
            });
        let window = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = cx.update_window(window, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    match result {
                        Ok(config) => this.show_config(config, window, cx),
                        Err(error) => this.error = Some(error.to_string()),
                    }
                    cx.notify();
                });
            });
        })
        .detach();
    }

    fn show_config(
        &mut self,
        config: p::DeployConfig,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let source = config.source.clone();
        self.source
            .update(cx, |input, cx| input.set_value(source, window, cx));
        if !config
            .targets
            .iter()
            .any(|t| Some(&t.key) == self.target.as_ref())
        {
            self.target = config.targets.first().map(|t| t.key.clone());
        }
        self.config = Some(config);
        self.problem = None;
    }

    fn selected_target(&self) -> Option<&p::DeployTarget> {
        self.config
            .as_ref()?
            .targets
            .iter()
            .find(|t| Some(&t.key) == self.target.as_ref())
    }

    fn open_deployment(&mut self, id: String, cx: &mut Context<Self>) {
        let Ok(deployment_id) = id.parse() else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        self.error = None;
        let request = self.client.call::<api::GetDeployment>(p::GetDeploymentIn {
            project_id: self.project_id.clone(),
            deployment_id,
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match result {
                    Ok(deployment) => {
                        let live = model::is_live(&deployment);
                        this.deployment = Some(deployment);
                        this.load_log(cx);
                        if live {
                            this.poll(generation, cx);
                        }
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Reloads an unfinished deployment every 5 seconds while it stays open.
    fn poll(&mut self, generation: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LIVE).await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                if let Some(deployment) = &this.deployment {
                    let id = deployment.id.clone();
                    this.open_deployment(id, cx);
                }
            });
        })
        .detach();
    }

    fn load_log(&mut self, cx: &mut Context<Self>) {
        let Some(Ok(deployment_id)) = self.deployment.as_ref().map(|d| d.id.parse()) else {
            return;
        };
        let generation = self.generation;
        let request = self
            .client
            .call::<api::GetDeploymentLog>(p::GetDeploymentLogIn {
                project_id: self.project_id.clone(),
                deployment_id,
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match result {
                    Ok(log) => this.log = Some(log),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn start(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.selected_target() else {
            return;
        };
        let Some(input) =
            model::start_input(&self.project_id, target, &self.branch.read(cx).value())
        else {
            return;
        };
        let request = self.client.call::<api::StartDeployment>(input);
        self.mutate(request, cx);
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        let Some(Ok(deployment_id)) = self.deployment.as_ref().map(|d| d.id.parse()) else {
            return;
        };
        let request = self
            .client
            .call::<api::CancelDeployment>(p::CancelDeploymentIn {
                project_id: self.project_id.clone(),
                deployment_id,
            });
        self.mutate(request, cx);
    }

    fn redeploy(&mut self, cx: &mut Context<Self>) {
        let Some(Ok(deployment_id)) = self.deployment.as_ref().map(|d| d.id.parse()) else {
            return;
        };
        let request = self.client.call::<api::Redeploy>(p::RedeployIn {
            project_id: self.project_id.clone(),
            deployment_id,
        });
        self.mutate(request, cx);
    }

    fn rollback(&mut self, cx: &mut Context<Self>) {
        let Some(Ok(deployment_id)) = self.deployment.as_ref().map(|d| d.id.parse()) else {
            return;
        };
        let request = self
            .client
            .call::<api::RollbackDeployment>(p::RollbackDeploymentIn {
                project_id: self.project_id.clone(),
                deployment_id,
            });
        self.mutate(request, cx);
    }

    /// Runs a deploy, cancel, redeploy or rollback and opens the deployment it returns.
    fn mutate(
        &mut self,
        request: impl std::future::Future<Output = Result<p::Deployment, tempo_client::ApiError>>
        + Send
        + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(deployment) => {
                        this.load_deployments(cx);
                        this.open_deployment(deployment.id, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn save_config(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(config) = &self.config else {
            return;
        };
        if self.pending {
            return;
        }
        let request = self
            .client
            .call::<api::UpdateDeployConfig>(p::UpdateDeployConfigIn {
                project_id: self.project_id.clone(),
                source: self.source.read(cx).value().to_string(),
                revision: config.revision,
            });
        self.pending = true;
        let window = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = cx.update_window(window, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    this.pending = false;
                    match result {
                        Ok(config) => this.show_config(config, window, cx),
                        Err(error) => this.problem = Some(model::config_problem(&error)),
                    }
                    cx.notify();
                });
            });
        })
        .detach();
        cx.notify();
    }

    fn tone(&self, tone: CiTone, cx: &Context<Self>) -> gpui_kit::Hsla {
        match tone {
            CiTone::Success => color(Token::Success, cx),
            CiTone::Danger => color(Token::Destructive, cx),
            CiTone::Warning => color(Token::Warning, cx),
            CiTone::Muted => color(Token::MutedForeground, cx),
        }
    }

    fn render_deploy(&self, cx: &mut Context<Self>) -> AnyElement {
        let targets = self
            .config
            .as_ref()
            .map(|c| c.targets.clone())
            .unwrap_or_default();
        let target = self.selected_target().cloned();
        let needs_branch = target.as_ref().is_some_and(model::needs_branch);
        let ready = target.as_ref().is_some_and(|target| {
            model::start_input(&self.project_id, target, &self.branch.read(cx).value()).is_some()
        });
        h_flex()
            .gap_2()
            .children(targets.into_iter().enumerate().map(|(index, target)| {
                let key = target.key.clone();
                Button::new(("deploy-target", index))
                    .ghost()
                    .label(model::target_label(&target))
                    .selected(self.target.as_ref() == Some(&target.key))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.target = Some(key.clone());
                        cx.notify();
                    }))
            }))
            .children(needs_branch.then(|| Input::new(&self.branch)))
            .child(
                Button::new("deploy-start")
                    .primary()
                    .label("Deploy")
                    .disabled(self.pending || !ready)
                    .on_click(cx.listener(|this, _, _, cx| this.start(cx))),
            )
            .into_any_element()
    }

    fn render_list(&self, cx: &mut Context<Self>) -> AnyElement {
        let now = super::indicators::now_ms();
        let filters = self
            .config
            .as_ref()
            .map(|c| c.targets.iter().map(|t| t.key.clone()).collect::<Vec<_>>())
            .unwrap_or_default();
        v_flex()
            .gap_3()
            .children(self.render_errors(cx))
            .child(self.render_deploy(cx))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_color(color(Token::MutedForeground, cx))
                            .child("Target"),
                    )
                    .child(
                        Button::new("deploy-filter-all")
                            .ghost()
                            .label("All")
                            .selected(self.page.target.is_none())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page.filter(None);
                                this.load_deployments(cx);
                            })),
                    )
                    .children(filters.into_iter().enumerate().map(|(index, key)| {
                        Button::new(("deploy-filter", index))
                            .ghost()
                            .label(key.clone())
                            .selected(self.page.target.as_ref() == Some(&key))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.page.filter(Some(key.clone()));
                                this.load_deployments(cx);
                            }))
                    })),
            )
            .children(self.loading.then(|| div().child("Loading deployments…")))
            .children((!self.loading && self.deployments.is_empty()).then(|| {
                div().child(if self.page.has_newer() {
                    "No older deployments."
                } else {
                    "No deployments yet. Save a configuration below, then deploy a target."
                })
            }))
            .children(self.deployments.clone().into_iter().enumerate().map(
                |(index, deployment)| {
                    let (label, tone) = model::state(&deployment);
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new(("deployment", index))
                                .ghost()
                                .label(format!(
                                    "#{} {} · {} · {} · {} · {}",
                                    deployment.number,
                                    deployment.target,
                                    deployment.stage,
                                    deployment.branch,
                                    short_sha(&deployment.sha),
                                    model::trigger(deployment.trigger)
                                ))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.open_deployment(deployment.id.clone(), cx)
                                })),
                        )
                        .child(div().text_color(self.tone(tone, cx)).child(label))
                        .child(div().text_color(color(Token::MutedForeground, cx)).child(
                            super::indicators::format_relative(deployment.created_at, now),
                        ))
                },
            ))
            .child(
                h_flex()
                    .gap_2()
                    .children(self.page.has_newer().then(|| {
                        Button::new("deploy-newer")
                            .ghost()
                            .label("Newer deployments")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page.newer();
                                this.load_deployments(cx);
                            }))
                    }))
                    .children(self.page.has_older(self.deployments.len()).then(|| {
                        Button::new("deploy-older")
                            .ghost()
                            .label("Older deployments")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page.older();
                                this.load_deployments(cx);
                            }))
                    })),
            )
            .child(self.render_config(cx))
            .children(self.render_webhook(cx))
            .into_any_element()
    }

    fn render_errors(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.errors.is_empty() {
            return None;
        }
        let now = super::indicators::now_ms();
        Some(
            v_flex()
                .gap_2()
                .child(div().child("Production errors"))
                .children(self.errors.iter().enumerate().map(|(index, error)| {
                    let action =
                        match error.fix_workspace_id.clone() {
                            Some(workspace_id) => Button::new(("deploy-error-open", index))
                                .ghost()
                                .label("Open fix")
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    cx.emit(DeploysEvent::OpenWorkspace(workspace_id.clone()))
                                })),
                            None => {
                                let id = error.id.clone();
                                Button::new(("deploy-error-fix", index))
                                    .ghost()
                                    .label("Start fix")
                                    .disabled(self.pending)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.start_fix(id.clone(), cx)
                                    }))
                            }
                        };
                    h_flex()
                        .gap_2()
                        .when(error.fixed_at.is_some(), |row| row.opacity(0.6))
                        .child(
                            v_flex().child(div().child(error.title.clone())).child(
                                div()
                                    .text_xs()
                                    .text_color(color(Token::MutedForeground, cx))
                                    .child(model::production_error_facts(error, now)),
                            ),
                        )
                        .child(action)
                }))
                .into_any_element(),
        )
    }

    fn render_webhook(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let webhook = self.webhook.as_ref()?;
        Some(
            v_flex()
                .gap_2()
                .child(div().child("Production error webhook"))
                .child(div().text_color(color(Token::MutedForeground, cx)).child(
                    "In Cloudflare, add a generic webhook destination with this URL and secret, and an Issues automation that sends new issues to it.",
                ))
                .child(
                    div()
                        .font_family("monospace")
                        .text_xs()
                        .child(webhook.url.clone()),
                )
                .child(
                    div()
                        .text_color(color(Token::MutedForeground, cx))
                        .child(if webhook.secret_set {
                            "A secret is set."
                        } else {
                            "No secret yet."
                        }),
                )
                .children(self.secret.clone().map(|secret| {
                    div()
                        .font_family("monospace")
                        .text_xs()
                        .child(format!("Secret (shown once): {secret}"))
                }))
                .child(
                    Button::new("deploy-webhook-rotate")
                        .ghost()
                        .label("New secret")
                        .disabled(self.pending)
                        .on_click(cx.listener(|this, _, _, cx| this.rotate_secret(cx))),
                )
                .into_any_element(),
        )
    }

    fn render_config(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(config) = &self.config else {
            return div().child("Loading configuration…").into_any_element();
        };
        let unchanged = self.source.read(cx).value() == config.source.as_str();
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .gap_2()
                    .child(div().child("Configuration"))
                    .child(
                        div()
                            .text_color(color(Token::MutedForeground, cx))
                            .child(model::config_summary(config)),
                    ),
            )
            .child(div().text_color(color(Token::MutedForeground, cx)).child(
                "YAML with version: 1, tool and targets. Deploys get read-only repository access and no secrets. Leave it empty to turn deploys off.",
            ))
            .child(Textarea::new(&self.source))
            .children(self.problem.clone().map(|(text, stale)| {
                h_flex()
                    .gap_2()
                    .child(div().text_color(color(Token::Destructive, cx)).child(text))
                    .children(stale.then(|| {
                        Button::new("deploy-config-reload")
                            .ghost()
                            .label("Reload")
                            .on_click(cx.listener(|this, _, window, cx| this.load_config(window, cx)))
                    }))
            }))
            .child(
                Button::new("deploy-config-save")
                    .primary()
                    .label(if self.pending { "Saving…" } else { "Save configuration" })
                    .disabled(self.pending || unchanged)
                    .on_click(cx.listener(|this, _, window, cx| this.save_config(window, cx))),
            )
            .into_any_element()
    }

    fn render_rollout(&self, rollout: &p::DeployRollout, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .gap_1()
            .child(div().child(model::rollout_heading(rollout, super::indicators::now_ms())))
            .children(rollout.workers.iter().map(|worker| {
                let (share, versions) = model::rollout_worker(worker);
                v_flex()
                    .child(div().font_family("monospace").text_xs().child(share))
                    .child(
                        div()
                            .font_family("monospace")
                            .text_xs()
                            .text_color(color(Token::MutedForeground, cx))
                            .child(versions),
                    )
            }))
            .into_any_element()
    }

    fn render_deployment(&self, deployment: &p::Deployment, cx: &mut Context<Self>) -> AnyElement {
        let (label, tone) = model::state(deployment);
        let facts = model::facts(deployment, super::indicators::now_ms());
        v_flex()
            .gap_3()
            .child(
                Button::new("deploy-back")
                    .ghost()
                    .label("← Deployments")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.generation += 1;
                        this.deployment = None;
                        this.log = None;
                        this.load_deployments(cx);
                    })),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(div().child(format!(
                        "Deployment #{} {}",
                        deployment.number, deployment.target
                    )))
                    .child(div().text_color(self.tone(tone, cx)).child(label))
                    .children(model::can_roll_back(deployment).then(|| {
                        Button::new("deploy-rollback")
                            .ghost()
                            .label("Roll back")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.rollback(cx)))
                    }))
                    .child(match model::action(deployment) {
                        Action::Cancel => Button::new("deploy-cancel")
                            .ghost()
                            .label("Cancel")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                        Action::Redeploy => Button::new("deploy-redeploy")
                            .ghost()
                            .label("Redeploy")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.redeploy(cx))),
                    }),
            )
            .child(
                div()
                    .text_color(color(Token::MutedForeground, cx))
                    .child(format!(
                        "Stage {} · {} · {} · {} · configuration revision {}",
                        deployment.stage,
                        deployment.branch,
                        short_sha(&deployment.sha),
                        model::trigger(deployment.trigger),
                        deployment.revision
                    )),
            )
            .children((!facts.is_empty()).then(|| div().child(facts)))
            .children(
                deployment
                    .rollout
                    .as_ref()
                    .map(|rollout| self.render_rollout(rollout, cx)),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(div().text_color(color(Token::MutedForeground, cx)).child(
                        if self.log.as_ref().is_some_and(|log| log.truncated) {
                            "Log (last 1 MiB)"
                        } else {
                            "Log"
                        },
                    ))
                    .child(div().font_family("monospace").text_xs().child(
                        self.log.as_ref().map_or_else(
                            || "Loading log…".to_string(),
                            |log| {
                                if log.text.is_empty() {
                                    "No output yet.".to_string()
                                } else {
                                    log.text.clone()
                                }
                            },
                        ),
                    )),
            )
            .into_any_element()
    }
}

impl EventEmitter<DeploysEvent> for DeploysView {}

impl Render for DeploysView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = match self.deployment.clone() {
            Some(deployment) => self.render_deployment(&deployment, cx),
            None => self.render_list(cx),
        };
        v_flex()
            .gap_3()
            .children(
                self.error
                    .clone()
                    .map(|error| div().text_color(color(Token::Destructive, cx)).child(error)),
            )
            .child(content)
    }
}

#[cfg(test)]
#[path = "repository_deploys_tests.rs"]
mod tests;
