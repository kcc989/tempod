use super::diff::{DiffEvent, DiffView};
use super::tokens::{Token, color};
use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::Button;
use gpui_kit::component::input::{
    Editor, EditorState, Input, InputEvent, InputState, Textarea, TextareaState,
};
use gpui_kit::component::list::ListItem;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::tree::{Tree, TreeState};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Window, div, uniform_list,
};
use tempo_client::Client;
use tempo_protocol::{self as p, api};

#[derive(Clone)]
pub enum ReviewEvent {
    Document,
    Comments(Vec<String>),
    CommentDeleted(String),
}
impl EventEmitter<ReviewEvent> for ReviewPanel {}
struct CommentDraft {
    path: String,
    start: Option<u32>,
    end: Option<u32>,
    side: Option<p::ReviewSide>,
}
#[derive(Clone)]
struct Document {
    key: String,
    path: String,
    title: String,
    diff: Option<Entity<DiffView>>,
    file: Option<Entity<EditorState>>,
    stale: bool,
    scope: Option<p::DiffScope>,
}
pub struct ReviewPanel {
    store: Entity<WorkspaceStore>,
    client: Client,
    tab: usize,
    scope: p::DiffScope,
    files: Vec<p::ChangedFile>,
    changes_focus: gpui_kit::FocusHandle,
    pub dirty: bool,
    paths: std::sync::Arc<Vec<String>>,
    fuzzy_matches: Vec<String>,
    fuzzy_loading: bool,
    fuzzy_task: Option<gpui_kit::Task<()>>,
    _query_changed: Subscription,
    tree: Entity<TreeState>,
    checks: Vec<p::CheckRun>,
    pr_title: Option<String>,
    pub diff: Option<Entity<DiffView>>,
    pub file: Option<Entity<EditorState>>,
    pub document_title: Option<String>,
    pub document_open: bool,
    diff_subscriptions: Vec<Subscription>,
    documents: Vec<Document>,
    pub active_document: Option<String>,
    selected: Option<String>,
    generation: u64,
    document_generation: u64,
    document_loading: bool,
    initialized: bool,
    changes_seq: u64,
    workspace_rev: f64,
    loading: bool,
    pending: bool,
    error: Option<String>,
    commit: Entity<InputState>,
    query: Entity<InputState>,
    comment: Entity<TextareaState>,
    draft: Option<CommentDraft>,
    comments: Vec<p::ReviewComment>,
    grouped: bool,
    search: Vec<p::SearchFilesItem>,
    search_mode: bool,
    search_generation: u64,
    _store_changed: Subscription,
}
impl ReviewPanel {
    pub fn new(
        store: Entity<WorkspaceStore>,
        client: Client,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let changed = cx.observe_in(&store, window, |this, _, window, cx| {
            let seq = this.store.read(cx).state.changes_seq;
            let rev = this
                .store
                .read(cx)
                .state
                .workspace
                .as_ref()
                .map(|w| w.rev)
                .unwrap_or(-1.);
            if seq != this.changes_seq
                || rev != this.workspace_rev
                || (!this.initialized && this.store.read(cx).state.ready)
            {
                this.workspace_rev = rev;
                for doc in &mut this.documents {
                    doc.stale = true;
                }
                if this.tab == 2 {
                    this.load_checks(cx);
                }
                this.initialized = true;
                this.changes_seq = seq;
                this.refresh(cx);
                if this.document_open
                    && this.diff.is_some()
                    && let Some(path) = this.selected.clone()
                {
                    this.open_diff(path, window, cx);
                }
            }
            cx.notify();
        });
        let query =
            cx.new(|cx| InputState::new(window, cx).placeholder("File name or search text"));
        let query_changed = cx.subscribe(&query, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.search_mode = false;
                this.search_generation += 1;
                this.match_files(cx);
            }
        });
        let mut this = Self {
            store,
            client,
            tab: 0,
            scope: p::DiffScope::Branch,
            files: vec![],
            changes_focus: cx.focus_handle(),
            dirty: false,
            paths: std::sync::Arc::new(vec![]),
            fuzzy_matches: vec![],
            fuzzy_loading: false,
            fuzzy_task: None,
            _query_changed: query_changed,
            tree: cx.new(|cx| TreeState::new(cx)),
            checks: vec![],
            pr_title: None,
            diff: None,
            file: None,
            document_title: None,
            document_open: false,
            diff_subscriptions: vec![],
            documents: vec![],
            active_document: None,
            selected: None,
            generation: 0,
            document_generation: 0,
            document_loading: false,
            initialized: false,
            changes_seq: 0,
            workspace_rev: -1.,
            loading: false,
            pending: false,
            error: None,
            commit: cx.new(|cx| InputState::new(window, cx).placeholder("Commit message")),
            query,
            comment: cx.new(|cx| TextareaState::new(window, cx).placeholder("Review comment")),
            draft: None,
            comments: vec![],
            grouped: false,
            search: vec![],
            search_mode: false,
            search_generation: 0,
            _store_changed: changed,
        };
        this.refresh(cx);
        this
    }
    fn id(&self, cx: &gpui_kit::App) -> String {
        self.store.read(cx).workspace_id.clone()
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.store.read(cx).state.ready {
            return;
        }
        if let Some(workspace) = &self.store.read(cx).state.workspace
            && workspace.state == p::WorkspaceState::Sleeping
        {
            self.files = workspace
                .changes
                .as_ref()
                .or(self.store.read(cx).state.changes.as_ref())
                .map(|s| s.files.clone())
                .unwrap_or_default();
            self.loading = false;
            cx.notify();
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        let id = self.id(cx);
        self.loading = true;
        self.error = None;
        let changes = self.client.call::<api::GetChanges>(p::GetChangesIn {
            workspace_id: id.clone(),
            scope: self.scope,
        });
        let dirty = if self.scope == p::DiffScope::Branch {
            Some(self.client.call::<api::GetChanges>(p::GetChangesIn {
                workspace_id: id.clone(),
                scope: p::DiffScope::Uncommitted,
            }))
        } else {
            None
        };
        let comments = self
            .client
            .call::<api::ListReviewComments>(p::ListReviewCommentsIn { workspace_id: id });
        cx.spawn(async move |this, cx| {
            let result = changes.await;
            let dirty = if let Some(request) = dirty {
                request.await.ok().map(|out| !out.files.is_empty())
            } else {
                result.as_ref().ok().map(|out| !out.files.is_empty())
            };
            let comments = comments.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.loading = false;
                if let Some(dirty) = dirty {
                    this.dirty = dirty;
                }
                match result {
                    Ok(out) => {
                        this.files = out.files;
                        if this.grouped {
                            this.files.sort_by(|a, b| a.path.cmp(&b.path));
                        }
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                if let Ok(comments) = comments {
                    this.comments = comments;
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub fn toggle_scope(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.scope = if self.scope == p::DiffScope::Branch {
            p::DiffScope::Uncommitted
        } else {
            p::DiffScope::Branch
        };
        self.refresh(cx);
        if self.document_open
            && self.diff.is_some()
            && let Some(path) = self.selected.clone()
        {
            self.open_diff(path, window, cx);
        }
    }
    pub fn navigate(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.files.is_empty() {
            return;
        }
        let ix = self
            .selected
            .as_ref()
            .and_then(|p| self.files.iter().position(|f| &f.path == p));
        let next = match ix {
            Some(ix) if forward => (ix + 1) % self.files.len(),
            Some(ix) => (ix + self.files.len() - 1) % self.files.len(),
            None if forward => 0,
            None => self.files.len() - 1,
        };
        self.open_diff(self.files[next].path.clone(), window, cx);
    }
    pub fn open_diff(&mut self, path: String, window: &mut Window, cx: &mut Context<Self>) {
        self.active_document = Some(format!("diff:{}:{path}", self.scope));
        self.selected = Some(path.clone());
        self.file = None;
        self.document_open = true;
        self.document_title = Some(path.clone());
        self.document_generation += 1;
        let generation = self.document_generation;
        self.document_loading = true;
        self.diff = None;
        let id = self.id(cx);
        let request = self.client.call::<api::GetFileDiff>(p::GetFileDiffIn {
            workspace_id: id.clone(),
            scope: self.scope,
            path: path.clone(),
        });
        cx.emit(ReviewEvent::Document);
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let parsed = match result {
                Ok(out) => Ok(cx
                    .background_executor()
                    .spawn(async move { super::diff_model::parse(&out.diff) })
                    .await),
                Err(e) => Err(e.to_string()),
            };
            let _ = this.update_in(cx, |this, window, cx| {
                if generation != this.document_generation {
                    return;
                }
                this.document_loading = false;
                match parsed {
                    Ok(parsed) => {
                        let diff = cx.new(|cx| DiffView::new(id, path, parsed, cx));
                        this.diff_subscriptions.push(cx.subscribe_in(
                            &diff,
                            window,
                            |this, diff, event: &DiffEvent, window, cx| {
                                match event {
                                    DiffEvent::Comment { start, end, side } => {
                                        this.draft = Some(CommentDraft {
                                            path: diff.read(cx).path.clone(),
                                            start: *start,
                                            end: *end,
                                            side: *side,
                                        })
                                    }
                                    DiffEvent::OpenFile => {
                                        if let Some(path) = this.selected.clone() {
                                            this.open_file(path, window, cx);
                                        }
                                    }
                                    DiffEvent::Close => this.close_document(cx),
                                }
                                cx.notify();
                            },
                        ));
                        this.diff = Some(diff);
                        this.cache_document();
                    }
                    Err(e) => this.error = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub fn open_file(&mut self, path: String, window: &mut Window, cx: &mut Context<Self>) {
        self.open_file_at(path, 0, window, cx);
    }
    pub fn open_file_at(
        &mut self,
        path: String,
        line: u32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_document = Some(format!("file:{path}"));
        self.selected = Some(path.clone());
        self.document_title = Some(path.clone());
        self.document_open = true;
        self.file = None;
        self.diff = None;
        self.document_generation += 1;
        let generation = self.document_generation;
        self.document_loading = true;
        let request = self.client.call::<api::ReadFile>(p::ReadFileIn {
            workspace_id: self.id(cx),
            path: path.clone(),
        });
        cx.emit(ReviewEvent::Document);
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if generation != this.document_generation {
                    return;
                }
                this.document_loading = false;
                match result {
                    Ok(out) if out.encoding == p::ReadFileOutEncoding::Utf8 => {
                        let file = cx.new(|cx| {
                            EditorState::new(window, cx)
                                .language(language(&path))
                                .default_value(out.content)
                        });
                        if line > 0 {
                            file.update(cx, |f, cx| {
                                f.set_cursor_position(
                                    gpui_kit::component::input::Position::new(line - 1, 0),
                                    window,
                                    cx,
                                )
                            });
                        }
                        this.file = Some(file);
                        this.cache_document();
                    }
                    Ok(_) => this.error = Some("This file is binary.".into()),
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn cache_document(&mut self) {
        if let (Some(key), Some(path)) = (self.active_document.clone(), self.selected.clone()) {
            let doc = Document {
                key: key.clone(),
                title: if self.diff.is_some() {
                    format!("Diff · {path}")
                } else {
                    path.clone()
                },
                path,
                diff: self.diff.clone(),
                file: self.file.clone(),
                stale: false,
                scope: self.diff.as_ref().map(|_| self.scope),
            };
            self.documents.retain(|d| d.key != key);
            self.documents.push(doc);
        }
    }
    pub fn document_tabs(&self) -> Vec<(String, String)> {
        self.documents
            .iter()
            .map(|d| (d.key.clone(), d.title.clone()))
            .collect()
    }
    pub fn select_document(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(doc) = self.documents.iter().find(|d| d.key == key).cloned() {
            if doc.stale {
                if let Some(scope) = doc.scope {
                    self.scope = scope;
                    self.open_diff(doc.path, window, cx);
                } else {
                    self.open_file(doc.path, window, cx);
                }
                return;
            }
            self.document_generation += 1;
            self.document_loading = false;
            self.document_open = true;
            if let Some(scope) = doc.scope {
                self.scope = scope;
            }
            self.selected = Some(doc.path);
            self.document_title = Some(doc.title);
            self.diff = doc.diff;
            self.file = doc.file;
            self.active_document = Some(doc.key);
            cx.notify();
        }
    }
    pub fn close_document_key(&mut self, key: &str, cx: &mut Context<Self>) {
        if self.active_document.as_deref() == Some(key) {
            self.close_document(cx);
        } else {
            self.documents.retain(|d| d.key != key);
            cx.notify();
        }
    }
    pub fn close_document(&mut self, cx: &mut Context<Self>) {
        if let Some(key) = self.active_document.take() {
            self.documents.retain(|d| d.key != key);
        }
        self.document_generation += 1;
        self.document_open = false;
        self.document_loading = false;
        self.diff = None;
        self.file = None;
        cx.notify();
    }
    pub fn document(&self, cx: &gpui_kit::App) -> AnyElement {
        if self.document_loading {
            return super::skeleton_rows(8).into_any_element();
        }
        if let Some(diff) = &self.diff {
            return div().size_full().child(diff.clone()).into_any_element();
        }
        if let Some(file) = &self.file {
            return Editor::new(file)
                .readonly(true)
                .size_full()
                .into_any_element();
        }
        div()
            .p_4()
            .child(
                self.error
                    .clone()
                    .unwrap_or_else(|| "Select a file.".into()),
            )
            .text_color(color(Token::MutedForeground, cx))
            .into_any_element()
    }
    fn match_files(&mut self, cx: &mut Context<Self>) {
        self.fuzzy_task.take();
        let query = self.query.read(cx).value().to_lowercase();
        self.fuzzy_matches.clear();
        if query.is_empty() {
            self.fuzzy_loading = false;
            cx.notify();
            return;
        }
        self.fuzzy_loading = true;
        let paths = self.paths.clone();
        self.fuzzy_task = Some(cx.spawn(async move |this, cx| {
            let worker_query = query.clone();
            let rows = cx
                .background_executor()
                .spawn(async move { super::composer_model::file_matches(&paths, &worker_query) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.query.read(cx).value().to_lowercase() != query {
                    return;
                }
                this.fuzzy_matches = rows;
                this.fuzzy_loading = false;
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn load_paths(&mut self, cx: &mut Context<Self>) {
        if self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .is_some_and(|w| w.state == p::WorkspaceState::Sleeping)
        {
            self.error = Some("Wake to browse files".into());
            cx.notify();
            return;
        }
        let request = self.client.call::<api::ListFiles>(p::ListFilesIn {
            workspace_id: self.id(cx),
        });
        self.loading = true;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let result = match result {
                Ok(out) => Ok(cx
                    .background_executor()
                    .spawn(async move {
                        let mut paths = out.paths;
                        paths.sort();
                        let tree = super::file_tree::FileNode::from_paths(&paths);
                        (paths, tree)
                    })
                    .await),
                Err(e) => Err(e),
            };
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok((paths, tree)) => {
                        this.paths = std::sync::Arc::new(paths);
                        this.search_mode = false;
                        this.search_generation += 1;
                        this.match_files(cx);
                        this.tree
                            .update(cx, |state, cx| state.set_items(tree.items(), cx));
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn load_checks(&mut self, cx: &mut Context<Self>) {
        if let Some((project_id, number)) = self
            .store
            .read(cx)
            .state
            .workspace
            .as_ref()
            .and_then(|w| w.pr_number.map(|number| (w.project_id.clone(), number)))
        {
            let request = self
                .client
                .call::<api::ListOpenPullRequests>(p::ListOpenPullRequestsIn { project_id });
            cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = this.update(cx, |this, cx| {
                    if this
                        .store
                        .read(cx)
                        .state
                        .workspace
                        .as_ref()
                        .and_then(|w| w.pr_number)
                        != Some(number)
                    {
                        return;
                    }
                    if let Ok(prs) = result
                        && let Some(pr) = prs.into_iter().find(|pr| pr.number == number)
                    {
                        this.pr_title = Some(pr.title);
                    }
                    cx.notify();
                });
            })
            .detach();
        }
        let request = self.client.call::<api::ListCheckRuns>(p::ListCheckRunsIn {
            workspace_id: self.id(cx),
        });
        self.loading = true;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(out) => this.checks = out,
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub fn request_commit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.tab = 0;
        self.commit.update(cx, |i, cx| i.focus(window, cx));
        cx.notify();
    }
    pub fn commit(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let message = self.commit.read(cx).value().to_string();
        if message.trim().is_empty() {
            self.error = Some("Enter a commit message.".into());
            cx.notify();
            return;
        }
        self.pending = true;
        let request = self.client.call::<api::CommitAndPush>(p::CommitAndPushIn {
            workspace_id: self.id(cx),
            message,
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if let Err(e) = result {
                    this.error = Some(e.to_string());
                } else {
                    this.refresh(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn add_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(draft) = &self.draft else {
            return;
        };
        let path = draft.path.clone();
        let Ok(body) = self.comment.read(cx).value().to_string().try_into() else {
            return;
        };
        let request = self
            .client
            .call::<api::AddReviewComment>(p::AddReviewCommentIn {
                workspace_id: self.id(cx),
                path,
                body,
                line_start: draft.start.map(f64::from),
                line_end: draft.end.map(f64::from),
                side: draft.side,
            });
        self.pending = true;
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(comment) => {
                        this.comments.push(comment);
                        this.draft = None;
                        this.comment.update(cx, |i, cx| i.set_value("", window, cx));
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub fn mark_sent(&mut self, ids: &[String], cx: &mut Context<Self>) {
        for comment in &mut self.comments {
            if ids.contains(&comment.id) {
                comment.status = p::ReviewStatus::Sent;
            }
        }
        cx.notify();
    }
    fn delete_comment(&mut self, id: String, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.pending = true;
        let request = self
            .client
            .call::<api::DeleteReviewComment>(p::DeleteReviewCommentIn {
                workspace_id: self.id(cx),
                comment_id: id.clone(),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        this.comments.retain(|c| c.id != id);
                        cx.emit(ReviewEvent::CommentDeleted(id));
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn search(&mut self, cx: &mut Context<Self>) {
        let Ok(query) = self.query.read(cx).value().to_string().try_into() else {
            return;
        };
        self.search_mode = true;
        self.search.clear();
        self.search_generation += 1;
        let generation = self.search_generation;
        let request = self.client.call::<api::SearchFiles>(p::SearchFilesIn {
            workspace_id: self.id(cx),
            query,
            regex: Some(false),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(out) => {
                        if this.search_generation == generation {
                            this.search = out;
                        }
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub fn focus_query(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.query.update(cx, |i, cx| i.focus(window, cx));
    }
    pub fn open_picker(&mut self, cx: &mut Context<Self>) {
        self.tab = 1;
        self.load_paths(cx);
        cx.notify();
    }
    pub fn show_checks(&mut self, cx: &mut Context<Self>) {
        self.tab = 2;
        self.load_checks(cx);
        cx.notify();
    }
}
fn language(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "json" => "json",
        "py" => "python",
        "md" => "markdown",
        "toml" => "toml",
        "sh" => "bash",
        "html" => "html",
        "css" => "css",
        _ => "plain",
    }
}
impl Render for ReviewPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.query.read(cx).value().to_lowercase();
        let paths = self.fuzzy_matches.clone();
        let mut changed_rows = vec![];
        if self.grouped {
            let mut groups = std::collections::BTreeMap::<String, Vec<usize>>::new();
            for (ix, file) in self.files.iter().enumerate() {
                groups
                    .entry(
                        file.path
                            .rsplit_once('/')
                            .map(|(dir, _)| dir)
                            .unwrap_or("Root")
                            .into(),
                    )
                    .or_default()
                    .push(ix);
            }
            for (folder, files) in groups {
                changed_rows.push((None, folder));
                changed_rows.extend(files.into_iter().map(|ix| (Some(ix), String::new())));
            }
        } else {
            changed_rows.extend((0..self.files.len()).map(|ix| (Some(ix), String::new())));
        }
        let content = match self.tab {
            0 => v_flex()
                .size_full()
                .child(
                    h_flex()
                        .gap_2()
                        .p_2()
                        .child(
                            Button::new("scope")
                                .label(if self.scope == p::DiffScope::Branch {
                                    "Branch"
                                } else {
                                    "Uncommitted"
                                })
                                .on_click(
                                    cx.listener(|this, _, window, cx| {
                                        this.toggle_scope(window, cx)
                                    }),
                                ),
                        )
                        .child(
                            Button::new("group")
                                .label("Group by folder")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.grouped = !this.grouped;
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new("refresh-changes")
                                .label("Refresh")
                                .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                        ),
                )
                .child(if self.loading {
                    super::skeleton_rows(4).into_any_element()
                } else if self.files.is_empty() {
                    div().p_3().child("No changes.").into_any_element()
                } else {
                    div()
                        .id("changes-list")
                        .role(gpui_kit::Role::List)
                        .aria_label("Changed files")
                        .key_context(crate::keymap::DIFF)
                        .track_focus(&self.changes_focus)
                        .on_mouse_down(
                            gpui_kit::MouseButton::Left,
                            cx.listener(|this, _, window, cx| {
                                window.focus(&this.changes_focus, cx)
                            }),
                        )
                        .flex_1()
                        .min_h_0()
                        .child(
                            uniform_list(
                                "changed-files",
                                changed_rows.len(),
                                cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                                    range
                                        .map(|ix| {
                                            let (file_ix, folder) = &changed_rows[ix];
                                            let Some(file_ix) = file_ix else {
                                                return div()
                                                    .p_2()
                                                    .text_color(color(Token::MutedForeground, cx))
                                                    .child(folder.clone())
                                                    .into_any_element();
                                            };
                                            let f = this.files[*file_ix].clone();
                                            let path = f.path.clone();
                                            div()
                                                .id(SharedString::from(format!(
                                                    "change-{}",
                                                    f.path
                                                )))
                                                .p_2()
                                                .child(format!(
                                                    "{} {}  +{} −{}",
                                                    f.status, f.path, f.additions, f.deletions
                                                ))
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.open_diff(path.clone(), window, cx)
                                                    },
                                                ))
                                                .into_any_element()
                                        })
                                        .collect()
                                }),
                            )
                            .size_full(),
                        )
                        .into_any_element()
                })
                .child(Input::new(&self.commit))
                .child(
                    Button::new("commit-push")
                        .label("Commit and push")
                        .disabled(self.pending)
                        .on_click(cx.listener(|this, _, _, cx| this.commit(cx))),
                )
                .into_any_element(),
            1 => v_flex()
                .size_full()
                .child(Input::new(&self.query))
                .children((!query.is_empty() && paths.is_empty()).then(|| {
                    div().p_2().child(if self.fuzzy_loading {
                        "Searching…"
                    } else {
                        "No files match."
                    })
                }))
                .child(
                    Button::new("search-content")
                        .label("Search files")
                        .on_click(cx.listener(|this, _, _, cx| this.search(cx))),
                )
                .child(if self.search_mode {
                    uniform_list(
                        "search-results",
                        self.search.len(),
                        cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                            range
                                .map(|ix| {
                                    let m = this.search[ix].clone();
                                    div()
                                        .id(("search-match", ix))
                                        .role(gpui_kit::Role::Button)
                                        .aria_label(format!("Open {} at line {}", m.path, m.line))
                                        .p_2()
                                        .child(format!("{}:{} {}", m.path, m.line, m.text))
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.open_file_at(
                                                m.path.clone(),
                                                m.line as u32,
                                                window,
                                                cx,
                                            )
                                        }))
                                        .into_any_element()
                                })
                                .collect()
                        }),
                    )
                    .flex_1()
                    .into_any_element()
                } else if query.is_empty() {
                    let weak = cx.weak_entity();
                    Tree::new(&self.tree, move |ix, entry, _, _, _| {
                        let path = entry.item().id.to_string();
                        let folder = entry.is_folder();
                        let weak = weak.clone();
                        ListItem::new(ix)
                            .child(entry.item().label.clone())
                            .on_click(move |_, window, cx| {
                                if !folder {
                                    let _ = weak
                                        .update(cx, |r, cx| r.open_file(path.clone(), window, cx));
                                }
                            })
                    })
                    .size_full()
                    .into_any_element()
                } else {
                    uniform_list(
                        "all-files",
                        paths.len(),
                        cx.processor(move |_, range: std::ops::Range<usize>, _, cx| {
                            range
                                .map(|ix| {
                                    let path = paths[ix].clone();
                                    div()
                                        .id(SharedString::from(format!("file-{path}")))
                                        .p_2()
                                        .child(path.clone())
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.open_file(path.clone(), window, cx)
                                        }))
                                        .into_any_element()
                                })
                                .collect()
                        }),
                    )
                    .flex_1()
                    .into_any_element()
                })
                .into_any_element(),
            _ => v_flex()
                .p_3()
                .gap_2()
                .children(self.store.read(cx).state.workspace.as_ref().and_then(|w| {
                    w.pr_number.map(|number| {
                        let project = crate::app::AppState::try_global(cx).and_then(|a| {
                            a.read(cx)
                                .hub
                                .read(cx)
                                .projects
                                .iter()
                                .find(|p| p.id == w.project_id)
                                .cloned()
                        });
                        let url = project.map(|p| {
                            format!("https://github.com/{}/{}/pull/{}", p.owner, p.name, number)
                        });
                        Button::new("checks-pr")
                            .label(format!(
                                "PR #{number} · {} · {}",
                                self.pr_title.as_deref().unwrap_or(""),
                                w.pr_state.map(|s| s.to_string()).unwrap_or_default()
                            ))
                            .on_click(move |_, _, cx| {
                                if let Some(url) = &url {
                                    cx.open_url(url);
                                }
                            })
                    })
                }))
                .child(
                    Button::new("refresh-checks")
                        .label("Refresh checks")
                        .on_click(cx.listener(|this, _, _, cx| this.load_checks(cx))),
                )
                .children(self.checks.iter().enumerate().map(|(ix, c)| {
                    let url = c.url.clone();
                    Button::new(("check", ix))
                        .label(format!(
                            "{} · {}",
                            c.name,
                            c.conclusion.as_ref().unwrap_or(&c.status)
                        ))
                        .on_click(move |_, _, cx| cx.open_url(&url))
                }))
                .children(self.checks.is_empty().then(|| div().child("No checks.")))
                .into_any_element(),
        };
        let draft_ids: Vec<_> = self
            .comments
            .iter()
            .filter(|c| c.status == p::ReviewStatus::Draft)
            .map(|c| c.id.clone())
            .collect();
        v_flex()
            .size_full()
            .child(
                TabBar::new("review-tabs")
                    .selected_index(self.tab)
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.tab = *ix;
                        if *ix == 1 {
                            this.load_paths(cx);
                        }
                        if *ix == 2 {
                            this.load_checks(cx);
                        }
                        cx.notify();
                    }))
                    .children(["Changes", "All files", "Checks"].map(|t| Tab::new().label(t))),
            )
            .children(self.error.clone().map(|e| {
                div()
                    .p_2()
                    .text_color(color(Token::Destructive, cx))
                    .child(e)
            }))
            .child(div().flex_1().min_h_0().child(content))
            .children(self.draft.as_ref().map(|_| {
                v_flex()
                    .p_2()
                    .child(Textarea::new(&self.comment))
                    .child(
                        Button::new("save-comment")
                            .label("Add comment")
                            .disabled(self.pending)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.add_comment(window, cx)),
                            ),
                    )
                    .child(
                        Button::new("cancel-comment")
                            .label("Cancel")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.draft = None;
                                cx.notify();
                            })),
                    )
            }))
            .children(
                self.comments
                    .iter()
                    .filter(|c| c.status == p::ReviewStatus::Draft)
                    .map(|comment| {
                        let id = comment.id.clone();
                        h_flex()
                            .p_2()
                            .gap_2()
                            .child(format!("{} · {}", comment.path, comment.body))
                            .child(
                                Button::new(SharedString::from(format!("delete-comment-{id}")))
                                    .label("Delete")
                                    .disabled(self.pending)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.delete_comment(id.clone(), cx)
                                    })),
                            )
                    }),
            )
            .children((!draft_ids.is_empty()).then(|| {
                Button::new("send-comments")
                    .label(format!("Send {} comments to agent", draft_ids.len()))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ReviewEvent::Comments(draft_ids.clone()))
                    }))
            }))
    }
}
