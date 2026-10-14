//! The Checks tab of a native repository (10, Clients): runs, run detail with logs, and the
//! owner pipeline.

use super::ci_model::{self as model, CiTone};
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render,
    Styled as _, Subscription, Window, div,
};
use std::time::Duration;
use tempo_client::Client;
use tempo_protocol::{self as p, api};

const PAGE: usize = 50;

const LIVE: Duration = Duration::from_secs(5);

pub struct ChecksView {
    client: Client,
    project_id: String,
    runs: Vec<p::CiRun>,
    run: Option<p::CiRunDetail>,
    job: Option<String>,
    log: Option<p::GetCiJobLogOut>,
    pipeline: Option<p::CiPipeline>,
    branch_filter: Option<String>,
    offset: usize,
    loading: bool,
    pending: bool,
    generation: u64,
    error: Option<String>,
    problem: Option<(String, bool)>,
    branch: Entity<InputState>,
    source: Entity<TextareaState>,
    _subscriptions: Vec<Subscription>,
}

impl ChecksView {
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
            runs: vec![],
            run: None,
            job: None,
            log: None,
            pipeline: None,
            branch_filter: None,
            offset: 0,
            loading: false,
            pending: false,
            generation: 0,
            error: None,
            problem: None,
            branch,
            source,
            _subscriptions: subscriptions,
        };
        view.load_runs(cx);
        view.load_pipeline(window, cx);
        view
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.load_runs(cx);
        if let Some(detail) = &self.run {
            let id = detail.run.id.clone();
            self.open_run(id, cx);
        }
    }

    fn load_runs(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.error = None;
        let request = self.client.call::<api::ListCiRuns>(p::ListCiRunsIn {
            project_id: self.project_id.clone(),
            branch: self
                .branch_filter
                .as_deref()
                .and_then(|branch| branch.parse().ok()),
            offset: Some(self.offset as f64),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(runs) => this.runs = runs,
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn load_pipeline(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let request = self.client.call::<api::GetCiPipeline>(p::GetCiPipelineIn {
            project_id: self.project_id.clone(),
        });
        let window = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = cx.update_window(window, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    match result {
                        Ok(pipeline) => this.show_pipeline(pipeline, window, cx),
                        Err(error) => this.error = Some(error.to_string()),
                    }
                    cx.notify();
                });
            });
        })
        .detach();
    }

    fn show_pipeline(
        &mut self,
        pipeline: p::CiPipeline,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let source = pipeline.source.clone();
        self.source
            .update(cx, |input, cx| input.set_value(source, window, cx));
        self.pipeline = Some(pipeline);
        self.problem = None;
    }

    fn open_run(&mut self, id: String, cx: &mut Context<Self>) {
        let Ok(run_id) = id.parse() else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        self.error = None;
        let request = self.client.call::<api::GetCiRun>(p::GetCiRunIn {
            project_id: self.project_id.clone(),
            run_id,
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match result {
                    Ok(detail) => {
                        let live = detail.run.status != p::CiRunStatus::Completed;
                        let same = this.run.as_ref().map(|r| &r.run.id) == Some(&detail.run.id);
                        if !same {
                            this.job = None;
                        }
                        this.run = Some(detail);
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

    /// Reloads an unfinished run every 5 seconds while it stays open.
    fn poll(&mut self, generation: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LIVE).await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                if let Some(detail) = &this.run {
                    let id = detail.run.id.clone();
                    this.open_run(id, cx);
                }
            });
        })
        .detach();
    }

    fn load_log(&mut self, cx: &mut Context<Self>) {
        let Some(detail) = &self.run else {
            return;
        };
        let Some(job) = model::selected_job(&detail.jobs, self.job.as_deref()) else {
            self.log = None;
            return;
        };
        let (Ok(run_id), Ok(job_key)) = (detail.run.id.parse(), job.key.parse()) else {
            return;
        };
        let generation = self.generation;
        let request = self.client.call::<api::GetCiJobLog>(p::GetCiJobLogIn {
            project_id: self.project_id.clone(),
            run_id,
            job: job_key,
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

    fn start_run(&mut self, cx: &mut Context<Self>) {
        let branch = self.branch.read(cx).value().trim().to_string();
        let Ok(branch) = branch.parse() else {
            return;
        };
        let request = self.client.call::<api::StartCiRun>(p::StartCiRunIn {
            project_id: self.project_id.clone(),
            branch,
        });
        self.mutate(request, cx);
    }

    fn cancel_run(&mut self, cx: &mut Context<Self>) {
        let Some(Ok(run_id)) = self.run.as_ref().map(|d| d.run.id.parse()) else {
            return;
        };
        let request = self.client.call::<api::CancelCiRun>(p::CancelCiRunIn {
            project_id: self.project_id.clone(),
            run_id,
        });
        self.mutate(request, cx);
    }

    fn rerun(&mut self, cx: &mut Context<Self>) {
        let Some(Ok(run_id)) = self.run.as_ref().map(|d| d.run.id.parse()) else {
            return;
        };
        let request = self.client.call::<api::RerunCiRun>(p::RerunCiRunIn {
            project_id: self.project_id.clone(),
            run_id,
        });
        self.mutate(request, cx);
    }

    /// Runs a start, cancel or rerun and opens the run it returns.
    fn mutate(
        &mut self,
        request: impl std::future::Future<Output = Result<p::CiRun, tempo_client::ApiError>>
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
                    Ok(run) => {
                        this.load_runs(cx);
                        this.open_run(run.id, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn save_pipeline(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pipeline) = &self.pipeline else {
            return;
        };
        if self.pending {
            return;
        }
        let request = self
            .client
            .call::<api::UpdateCiPipeline>(p::UpdateCiPipelineIn {
                project_id: self.project_id.clone(),
                source: self.source.read(cx).value().to_string(),
                revision: pipeline.revision,
            });
        self.pending = true;
        let window = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = cx.update_window(window, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    this.pending = false;
                    match result {
                        Ok(pipeline) => this.show_pipeline(pipeline, window, cx),
                        Err(error) => this.problem = Some(model::pipeline_problem(&error)),
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

    fn render_list(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .gap_2()
                    .child(Input::new(&self.branch))
                    .child(
                        Button::new("ci-filter-branch")
                            .ghost()
                            .label("Filter")
                            .on_click(cx.listener(|this, _, _, cx| {
                                let branch = this.branch.read(cx).value().trim().to_string();
                                this.branch_filter = (!branch.is_empty()).then_some(branch);
                                this.offset = 0;
                                this.load_runs(cx);
                            })),
                    )
                    .child(
                        Button::new("ci-run-branch")
                            .primary()
                            .label("Run checks")
                            .disabled(
                                self.pending || self.branch.read(cx).value().trim().is_empty(),
                            )
                            .on_click(cx.listener(|this, _, _, cx| this.start_run(cx))),
                    ),
            )
            .children(self.loading.then(|| div().child("Loading check runs…")))
            .children((!self.loading && self.runs.is_empty()).then(|| {
                div().child(if self.offset > 0 {
                    "No older runs."
                } else {
                    "No check runs yet. Save a pipeline below; pushes then run it."
                })
            }))
            .children(
                self.runs
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(index, run)| {
                        let (label, tone) = model::run_state(&run);
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new(("ci-run", index))
                                    .ghost()
                                    .label(format!(
                                        "#{} {} · {} · {}",
                                        run.number,
                                        run.branch,
                                        model::short_sha(&run.sha),
                                        run.trigger
                                    ))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.open_run(run.id.clone(), cx)
                                    })),
                            )
                            .child(div().text_color(self.tone(tone, cx)).child(label))
                    }),
            )
            .child(
                h_flex()
                    .gap_2()
                    .children((self.offset > 0).then(|| {
                        Button::new("ci-newer-runs")
                            .ghost()
                            .label("Newer runs")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.offset = this.offset.saturating_sub(PAGE);
                                this.load_runs(cx);
                            }))
                    }))
                    .children((self.runs.len() == PAGE).then(|| {
                        Button::new("ci-older-runs")
                            .ghost()
                            .label("Older runs")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.offset += PAGE;
                                this.load_runs(cx);
                            }))
                    })),
            )
            .child(self.render_pipeline(cx))
            .into_any_element()
    }

    fn render_pipeline(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(pipeline) = &self.pipeline else {
            return div().child("Loading pipeline…").into_any_element();
        };
        let unchanged = self.source.read(cx).value() == pipeline.source.as_str();
        let summary = if pipeline.revision == 0. {
            "Not saved yet".to_string()
        } else if pipeline.required.is_empty() {
            format!("Revision {}", pipeline.revision)
        } else {
            format!(
                "Revision {} · merges need {}",
                pipeline.revision,
                pipeline.required.join(", ")
            )
        };
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .gap_2()
                    .child(div().child("Pipeline"))
                    .child(div().child(if pipeline.enabled { "Enabled" } else { "Off" }))
                    .child(div().text_color(color(Token::MutedForeground, cx)).child(summary)),
            )
            .child(div().text_color(color(Token::MutedForeground, cx)).child(
                "YAML with version: 1 and jobs. Jobs get read-only repository access and no secrets. Leave it empty to turn CI off.",
            ))
            .child(Textarea::new(&self.source))
            .children(self.problem.clone().map(|(text, stale)| {
                h_flex()
                    .gap_2()
                    .child(div().text_color(color(Token::Destructive, cx)).child(text))
                    .children(stale.then(|| {
                        Button::new("ci-pipeline-reload")
                            .ghost()
                            .label("Reload")
                            .on_click(cx.listener(|this, _, window, cx| this.load_pipeline(window, cx)))
                    }))
            }))
            .child(
                Button::new("ci-pipeline-save")
                    .primary()
                    .label(if self.pending { "Saving…" } else { "Save pipeline" })
                    .disabled(self.pending || unchanged)
                    .on_click(cx.listener(|this, _, window, cx| this.save_pipeline(window, cx))),
            )
            .into_any_element()
    }

    fn render_run(&self, detail: &p::CiRunDetail, cx: &mut Context<Self>) -> AnyElement {
        let run = &detail.run;
        let (label, tone) = model::run_state(run);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0., |d| d.as_millis() as f64);
        let selected =
            model::selected_job(&detail.jobs, self.job.as_deref()).map(|j| j.key.clone());
        v_flex()
            .gap_3()
            .child(
                Button::new("ci-back")
                    .ghost()
                    .label("← Check runs")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.generation += 1;
                        this.run = None;
                        this.log = None;
                        this.load_runs(cx);
                    })),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(div().child(format!("Run #{} {}", run.number, run.branch)))
                    .child(div().text_color(self.tone(tone, cx)).child(label))
                    .child(
                        div()
                            .text_color(color(Token::MutedForeground, cx))
                            .child(format!(
                                "{} · {} · pipeline revision {}",
                                model::short_sha(&run.sha),
                                run.trigger,
                                run.revision
                            )),
                    )
                    .child(if run.status == p::CiRunStatus::Completed {
                        Button::new("ci-rerun")
                            .ghost()
                            .label("Rerun")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.rerun(cx)))
                    } else {
                        Button::new("ci-cancel")
                            .ghost()
                            .label("Cancel")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.cancel_run(cx)))
                    }),
            )
            .children(
                detail
                    .jobs
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(index, job)| {
                        let (label, tone) = model::job_state(&job);
                        let facts = [
                            (!job.needs.is_empty())
                                .then(|| format!("needs {}", job.needs.join(", "))),
                            job.exit_code.map(|code| format!("exit {code}")),
                            Some(model::duration(job.started_at, job.completed_at, now)),
                            job.summary.clone(),
                        ]
                        .into_iter()
                        .flatten()
                        .filter(|fact| !fact.is_empty())
                        .collect::<Vec<_>>()
                        .join(" · ");
                        let mark = if selected.as_deref() == Some(job.key.as_str()) {
                            "▸ "
                        } else {
                            ""
                        };
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new(("ci-job", index))
                                    .ghost()
                                    .label(format!("{mark}{}", job.name))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.job = Some(job.key.clone());
                                        this.load_log(cx);
                                        cx.notify();
                                    })),
                            )
                            .child(div().text_color(self.tone(tone, cx)).child(label))
                            .child(
                                div()
                                    .text_color(color(Token::MutedForeground, cx))
                                    .child(facts),
                            )
                    }),
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

impl Render for ChecksView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = match self.run.clone() {
            Some(detail) => self.render_run(&detail, cx),
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
#[path = "repository_checks_tests.rs"]
mod tests;
