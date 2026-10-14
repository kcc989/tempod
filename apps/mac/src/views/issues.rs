use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::{Disableable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render,
    Styled as _, Subscription, Window, div,
};
use tempo_client::{ApiError, Client};
use tempo_protocol::{self as p, api};

type Request<T> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, ApiError>> + Send>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum IssueFilter {
    Open,
    Closed,
    All,
}

struct Inputs {
    search: Entity<InputState>,
    title: Entity<InputState>,
    body: Entity<TextareaState>,
    comment: Entity<TextareaState>,
    label_name: Entity<InputState>,
    label_color: Entity<InputState>,
    label_description: Entity<InputState>,
}

pub struct IssuesView {
    client: Client,
    project_id: String,
    issues: Vec<p::RepositoryIssue>,
    issue: Option<p::RepositoryIssue>,
    comments: Vec<p::RepositoryIssueComment>,
    labels: Vec<p::RepositoryLabel>,
    filter: IssueFilter,
    label_filter: Option<String>,
    applied_query: String,
    selected_labels: Vec<String>,
    editing_issue: Option<bool>,
    editing_comment: Option<String>,
    manage_labels: bool,
    editing_label: Option<Option<String>>,
    loading: bool,
    comments_loading: bool,
    labels_loading: bool,
    pending: bool,
    more_issues: bool,
    more_comments: bool,
    next_issue_offset: usize,
    next_comment_offset: usize,
    list_generation: u64,
    issue_generation: u64,
    labels_generation: u64,
    error: Option<String>,
    access: super::social_model::Access,
    user_id: Option<String>,
    inputs: Inputs,
    _subscriptions: Vec<Subscription>,
}

impl IssuesView {
    /// Hides controls the caller's project role does not allow (04, Public projects; 11).
    pub fn set_access(
        &mut self,
        access: super::social_model::Access,
        user_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.access = access;
        self.user_id = user_id;
        cx.notify();
    }

    pub fn new(
        client: Client,
        project_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut input = |placeholder: &str| {
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder.to_string()))
        };
        let search = input("Search issues");
        let title = input("Issue title");
        let label_name = input("Label name");
        let label_color = input("Six hexadecimal digits, e.g. 0969da");
        let label_description = input("Description (optional)");
        let body = cx.new(|cx| TextareaState::new(window, cx).auto_grow(3, 12));
        let comment = cx.new(|cx| TextareaState::new(window, cx).auto_grow(2, 8));
        let mut subscriptions = Vec::new();
        for field in [
            &search,
            &title,
            &label_name,
            &label_color,
            &label_description,
        ] {
            subscriptions.push(cx.observe(field, |_, _, cx| cx.notify()));
        }
        for field in [&body, &comment] {
            subscriptions.push(cx.observe(field, |_, _, cx| cx.notify()));
        }
        let mut view = Self {
            client,
            project_id,
            issues: vec![],
            issue: None,
            comments: vec![],
            labels: vec![],
            filter: IssueFilter::Open,
            label_filter: None,
            applied_query: String::new(),
            selected_labels: vec![],
            editing_issue: None,
            editing_comment: None,
            manage_labels: false,
            editing_label: None,
            loading: false,
            comments_loading: false,
            labels_loading: false,
            pending: false,
            more_issues: false,
            more_comments: false,
            next_issue_offset: 0,
            next_comment_offset: 0,
            list_generation: 0,
            issue_generation: 0,
            labels_generation: 0,
            error: None,
            access: super::social_model::Access {
                role: Some(p::ProjectRole::Admin),
            },
            user_id: None,
            inputs: Inputs {
                search,
                title,
                body,
                comment,
                label_name,
                label_color,
                label_description,
            },
            _subscriptions: subscriptions,
        };
        view.refresh(cx);
        view
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.load_labels(cx);
        self.load_issues(false, cx);
        if let Some(issue) = &self.issue {
            self.reload_issue(issue.number, cx);
        }
    }

    fn load_labels(&mut self, cx: &mut Context<Self>) {
        self.labels_generation += 1;
        let generation = self.labels_generation;
        self.labels_loading = true;
        let request = self
            .client
            .call::<api::ListRepositoryLabels>(p::ListRepositoryLabelsIn {
                project_id: self.project_id.clone(),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.labels_generation != generation {
                    return;
                }
                this.labels_loading = false;
                match result {
                    Ok(labels) => this.labels = labels,
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn load_issues(&mut self, more: bool, cx: &mut Context<Self>) {
        if more && (self.loading || !self.more_issues) {
            return;
        }
        self.list_generation += 1;
        let generation = self.list_generation;
        let offset = if more { self.next_issue_offset } else { 0 };
        self.loading = true;
        self.error = None;
        if !more {
            self.applied_query = self.inputs.search.read(cx).value().trim().to_string();
            self.more_issues = false;
            self.next_issue_offset = 0;
        }
        let query = self.applied_query.clone();
        let state = match self.filter {
            IssueFilter::Open => p::ListRepositoryIssuesInState::Open,
            IssueFilter::Closed => p::ListRepositoryIssuesInState::Closed,
            IssueFilter::All => p::ListRepositoryIssuesInState::All,
        };
        let request = self
            .client
            .call::<api::ListRepositoryIssues>(p::ListRepositoryIssuesIn {
                project_id: self.project_id.clone(),
                state: Some(state),
                query: (!query.is_empty()).then_some(query),
                label_id: self.label_filter.clone(),
                offset: Some(offset as f64),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.list_generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(issues) => {
                        this.more_issues = issues.len() == 50;
                        this.next_issue_offset = offset + issues.len();
                        if more {
                            this.issues.extend(issues);
                        } else {
                            this.issues = issues;
                        }
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn open_issue(&mut self, number: f64, window: &mut Window, cx: &mut Context<Self>) {
        self.editing_issue = None;
        self.editing_comment = None;
        self.inputs
            .comment
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.reload_issue(number, cx);
    }

    fn reload_issue(&mut self, number: f64, cx: &mut Context<Self>) {
        self.issue_generation += 1;
        let generation = self.issue_generation;
        self.loading = true;
        self.error = None;
        self.comments.clear();
        self.comments_loading = false;
        let request = self
            .client
            .call::<api::GetRepositoryIssue>(p::GetRepositoryIssueIn {
                project_id: self.project_id.clone(),
                number,
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.issue_generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(issue) => {
                        this.issue = Some(issue);
                        this.load_comments(false, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn load_comments(&mut self, more: bool, cx: &mut Context<Self>) {
        if more && (self.comments_loading || !self.more_comments) {
            return;
        }
        let Some(issue) = &self.issue else {
            return;
        };
        let generation = self.issue_generation;
        let offset = if more { self.next_comment_offset } else { 0 };
        if !more {
            self.more_comments = false;
            self.next_comment_offset = 0;
        }
        self.comments_loading = true;
        let request = self.client.call::<api::ListRepositoryIssueComments>(
            p::ListRepositoryIssueCommentsIn {
                project_id: self.project_id.clone(),
                number: issue.number,
                offset: Some(offset as f64),
            },
        );
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.issue_generation != generation {
                    return;
                }
                this.comments_loading = false;
                match result {
                    Ok(comments) => {
                        this.more_comments = comments.len() == 50;
                        this.next_comment_offset = offset + comments.len();
                        if !more {
                            this.comments.clear();
                        }
                        for comment in comments {
                            if !this.comments.iter().any(|current| current.id == comment.id) {
                                this.comments.push(comment);
                            }
                        }
                        this.comments.sort_by(|a, b| {
                            a.created_at
                                .total_cmp(&b.created_at)
                                .then_with(|| a.id.cmp(&b.id))
                        });
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn edit_issue(&mut self, existing: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.editing_issue = Some(existing);
        self.error = None;
        let issue = existing.then_some(self.issue.as_ref()).flatten();
        let title = issue.map_or(String::new(), |issue| issue.title.to_string());
        let body = issue.map_or(String::new(), |issue| issue.body.to_string());
        self.selected_labels = issue.map_or(vec![], |issue| {
            issue.labels.iter().map(|label| label.id.clone()).collect()
        });
        self.inputs
            .title
            .update(cx, |input, cx| input.set_value(title, window, cx));
        self.inputs
            .body
            .update(cx, |input, cx| input.set_value(body, window, cx));
        cx.notify();
    }

    fn save_issue(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(existing) = self.editing_issue else {
            return;
        };
        let title = self.inputs.title.read(cx).value().trim().to_string();
        let body = self.inputs.body.read(cx).value().to_string();
        if title.is_empty() || self.selected_labels.len() > 25 {
            return;
        }
        let request: Request<p::RepositoryIssue> =
            if existing {
                let Some(issue) = &self.issue else {
                    return;
                };
                let Ok(title) = title.try_into() else {
                    return;
                };
                Box::pin(self.client.call::<api::UpdateRepositoryIssue>(
                    p::UpdateRepositoryIssueIn {
                        project_id: self.project_id.clone(),
                        number: issue.number,
                        title: Some(title),
                        body: Some(body),
                        state: None,
                        label_ids: Some(self.selected_labels.clone()),
                    },
                ))
            } else {
                let Ok(title) = title.try_into() else {
                    return;
                };
                Box::pin(self.client.call::<api::CreateRepositoryIssue>(
                    p::CreateRepositoryIssueIn {
                        project_id: self.project_id.clone(),
                        title,
                        body: Some(body),
                        label_ids: Some(self.selected_labels.clone()),
                    },
                ))
            };
        self.pending = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(issue) => {
                        this.issue = Some(issue);
                        this.editing_issue = None;
                        this.load_issues(false, cx);
                        this.load_comments(false, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn toggle_state(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(issue) = &self.issue else {
            return;
        };
        let state = if issue.state == p::IssueState::Open {
            p::IssueState::Closed
        } else {
            p::IssueState::Open
        };
        let request = self
            .client
            .call::<api::UpdateRepositoryIssue>(p::UpdateRepositoryIssueIn {
                project_id: self.project_id.clone(),
                number: issue.number,
                title: None,
                body: None,
                state: Some(state),
                label_ids: None,
            });
        self.pending = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(issue) => {
                        this.issue = Some(issue);
                        this.load_issues(false, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn edit_comment(
        &mut self,
        comment: p::RepositoryIssueComment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.editing_comment = Some(comment.id);
        self.inputs
            .comment
            .update(cx, |input, cx| input.set_value(comment.body, window, cx));
        cx.notify();
    }

    fn save_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(issue) = &self.issue else {
            return;
        };
        let body = self.inputs.comment.read(cx).value().to_string();
        if body.trim().is_empty() {
            return;
        }
        let editing = self.editing_comment.clone();
        let request: Request<p::RepositoryIssueComment> = if let Some(comment_id) = editing.clone()
        {
            let Ok(body) = body.try_into() else {
                return;
            };
            Box::pin(self.client.call::<api::UpdateRepositoryIssueComment>(
                p::UpdateRepositoryIssueCommentIn {
                    project_id: self.project_id.clone(),
                    number: issue.number,
                    comment_id,
                    body,
                },
            ))
        } else {
            let Ok(body) = body.try_into() else {
                return;
            };
            Box::pin(self.client.call::<api::CreateRepositoryIssueComment>(
                p::CreateRepositoryIssueCommentIn {
                    project_id: self.project_id.clone(),
                    number: issue.number,
                    body,
                },
            ))
        };
        self.pending = true;
        self.error = None;
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(comment) => {
                        if let Some(current) = this
                            .comments
                            .iter_mut()
                            .find(|current| current.id == comment.id)
                        {
                            *current = comment;
                        } else {
                            this.comments.push(comment);
                        }
                        this.comments.sort_by(|a, b| {
                            a.created_at
                                .total_cmp(&b.created_at)
                                .then_with(|| a.id.cmp(&b.id))
                        });
                        if editing.is_none() {
                            if let Some(issue) = &mut this.issue {
                                issue.comment_count += 1.;
                            }
                            if !this.more_comments {
                                this.next_comment_offset += 1;
                            }
                        }
                        this.editing_comment = None;
                        this.inputs
                            .comment
                            .update(cx, |input, cx| input.set_value("", window, cx));
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn confirm_delete_comment(&mut self, comment_id: String, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(issue) = &self.issue else {
            return;
        };
        let request = self.client.call::<api::DeleteRepositoryIssueComment>(
            p::DeleteRepositoryIssueCommentIn {
                project_id: self.project_id.clone(),
                number: issue.number,
                comment_id: comment_id.clone(),
            },
        );
        self.pending = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        this.comments.retain(|comment| comment.id != comment_id);
                        if this.editing_comment.as_ref() == Some(&comment_id) {
                            this.editing_comment = None;
                        }
                        if let Some(issue) = &mut this.issue {
                            issue.comment_count = (issue.comment_count - 1.).max(0.);
                        }
                        this.load_comments(false, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn delete_comment(&mut self, comment_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let weak = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let weak = weak.clone();
            let id = comment_id.clone();
            alert
                .title("Delete this comment?")
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, _, cx| {
                    let _ = weak.update(cx, |this, cx| this.confirm_delete_comment(id.clone(), cx));
                    true
                })
        });
    }

    fn edit_label(
        &mut self,
        label: Option<p::RepositoryLabel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.editing_label = Some(label.as_ref().map(|label| label.id.clone()));
        for (input, value) in [
            (
                &self.inputs.label_name,
                label
                    .as_ref()
                    .map_or(String::new(), |label| label.name.to_string()),
            ),
            (
                &self.inputs.label_color,
                label
                    .as_ref()
                    .map_or("0969da".into(), |label| label.color.to_string()),
            ),
            (
                &self.inputs.label_description,
                label
                    .as_ref()
                    .map_or(String::new(), |label| label.description.to_string()),
            ),
        ] {
            input.update(cx, |input, cx| input.set_value(value, window, cx));
        }
        cx.notify();
    }

    fn save_label(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(editing) = self.editing_label.clone() else {
            return;
        };
        let name = self.inputs.label_name.read(cx).value().trim().to_string();
        let color = self
            .inputs
            .label_color
            .read(cx)
            .value()
            .trim()
            .trim_start_matches('#')
            .to_ascii_lowercase();
        let description = self.inputs.label_description.read(cx).value().to_string();
        if name.is_empty() || color.len() != 6 || !color.chars().all(|c| c.is_ascii_hexdigit()) {
            self.error = Some("Enter a label name and six hexadecimal color digits.".into());
            cx.notify();
            return;
        }
        let request: Request<p::RepositoryLabel> =
            if let Some(label_id) = editing {
                let Ok(name) = name.try_into() else {
                    return;
                };
                Box::pin(self.client.call::<api::UpdateRepositoryLabel>(
                    p::UpdateRepositoryLabelIn {
                        project_id: self.project_id.clone(),
                        label_id,
                        name: Some(name),
                        color: Some(color),
                        description: Some(description),
                    },
                ))
            } else {
                let Ok(name) = name.try_into() else {
                    return;
                };
                Box::pin(self.client.call::<api::CreateRepositoryLabel>(
                    p::CreateRepositoryLabelIn {
                        project_id: self.project_id.clone(),
                        name,
                        color,
                        description: Some(description),
                    },
                ))
            };
        self.pending = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(label) => {
                        if let Some(current) = this
                            .labels
                            .iter_mut()
                            .find(|current| current.id == label.id)
                        {
                            *current = label.clone();
                        } else {
                            this.labels.push(label.clone());
                        }
                        for issue in this.issues.iter_mut().chain(this.issue.iter_mut()) {
                            if let Some(current) = issue
                                .labels
                                .iter_mut()
                                .find(|current| current.id == label.id)
                            {
                                *current = label.clone();
                            }
                        }
                        this.editing_label = None;
                        this.load_labels(cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn confirm_delete_label(&mut self, label_id: String, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let request = self
            .client
            .call::<api::DeleteRepositoryLabel>(p::DeleteRepositoryLabelIn {
                project_id: self.project_id.clone(),
                label_id: label_id.clone(),
            });
        self.pending = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        this.labels.retain(|label| label.id != label_id);
                        if this.editing_label.as_ref().and_then(|id| id.as_ref()) == Some(&label_id)
                        {
                            this.editing_label = None;
                        }
                        this.selected_labels.retain(|id| id != &label_id);
                        for issue in this.issues.iter_mut().chain(this.issue.iter_mut()) {
                            issue.labels.retain(|label| label.id != label_id);
                        }
                        if this.label_filter.as_ref() == Some(&label_id) {
                            this.label_filter = None;
                        }
                        this.load_issues(false, cx);
                        this.load_labels(cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn delete_label(
        &mut self,
        label: p::RepositoryLabel,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let weak = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let weak = weak.clone();
            let id = label.id.clone();
            alert
                .title(format!(
                    "Delete {}? It will be removed from every issue.",
                    label.name
                ))
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, _, cx| {
                    let _ = weak.update(cx, |this, cx| this.confirm_delete_label(id.clone(), cx));
                    true
                })
        });
    }

    fn render_issue_editor(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .gap_3()
            .child(div().text_lg().child(if self.editing_issue == Some(true) {
                "Edit issue"
            } else {
                "New issue"
            }))
            .child(Input::new(&self.inputs.title))
            .child(Textarea::new(&self.inputs.body))
            .child(div().child("Labels"))
            .child(
                h_flex().flex_wrap().gap_2().children(
                    self.labels
                        .clone()
                        .into_iter()
                        .enumerate()
                        .map(|(index, label)| {
                            let selected = self.selected_labels.contains(&label.id);
                            Button::new(("issue-label-selection", index))
                                .ghost()
                                .label(format!(
                                    "{}{}",
                                    if selected { "✓ " } else { "" },
                                    label.name
                                ))
                                .disabled(
                                    self.pending || (!selected && self.selected_labels.len() >= 25),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if this.selected_labels.contains(&label.id) {
                                        this.selected_labels.retain(|id| id != &label.id);
                                    } else if this.selected_labels.len() < 25 {
                                        this.selected_labels.push(label.id.clone());
                                    }
                                    cx.notify();
                                }))
                        }),
                ),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("save-issue")
                            .primary()
                            .label("Save issue")
                            .disabled(
                                self.pending
                                    || self.inputs.title.read(cx).value().trim().is_empty(),
                            )
                            .on_click(cx.listener(|this, _, _, cx| this.save_issue(cx))),
                    )
                    .child(
                        Button::new("cancel-issue-edit")
                            .ghost()
                            .label("Cancel")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.editing_issue = None;
                                cx.notify();
                            })),
                    ),
            )
            .into_any_element()
    }

    fn render_labels(&self, cx: &mut Context<Self>) -> AnyElement {
        let editor = self.editing_label.is_some().then(|| {
            v_flex()
                .gap_2()
                .child(Input::new(&self.inputs.label_name))
                .child(Input::new(&self.inputs.label_color))
                .child(Input::new(&self.inputs.label_description))
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("save-repository-label")
                                .primary()
                                .label("Save label")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, _, cx| this.save_label(cx))),
                        )
                        .child(
                            Button::new("cancel-label-edit")
                                .ghost()
                                .label("Cancel")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.editing_label = None;
                                    cx.notify();
                                })),
                        ),
                )
        });
        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("back-from-labels")
                            .ghost()
                            .label("Back to issues")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.manage_labels = false;
                                this.editing_label = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("new-repository-label")
                            .primary()
                            .label("New label")
                            .disabled(self.pending)
                            .on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.edit_label(None, window, cx)
                                }),
                            ),
                    ),
            )
            .children(editor)
            .children(self.labels_loading.then(|| div().child("Loading labels…")))
            .children(
                self.labels
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(index, label)| {
                        h_flex()
                            .gap_2()
                            .child(div().flex_1().child(format!(
                                "{} · #{} · {}",
                                label.name, label.color, label.description
                            )))
                            .child(
                                Button::new(("edit-repository-label", index))
                                    .ghost()
                                    .label("Edit")
                                    .disabled(self.pending)
                                    .on_click(cx.listener({
                                        let label = label.clone();
                                        move |this, _, window, cx| {
                                            this.edit_label(Some(label.clone()), window, cx)
                                        }
                                    })),
                            )
                            .child(
                                Button::new(("delete-repository-label", index))
                                    .ghost()
                                    .label("Delete")
                                    .disabled(self.pending)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.delete_label(label.clone(), window, cx)
                                    })),
                            )
                    }),
            )
            .into_any_element()
    }

    fn render_issue(&self, issue: &p::RepositoryIssue, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("back-from-issue")
                            .ghost()
                            .label("Back to issues")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.issue_generation += 1;
                                this.issue = None;
                                this.comments.clear();
                                this.comments_loading = false;
                                this.load_issues(false, cx);
                            })),
                    )
                    .children(self.access.can_write().then(|| {
                        Button::new("edit-repository-issue")
                            .ghost()
                            .label("Edit")
                            .disabled(self.pending)
                            .on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.edit_issue(true, window, cx)
                                }),
                            )
                    }))
                    .children(self.access.can_write().then(|| {
                        Button::new("toggle-repository-issue")
                            .ghost()
                            .label(if issue.state == p::IssueState::Open {
                                "Close issue"
                            } else {
                                "Reopen issue"
                            })
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_state(cx)))
                    })),
            )
            .child(
                div()
                    .text_xl()
                    .child(format!("#{} {}", issue.number, issue.title)),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(color(Token::MutedForeground, cx))
                    .child(format!(
                        "{} · {} comments",
                        issue.state, issue.comment_count
                    )),
            )
            .child(div().child(issue.body.clone()))
            .child(
                h_flex().flex_wrap().gap_2().children(
                    issue
                        .labels
                        .iter()
                        .map(|label| div().text_sm().child(label.name.to_string())),
                ),
            )
            .child(div().text_lg().child("Discussion"))
            .children(
                self.comments_loading
                    .then(|| div().child("Loading comments…")),
            )
            .children(
                self.comments
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(index, comment)| {
                        let editable = self
                            .access
                            .can_edit_comment(&comment.author_id, self.user_id.as_deref());
                        v_flex()
                            .gap_2()
                            .border_b_1()
                            .border_color(color(Token::Border, cx))
                            .pb_3()
                            .child(div().child(comment.body.clone()))
                            .children(editable.then(|| {
                                h_flex()
                                    .gap_2()
                                    .child(
                                        Button::new(("edit-issue-comment", index))
                                            .ghost()
                                            .label("Edit")
                                            .disabled(self.pending)
                                            .on_click(cx.listener({
                                                let comment = comment.clone();
                                                move |this, _, window, cx| {
                                                    this.edit_comment(comment.clone(), window, cx)
                                                }
                                            })),
                                    )
                                    .child(
                                        Button::new(("delete-issue-comment", index))
                                            .ghost()
                                            .label("Delete")
                                            .disabled(self.pending)
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.delete_comment(comment.id.clone(), window, cx)
                                            })),
                                    )
                            }))
                    }),
            )
            .children(self.more_comments.then(|| {
                Button::new("more-issue-comments")
                    .ghost()
                    .label("Load more comments")
                    .disabled(self.comments_loading || self.pending)
                    .on_click(cx.listener(|this, _, _, cx| this.load_comments(true, cx)))
            }))
            .children(
                (self.access.can_write() || self.editing_comment.is_some())
                    .then(|| Textarea::new(&self.inputs.comment)),
            )
            .children(
                (self.access.can_write() || self.editing_comment.is_some()).then(|| {
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("save-issue-comment")
                                .primary()
                                .label(if self.editing_comment.is_some() {
                                    "Save comment"
                                } else {
                                    "Comment"
                                })
                                .disabled(
                                    self.pending
                                        || self.inputs.comment.read(cx).value().trim().is_empty(),
                                )
                                .on_click(
                                    cx.listener(|this, _, window, cx| {
                                        this.save_comment(window, cx)
                                    }),
                                ),
                        )
                        .children(self.editing_comment.as_ref().map(|_| {
                            Button::new("cancel-comment-edit")
                                .ghost()
                                .label("Cancel")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.editing_comment = None;
                                    this.inputs
                                        .comment
                                        .update(cx, |input, cx| input.set_value("", window, cx));
                                    cx.notify();
                                }))
                        }))
                }),
            )
            .into_any_element()
    }

    fn render_list(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .gap_3()
            .children(self.access.can_write().then(|| {
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("new-repository-issue")
                            .primary()
                            .label("New issue")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.edit_issue(false, window, cx)
                            })),
                    )
                    .child(
                        Button::new("manage-repository-labels")
                            .ghost()
                            .label("Labels")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.manage_labels = true;
                                cx.notify();
                            })),
                    )
            }))
            .child(
                h_flex().gap_2().children(
                    [
                        (IssueFilter::Open, "Open"),
                        (IssueFilter::Closed, "Closed"),
                        (IssueFilter::All, "All"),
                    ]
                    .into_iter()
                    .enumerate()
                    .map(|(index, (filter, name))| {
                        Button::new(("issue-state-filter", index))
                            .ghost()
                            .label(format!(
                                "{}{}",
                                if self.filter == filter { "✓ " } else { "" },
                                name
                            ))
                            .disabled(self.pending)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.filter = filter;
                                this.load_issues(false, cx);
                            }))
                    }),
                ),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(Input::new(&self.inputs.search))
                    .child(
                        Button::new("search-repository-issues")
                            .ghost()
                            .label("Search")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| this.load_issues(false, cx))),
                    ),
            )
            .child(
                h_flex().flex_wrap().gap_2().children(
                    self.labels
                        .clone()
                        .into_iter()
                        .enumerate()
                        .map(|(index, label)| {
                            let selected = self.label_filter.as_ref() == Some(&label.id);
                            Button::new(("issue-label-filter", index))
                                .ghost()
                                .label(format!(
                                    "{}{}",
                                    if selected { "✓ " } else { "" },
                                    label.name
                                ))
                                .disabled(self.pending)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.label_filter =
                                        if this.label_filter.as_ref() == Some(&label.id) {
                                            None
                                        } else {
                                            Some(label.id.clone())
                                        };
                                    this.load_issues(false, cx);
                                }))
                        }),
                ),
            )
            .children(self.loading.then(|| div().child("Loading issues…")))
            .children(
                (!self.loading && self.issues.is_empty())
                    .then(|| div().child("No issues match these filters.")),
            )
            .children(
                self.issues
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(index, issue)| {
                        Button::new(("repository-issue", index))
                            .ghost()
                            .label(format!(
                                "#{} {} · {}",
                                issue.number, issue.title, issue.state
                            ))
                            .disabled(self.pending)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_issue(issue.number, window, cx)
                            }))
                    }),
            )
            .children(self.more_issues.then(|| {
                Button::new("more-repository-issues")
                    .ghost()
                    .label("Load more issues")
                    .disabled(self.loading || self.pending)
                    .on_click(cx.listener(|this, _, _, cx| this.load_issues(true, cx)))
            }))
            .into_any_element()
    }
}

impl Render for IssuesView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = if self.loading {
            div().child("Loading issues…").into_any_element()
        } else if self.manage_labels {
            self.render_labels(cx)
        } else if self.editing_issue.is_some() {
            self.render_issue_editor(cx)
        } else if let Some(issue) = &self.issue {
            self.render_issue(issue, cx)
        } else {
            self.render_list(cx)
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
#[path = "issues_tests.rs"]
mod tests;
