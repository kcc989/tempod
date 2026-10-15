//! Transcript (04, Center; 07, Transcript): `MessageScroller` with one `TextView::markdown` row
//! per message. Agent text is escaped before it reaches `TextView` (`crate::markdown`); each row
//! sits in the transcript's `LocalImageCache` (`crate::image_policy`); link clicks follow
//! `crate::links`. A streamed delta appends to its row and remeasures only that row.
use super::chat_model::{self, RowContent, WorkType};
use super::tokens::{Token, color};
use crate::image_policy::LocalImageCache;
use crate::links::{self, LinkTarget};
use crate::markdown::{escape_raw_html, tool_text};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::collapsible::Collapsible;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::text::{TextView, TextViewStyle};
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    Action, AnyElement, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Image,
    ImageFormat, ImageSource, InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _,
    Render, Role, SharedString, StatefulInteractiveElement as _, Styled as _, StyledImage as _,
    Subscription, Window, div, image_cache, px,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use tempo_client::{AttachmentFile, Client};
use tempo_protocol::{AgentId, ItemContent, ItemStatus, NoticeLevel, TurnStatus};

/// Opens a file tab at a workspace path (07, Links). Handled by the workspace view in M3.
#[derive(Clone, PartialEq, Eq, Debug, Action)]
#[action(namespace = tempo, no_json)]
pub struct OpenWorkspaceFile(pub SharedString);
#[derive(Clone, PartialEq, Eq, Debug, Action)]
#[action(namespace = tempo,no_json)]
pub struct OpenWorkspaceFileAt {
    pub path: SharedString,
    pub line: u32,
}
/// Shows the Changes tab on the right side (04, Edit rows).
#[derive(Clone, PartialEq, Eq, Debug, Default, Action)]
#[action(namespace = tempo, no_json)]
pub struct ShowChanges;

#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptRow {
    pub id: SharedString,
    source: String,
    rendered: SharedString,
    native: Option<RowContent>,
}

impl TranscriptRow {
    pub fn new(id: impl Into<SharedString>, markdown: impl Into<String>) -> Self {
        let source = markdown.into();
        let rendered = escape_raw_html(&source).into_owned().into();
        Self {
            id: id.into(),
            source,
            rendered,
            native: None,
        }
    }

    pub fn from_native(content: RowContent) -> Self {
        let mut row = Self::new(content.id(), "");
        row.native = Some(content);
        row
    }

    pub fn push_delta(&mut self, delta: &str) {
        self.source.push_str(delta);
        self.rendered = escape_raw_html(&self.source).into_owned().into();
    }

    /// The Markdown that reaches `TextView`, with raw HTML escaped.
    pub fn rendered(&self) -> &SharedString {
        &self.rendered
    }
}

#[derive(Clone, Debug)]
pub enum TranscriptEvent {
    OpenSetup,
    ResolveAgentProposal {
        proposal_id: String,
        apply: bool,
    },
    ConfirmIntent {
        intent_id: String,
    },
    CorrectIntent {
        intent_id: String,
        text: tempo_protocol::CorrectIntentInText,
    },
    RequestAgent {
        agent_id: String,
    },
    CancelRun {
        run_id: String,
    },
    SendRun {
        run_id: String,
    },
    OpenRun {
        session_id: String,
    },
    Permission {
        request_id: String,
        option_id: String,
    },
    Retry {
        turn_id: String,
    },
    RevertCheckpoint {
        checkpoint_id: String,
    },
    Revert {
        turn_id: String,
    },
    /// An artifact card was clicked: open the Artifact tab at this version (04).
    OpenArtifact {
        artifact_id: String,
        version: f64,
    },
}

impl EventEmitter<TranscriptEvent> for TranscriptView {}

/// Encoded bytes of transcript thumbnails kept in memory per transcript.
const THUMBNAIL_BUDGET: usize = 32 * 1024 * 1024;

/// Attachment thumbnails by attachment id, in memory only (07, Local storage). Failed and evicted
/// ones show as a name chip and are not fetched again.
#[derive(Default)]
struct Thumbnails {
    images: HashMap<String, Arc<Image>>,
    order: VecDeque<String>,
    bytes: usize,
    pending: HashSet<String>,
    skipped: HashSet<String>,
}

impl Thumbnails {
    fn wants(&self, id: &str) -> bool {
        !self.images.contains_key(id) && !self.pending.contains(id) && !self.skipped.contains(id)
    }

    /// Returns the images evicted to stay within the budget.
    fn insert(&mut self, id: String, image: Arc<Image>) -> Vec<Arc<Image>> {
        self.pending.remove(&id);
        self.bytes += image.bytes().len();
        self.order.push_back(id.clone());
        self.images.insert(id, image);
        let mut evicted = Vec::new();
        while self.bytes > THUMBNAIL_BUDGET && self.order.len() > 1 {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(image) = self.images.remove(&oldest) {
                self.bytes -= image.bytes().len();
                evicted.push(image);
            }
            self.skipped.insert(oldest);
        }
        evicted
    }

    fn fail(&mut self, id: &str) {
        self.pending.remove(id);
        self.skipped.insert(id.to_string());
    }
}

/// An image the attachment route served inline, ready to draw from its bytes.
fn thumbnail_image(file: AttachmentFile) -> Option<Arc<Image>> {
    let format = match file.mime.as_str() {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        _ => return None,
    };
    (!file.bytes.is_empty()).then(|| Arc::new(Image::from_bytes(format, file.bytes)))
}

pub struct TranscriptView {
    pub runs: HashMap<String, tempo_protocol::Run>,
    pub agent_proposals: HashMap<String, tempo_protocol::AgentProposalRecord>,
    rows: Vec<TranscriptRow>,
    scroller: Entity<MessageScrollerState>,
    images: Entity<LocalImageCache>,
    open: HashMap<String, bool>,
    ticker: Option<gpui_kit::Task<()>>,
    inline_images: HashMap<String, Arc<Image>>,
    media_pending: HashSet<String>,
    permission_focus: HashMap<String, FocusHandle>,
    /// Correction fields of intents waiting for the owner, by intent id.
    intent_inputs: HashMap<String, (Entity<TextareaState>, Subscription)>,
    intent_pending: HashSet<String>,
    attachment_source: Option<(Client, String)>,
    thumbnails: Thumbnails,
    pub read_only: bool,
    pub chat_inset: f32,
    /// The chat's agent, for error messages that name it.
    pub agent: Option<AgentId>,
    /// No turn runs and none is queued, so a revert can start (04, Transcript).
    pub can_revert: bool,
}

impl TranscriptView {
    pub fn new(rows: Vec<TranscriptRow>, cx: &mut Context<Self>) -> Self {
        let count = rows.len();
        cx.on_release(|this, cx| {
            for image in this.thumbnails.images.values() {
                ImageSource::Image(image.clone()).remove_asset(cx);
            }
        })
        .detach();
        Self {
            rows,
            runs: HashMap::new(),
            agent_proposals: HashMap::new(),
            scroller: cx.new(|cx| MessageScrollerState::new(count, cx)),
            images: LocalImageCache::new(cx),
            open: HashMap::new(),
            ticker: None,
            inline_images: HashMap::new(),
            media_pending: HashSet::new(),
            permission_focus: HashMap::new(),
            intent_inputs: HashMap::new(),
            intent_pending: HashSet::new(),
            attachment_source: None,
            thumbnails: Thumbnails::default(),
            read_only: false,
            chat_inset: 16.,
            agent: None,
            can_revert: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn has_thumbnail(&self, attachment_id: &str) -> bool {
        self.thumbnails.images.contains_key(attachment_id)
    }

    /// Where attachment thumbnails load from: the owner-only attachment route (02).
    pub fn set_attachment_source(&mut self, client: Client, workspace_id: String) {
        self.attachment_source = Some((client, workspace_id));
    }

    fn load_thumbnails(&mut self, rows: &[TranscriptRow], cx: &mut Context<Self>) {
        let Some((client, workspace_id)) = self.attachment_source.clone() else {
            return;
        };
        for row in rows {
            let Some(RowContent::Item { item, .. }) = &row.native else {
                continue;
            };
            if let ItemContent::Artifact(a) = &item.content {
                self.load_artifact_thumbnail(&client, &workspace_id, a, item.status, &row.id, cx);
                continue;
            }
            let ItemContent::UserMessage(message) = &item.content else {
                continue;
            };
            for attachment in &message.attachments {
                if !chat_model::is_served_inline(&attachment.mime)
                    || !self.thumbnails.wants(&attachment.id)
                {
                    continue;
                }
                self.thumbnails.pending.insert(attachment.id.clone());
                let request = client.get_attachment(&workspace_id, &attachment.id);
                let id = attachment.id.clone();
                let row_id = row.id.clone();
                cx.spawn(async move |this, cx| {
                    let image = request.await.ok().and_then(thumbnail_image);
                    let _ = this.update(cx, |this, cx| {
                        match image {
                            Some(image) => {
                                for old in this.thumbnails.insert(id, image) {
                                    ImageSource::Image(old).remove_asset(cx);
                                }
                            }
                            None => this.thumbnails.fail(&id),
                        }
                        if let Some(ix) = this.rows.iter().position(|r| r.id == row_id) {
                            this.scroller
                                .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                        }
                        cx.notify();
                    });
                })
                .detach();
            }
        }
    }

    /// 04 artifact card: kind `image` shows a thumbnail from the artifact route, decoded (SVG
    /// rasterized) on the background executor.
    fn load_artifact_thumbnail(
        &mut self,
        client: &Client,
        workspace_id: &str,
        a: &tempo_protocol::ArtifactItemContent,
        status: ItemStatus,
        row_id: &SharedString,
        cx: &mut Context<Self>,
    ) {
        let key = artifact_thumbnail_key(a);
        if a.artifact_kind != tempo_protocol::ArtifactKind::Image
            || status != ItemStatus::Completed
            || !self.thumbnails.wants(&key)
        {
            return;
        }
        self.thumbnails.pending.insert(key.clone());
        let request = client.get_artifact(workspace_id, &a.artifact_id, a.version as u32);
        let row_id = row_id.clone();
        cx.spawn(async move |this, cx| {
            let file = request.await.ok();
            let image = match file {
                Some(file) => {
                    cx.background_executor()
                        .spawn(async move {
                            super::artifacts_model::decode_image(&file.mime, file.bytes)
                        })
                        .await
                }
                None => None,
            };
            let _ = this.update(cx, |this, cx| {
                match image {
                    Some(image) => {
                        for old in this.thumbnails.insert(key, image) {
                            ImageSource::Image(old).remove_asset(cx);
                        }
                    }
                    None => this.thumbnails.fail(&key),
                }
                if let Some(ix) = this.rows.iter().position(|r| r.id == row_id) {
                    this.scroller
                        .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn sync(&mut self, rows: Vec<TranscriptRow>, cx: &mut Context<Self>) {
        self.load_thumbnails(&rows, cx);
        for row in &rows {
            if let Some(RowContent::Item { item, .. }) = &row.native
                && let ItemContent::Permission(p) = &item.content
            {
                self.permission_focus
                    .entry(p.request_id.clone())
                    .or_insert_with(|| cx.focus_handle());
            }
        }
        let tools: Vec<_> = rows
            .iter()
            .flat_map(|row| row_items(row.native.as_ref()))
            .filter_map(|item| match &item.content {
                ItemContent::ToolCall(tool) => Some((item.id.clone(), tool.clone())),
                _ => None,
            })
            .collect();
        for (item_id, tool) in tools {
            for (index, block) in tool.content.iter().enumerate() {
                let key = format!("{item_id}:block:{index}");
                if self.inline_images.contains_key(&key) || self.media_pending.contains(&key) {
                    continue;
                }
                let block = serde_json::to_value(block).unwrap_or_default();
                let inner = if block["type"] == "content" {
                    &block["content"]
                } else {
                    &block
                };
                if inner["type"] != "image" {
                    continue;
                }
                self.media_pending.insert(key.clone());
                let item_id = item_id.clone();
                cx.spawn(async move |this, cx| {
                    let image = cx
                        .background_executor()
                        .spawn(async move { crate::inline_media::image(&block) })
                        .await;
                    let _ = this.update(cx, |this, cx| {
                        if let Some(image) = image {
                            this.inline_images.insert(key, image);
                        }
                        if let Some(ix) = this
                            .rows
                            .iter()
                            .position(|r| row_items(r.native.as_ref()).any(|i| i.id == item_id))
                        {
                            this.scroller
                                .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                        }
                        cx.notify();
                    });
                })
                .detach();
            }
        }
        let common = self
            .rows
            .iter()
            .zip(&rows)
            .take_while(|(a, b)| a.id == b.id)
            .count();
        if common < self.rows.len() || common < rows.len() {
            self.scroller.update(cx, |scroller, cx| {
                scroller.splice(common..self.rows.len(), rows.len() - common, cx);
            });
        }
        for (ix, row) in rows.iter().enumerate().take(common) {
            if self.rows[ix] != *row {
                self.scroller.update(cx, |scroller, cx| {
                    scroller.remeasure_items(ix..ix + 1, cx);
                });
            }
        }
        self.rows = rows;
        let running = self.rows.iter().any(|row| {
            matches!(&row.native, Some(RowContent::Work { turn, .. }) if turn.status == TurnStatus::Running)
        });
        if !running {
            self.ticker = None;
        } else if self.ticker.is_none() {
            self.ticker = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor()
                        .timer(std::time::Duration::from_secs(1))
                        .await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            }));
        }
        cx.notify();
    }

    fn is_open(&self, key: &str, default: bool) -> bool {
        self.open.get(key).copied().unwrap_or(default)
    }

    pub fn focus_permission(&self, request_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(focus) = self.permission_focus.get(request_id) {
            if let Some(ix) = self.rows.iter().position(|row| matches!(&row.native,
                Some(RowContent::Item { item, .. }) if matches!(&item.content, ItemContent::Permission(p) if p.request_id == request_id))) {
                self.scroller.update(cx, |scroller, cx| { scroller.scroll_to_item(ix, cx); });
            }
            window.focus(focus, cx);
        }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    fn intent_row(&self, intent_id: &str) -> Option<usize> {
        self.rows.iter().position(|row| matches!(&row.native,
            Some(RowContent::Item { item, .. }) if matches!(&item.content, ItemContent::Intent(i) if i.intent_id == intent_id)))
    }

    /// Keeps one correction field per intent the owner can still confirm or correct.
    pub(crate) fn sync_intent_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open: HashSet<String> = if self.read_only {
            HashSet::new()
        } else {
            self.rows
                .iter()
                .filter_map(|row| match &row.native {
                    Some(RowContent::Item { item, .. }) => match &item.content {
                        ItemContent::Intent(i)
                            if i.status == tempo_protocol::IntentContentStatus::Proposed =>
                        {
                            Some(i.intent_id.clone())
                        }
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        };
        self.intent_inputs.retain(|id, _| open.contains(id));
        self.intent_pending.retain(|id| open.contains(id));
        for id in open {
            if self.intent_inputs.contains_key(&id) {
                continue;
            }
            let input = cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(2, 8)
                    .placeholder("Correct the intent (optional)")
            });
            let intent_id = id.clone();
            let subscription = cx.observe(&input, move |this, _, cx| {
                if let Some(ix) = this.intent_row(&intent_id) {
                    this.scroller
                        .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                }
                cx.notify();
            });
            self.intent_inputs.insert(id, (input, subscription));
        }
    }

    pub(crate) fn intent_correction(&self, intent_id: &str, cx: &gpui_kit::App) -> String {
        self.intent_inputs
            .get(intent_id)
            .map(|(input, _)| input.read(cx).value().trim().to_string())
            .unwrap_or_default()
    }

    fn confirm_intent(&mut self, intent_id: &str, cx: &mut Context<Self>) {
        if self.read_only || !self.intent_inputs.contains_key(intent_id) {
            return;
        }
        if self.intent_pending.insert(intent_id.to_string()) {
            cx.emit(TranscriptEvent::ConfirmIntent {
                intent_id: intent_id.to_string(),
            });
            cx.notify();
        }
    }

    fn correct_intent(&mut self, intent_id: &str, cx: &mut Context<Self>) {
        let Ok(text) = self.intent_correction(intent_id, cx).parse() else {
            return;
        };
        if self.read_only || self.intent_pending.contains(intent_id) {
            return;
        }
        self.intent_pending.insert(intent_id.to_string());
        cx.emit(TranscriptEvent::CorrectIntent {
            intent_id: intent_id.to_string(),
            text,
        });
        cx.notify();
    }

    /// ⌘↩ sends the correction when there is one, else confirms (13, L-ADR-1).
    pub(crate) fn submit_intent(&mut self, intent_id: &str, cx: &mut Context<Self>) {
        if self.intent_correction(intent_id, cx).is_empty() {
            self.confirm_intent(intent_id, cx);
        } else {
            self.correct_intent(intent_id, cx);
        }
    }

    #[cfg(test)]
    pub(crate) fn intent_input(&self, intent_id: &str) -> Option<Entity<TextareaState>> {
        self.intent_inputs
            .get(intent_id)
            .map(|(input, _)| input.clone())
    }

    #[cfg(test)]
    pub(crate) fn intent_busy(&self, intent_id: &str) -> bool {
        self.intent_pending.contains(intent_id)
    }

    /// A sent correction clears its field; a failed call keeps it for another try.
    pub fn intent_finished(
        &mut self,
        intent_id: &str,
        corrected: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.intent_pending.remove(intent_id);
        if corrected && let Some((input, _)) = self.intent_inputs.get(intent_id) {
            input.update(cx, |input, cx| input.set_value("", window, cx));
        }
        cx.notify();
    }

    /// ⌃O: expands or collapses every work row and every tool call (04, Work row).
    pub fn toggle_tools(&mut self, cx: &mut Context<Self>) {
        let mut keys = Vec::new();
        for row in &self.rows {
            if let Some(RowContent::Work { turn, .. }) = &row.native {
                keys.push((work_key(turn), turn.status == TurnStatus::Running));
            }
            for item in row_items(row.native.as_ref()) {
                if matches!(item.content, ItemContent::ToolCall(_)) {
                    keys.push((item.id.clone(), item.status == ItemStatus::Failed));
                }
            }
        }
        let collapse = !keys.is_empty() && keys.iter().all(|(k, d)| self.is_open(k, *d));
        for (key, _) in keys {
            self.open.insert(key, !collapse);
        }
        self.scroller.update(cx, |s, cx| s.remeasure(cx));
        cx.notify();
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn push_row(&mut self, row: TranscriptRow, cx: &mut Context<Self>) {
        self.rows.push(row);
        self.scroller.update(cx, |s, cx| s.append(1, cx));
        cx.notify();
    }

    /// `item.delta` (02): append to one row and remeasure only that row.
    pub fn append_delta(&mut self, ix: usize, delta: &str, cx: &mut Context<Self>) {
        let Some(row) = self.rows.get_mut(ix) else {
            return;
        };
        row.push_delta(delta);
        self.scroller
            .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
        cx.notify();
    }
}

impl Render for TranscriptView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_intent_inputs(window, cx);
        let view = cx.weak_entity();
        let images = self.images.clone();
        let background = color(Token::Background, cx);
        let inset = (self.chat_inset - 4.).max(0.);
        let row_style = div().px_0().style().clone();
        MessageScroller::new("transcript", self.scroller.clone(), move |ix, _, cx| {
            let row = view
                .upgrade()
                .and_then(|v| v.read(cx).rows.get(ix).cloned());
            // GPUI lays out list rows during prepaint, where an outer `image_cache` element is not
            // on the stack; wrapping each row puts the cache in scope for its images.
            div().w_full().flex().justify_start().child(
                image_cache(images.clone())
                    .w_full()
                    .max_w(px(820.))
                    .mx_auto()
                    .px(px(inset))
                    .min_w_0()
                    .children(row.map(|row| {
                        if row.native.is_some() {
                            render_native_row(row, ix, view.clone(), cx)
                        } else {
                            render_row(row.id, row.rendered).into_any_element()
                        }
                    })),
            )
        })
        .with_row_style(row_style)
        .with_jump_button_transition(std::time::Duration::ZERO)
        .with_jump_button_renderer(move |button| {
            button.label("Jump to latest").bg(background).shadow_md()
        })
        .size_full()
    }
}

fn work_key(turn: &tempo_protocol::Turn) -> String {
    let phase = if turn.status == TurnStatus::Running {
        "running"
    } else {
        "done"
    };
    format!("work:{}:{phase}", turn.id)
}

fn row_items(row: Option<&RowContent>) -> Box<dyn Iterator<Item = &tempo_protocol::Item> + '_> {
    match row {
        Some(RowContent::Item { item, .. }) => Box::new(std::iter::once(item.as_ref())),
        Some(RowContent::Work { items, .. }) => Box::new(items.iter()),
        _ => Box::new(std::iter::empty()),
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or_default()
}

fn render_row(id: SharedString, text: SharedString) -> impl IntoElement {
    div()
        .id(id.clone())
        .role(Role::Article)
        .w_full()
        .max_w(px(632.))
        .px_4()
        .py_2()
        .child(
            TextView::markdown(id, text)
                .w_full()
                .min_w_0()
                .style(TextViewStyle {
                    heading_font_size: Some(std::sync::Arc::new(|level, _| {
                        px(match level {
                            1 => 20.,
                            2 => 16.,
                            3 => 14.,
                            _ => 13.,
                        })
                    })),
                    ..Default::default()
                })
                .code_block_actions(|block, _, _| {
                    let code = block.code();
                    Button::new("copy-code")
                        .label("Copy")
                        .accessibility_label("Copy code block")
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(
                                code.to_string(),
                            ))
                        })
                })
                .selectable(true)
                .on_link_click(|url, _, window, cx| match links::classify(url) {
                    LinkTarget::Browser(url) => cx.open_url(&url),
                    LinkTarget::FileTab(path) => {
                        if let Some(line) = links::line_number(url) {
                            window.dispatch_action(
                                Box::new(OpenWorkspaceFileAt {
                                    path: path.into(),
                                    line,
                                }),
                                cx,
                            )
                        } else {
                            window.dispatch_action(Box::new(OpenWorkspaceFile(path.into())), cx)
                        }
                    }
                    LinkTarget::Ignore => {}
                }),
        )
}

fn run_card(
    run_id: &str,
    view: gpui_kit::WeakEntity<TranscriptView>,
    cx: &mut gpui_kit::App,
) -> gpui_kit::AnyElement {
    let state = view
        .update(cx, |this, _| {
            (
                this.runs.get(run_id).cloned(),
                this.read_only,
                this.can_revert,
                this.open
                    .get(&format!("dismiss-run:{run_id}"))
                    .copied()
                    .unwrap_or(false),
            )
        })
        .ok();
    let Some((Some(run), read_only, can_revert, dismissed)) = state else {
        return div().child("Loading run…").into_any_element();
    };
    if dismissed {
        return div().into_any_element();
    }
    let active = matches!(
        run.status,
        tempo_protocol::RunStatus::Queued | tempo_protocol::RunStatus::Running
    );
    let id = run.id.clone();
    let mut card = v_flex()
        .p_3()
        .gap_2()
        .border_1()
        .rounded_lg()
        .border_color(color(Token::Border, cx))
        .child(format!("{} · @{} · {}", run.name, run.handle, run.status))
        .child(format!(
            "{} · {} · {} · {} tokens",
            run.hook
                .as_ref()
                .map(|h| h.event.to_string())
                .unwrap_or_else(|| "request".into()),
            run.agent
                .map(|a| a.to_string())
                .unwrap_or_else(|| "waiting".into()),
            run.access,
            run.tokens
        ));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(run.created_at);
    let seconds = run
        .ended_at
        .unwrap_or(now)
        .saturating_sub(run.started_at.unwrap_or(run.created_at))
        / 1000;
    card = card.child(format!("{seconds}s"));
    if let Some(issues) = &run.profile_issues
        && !issues.is_empty()
    {
        card = card.child(format!(
            "Ignored settings: {}",
            issues
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(p) = run.decision_p {
        card = card.child(format!("Decision: {:.0}%", p * 100.));
    }
    if let Some(result) = &run.result {
        card = card.child(format!("{}: {}", result.status, result.summary.as_str()));
        for (index, step) in result.steps.iter().enumerate() {
            card = card.child(format!(
                "{}. {}{}",
                index + 1,
                step.text.as_str(),
                if step.files.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", step.files.join(", "))
                }
            ));
        }
        if let Some(verify) = &result.verify {
            card = card.child(format!("Verify: {}", verify.as_str()));
        }
        for finding in &result.findings {
            card = card.child(format!(
                "{} {}:{} {}",
                if finding.blocking {
                    "Blocking"
                } else {
                    "Finding"
                },
                finding.path,
                finding.line.map(|l| l.to_string()).unwrap_or_default(),
                finding.text
            ));
        }
    }
    if let Some(error) = run.error_code {
        card = card.child(crate::errors::error_message(&error, None));
    }
    if run.warning.is_some() {
        card = card.child("This read-only agent changed files.");
        if let Some(checkpoint_id) = run.pin_checkpoint_id {
            let view = view.clone();
            card = card.child(
                Button::new("run-revert")
                    .label("Revert")
                    .disabled(read_only || !can_revert)
                    .on_click(move |_, _, cx| {
                        let _ = view.update(cx, |_, cx| {
                            cx.emit(TranscriptEvent::RevertCheckpoint {
                                checkpoint_id: checkpoint_id.clone(),
                            })
                        });
                    }),
            );
        }
    }
    if active {
        let view = view.clone();
        let id = id.clone();
        card = card.child(
            Button::new("run-cancel")
                .label("Cancel")
                .disabled(read_only)
                .on_click(move |_, _, cx| {
                    let _ = view.update(cx, |_, cx| {
                        cx.emit(TranscriptEvent::CancelRun { run_id: id.clone() })
                    });
                }),
        );
    }
    if run.status == tempo_protocol::RunStatus::Completed {
        let view = view.clone();
        let id = id.clone();
        card = card.child(
            Button::new("run-send")
                .label(if run.sent_turn_id.is_some() {
                    "Sent to chat"
                } else if run.output_kind == tempo_protocol::OutputKind::Plan {
                    "Approve"
                } else {
                    "Send to chat"
                })
                .disabled(
                    read_only || run.sent_turn_id.is_some() || run.origin_session_id.is_none(),
                )
                .on_click(move |_, _, cx| {
                    let _ = view.update(cx, |_, cx| {
                        cx.emit(TranscriptEvent::SendRun { run_id: id.clone() })
                    });
                }),
        );
    }
    if let Some(session_id) = run.session_id {
        let view = view.clone();
        card = card.child(Button::new("run-open").label("Open transcript").on_click(
            move |_, _, cx| {
                let _ = view.update(cx, |_, cx| {
                    cx.emit(TranscriptEvent::OpenRun {
                        session_id: session_id.clone(),
                    })
                });
            },
        ));
    }
    if !active {
        card = card.child(
            Button::new("run-dismiss")
                .ghost()
                .label("Dismiss")
                .on_click(move |_, _, cx| {
                    let _ = view.update(cx, |this, cx| {
                        this.open.insert(format!("dismiss-run:{id}"), true);
                        cx.notify();
                    });
                }),
        );
    }
    card.into_any_element()
}

fn artifact_thumbnail_key(a: &tempo_protocol::ArtifactItemContent) -> String {
    format!("artifact:{}:{}", a.artifact_id, a.version)
}

/// 04 Transcript, `artifact`: kind, title, `v<n>`, name and size, summary, and an image thumbnail.
/// A click opens the Artifact tab; `pending` shows `Saving`, `failed` the lost text.
fn artifact_card(
    id: &SharedString,
    item: &tempo_protocol::Item,
    a: &tempo_protocol::ArtifactItemContent,
    view: gpui_kit::WeakEntity<TranscriptView>,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    use super::artifacts_model::{LOST_TEXT, SAVING, kind_label, version_label};
    let pending = item.status == ItemStatus::Pending;
    let failed = item.status == ItemStatus::Failed;
    let thumbnail = view.upgrade().and_then(|v| {
        v.read(cx)
            .thumbnails
            .images
            .get(&artifact_thumbnail_key(a))
            .cloned()
    });
    let muted = color(Token::MutedForeground, cx);
    let title = h_flex()
        .gap_2()
        .child(div().text_color(muted).child(kind_label(a.artifact_kind)))
        .child(a.title.clone())
        .children(version_label(a.version).map(|v| div().text_color(muted).child(v)))
        .children(pending.then(|| {
            h_flex()
                .gap_1()
                .text_color(muted)
                .child(Spinner::new())
                .child(SAVING)
        }));
    let mut card = div()
        .id(id.clone())
        .role(Role::Button)
        .aria_label(format!("Artifact: {}", a.title))
        .mx_4()
        .px_3()
        .py_2()
        .rounded_md()
        .border_1()
        .border_color(color(Token::Border, cx))
        .child(
            v_flex()
                .gap_1()
                .child(title)
                .child(div().text_color(muted).child(format!(
                    "{} · {}",
                    a.name,
                    super::format_bytes(a.size)
                )))
                .children(a.summary.clone().map(|s| div().text_color(muted).child(s)))
                .children(failed.then(|| {
                    div()
                        .text_color(color(Token::Destructive, cx))
                        .child(LOST_TEXT)
                }))
                .children(thumbnail.map(|image| {
                    gpui_kit::img(image)
                        .max_h(px(240.))
                        .max_w_full()
                        .object_fit(ObjectFit::Contain)
                        .rounded_sm()
                })),
        );
    if !pending && !failed {
        let artifact_id = a.artifact_id.clone();
        let version = a.version;
        card = card.cursor_pointer().on_click(move |_, _, cx| {
            let _ = view.update(cx, |_, cx| {
                cx.emit(TranscriptEvent::OpenArtifact {
                    artifact_id: artifact_id.clone(),
                    version,
                })
            });
        });
    }
    card.into_any_element()
}

/// 04 Plan proposals: a tool call with `rawInput.plan` shows as a `Plan` card with the plan as
/// Markdown; its permission row follows right under it.
fn plan_card(id: &SharedString, plan: &str, cx: &mut gpui_kit::App) -> AnyElement {
    v_flex()
        .mx_4()
        .px_3()
        .py_2()
        .gap_1()
        .rounded_md()
        .border_1()
        .border_color(color(Token::Border, cx))
        .child(
            div()
                .text_color(color(Token::MutedForeground, cx))
                .child("Plan"),
        )
        .child(markdown(id.clone(), plan))
        .into_any_element()
}

/// 13, L-ADR-1: the agent's goal, approach and non-goals, confirmed or corrected with one action.
fn intent_card(
    id: &SharedString,
    intent: &tempo_protocol::IntentContent,
    view: gpui_kit::WeakEntity<TranscriptView>,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    let muted = color(Token::MutedForeground, cx);
    let proposed = intent.status == tempo_protocol::IntentContentStatus::Proposed;
    let (input, busy) = view
        .upgrade()
        .and_then(|v| {
            let v = v.read(cx);
            v.intent_inputs
                .get(&intent.intent_id)
                .map(|(input, _)| (input.clone(), v.intent_pending.contains(&intent.intent_id)))
        })
        .unzip();
    let field = |label: &'static str, value: &str| {
        h_flex()
            .gap_3()
            .items_start()
            .child(div().w(px(80.)).flex_none().text_color(muted).child(label))
            .child(div().flex_1().min_w_0().child(value.to_string()))
    };
    let mut card = v_flex()
        .id(SharedString::from(format!("{id}:intent")))
        .role(Role::Group)
        .aria_label("Intent")
        .mx_4()
        .p_3()
        .gap_2()
        .rounded_lg()
        .border_1()
        .border_color(color(Token::Border, cx))
        .text_sm()
        .child(
            div()
                .text_xs()
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(muted)
                .child(chat_model::intent_status_text(intent)),
        )
        .child(field("Goal", &intent.goal))
        .child(field("Approach", &intent.approach))
        .child(field("Not doing", &intent.not_doing))
        .when(proposed && !intent.reasons.is_empty(), |card| {
            card.child(div().text_xs().text_color(muted).child(format!(
                "Asking you because: {}",
                chat_model::intent_reason_text(&intent.reasons)
            )))
        })
        .when(!intent.enforced, |card| {
            card.child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("This agent has no read-only mode; it was asked not to change files."),
            )
        });
    if let (true, Some(input), Some(busy)) = (proposed, input, busy) {
        let can_correct = input
            .read(cx)
            .value()
            .trim()
            .parse::<tempo_protocol::CorrectIntentInText>()
            .is_ok();
        let intent_id = intent.intent_id.clone();
        let (confirm_view, confirm_id) = (view.clone(), intent_id.clone());
        let (correct_view, correct_id) = (view.clone(), intent_id.clone());
        card = card
            .child(
                v_flex()
                    .gap_2()
                    .child(Textarea::new(&input).aria_label("Correction"))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new(SharedString::from(format!("{id}:confirm")))
                                    .primary()
                                    .small()
                                    .label("Confirm")
                                    .disabled(busy)
                                    .on_click(move |_, _, cx| {
                                        let _ = confirm_view.update(cx, |this, cx| {
                                            this.confirm_intent(&confirm_id, cx)
                                        });
                                    }),
                            )
                            .child(
                                Button::new(SharedString::from(format!("{id}:correct")))
                                    .outline()
                                    .small()
                                    .label("Send correction")
                                    .disabled(busy || !can_correct)
                                    .on_click(move |_, _, cx| {
                                        let _ = correct_view.update(cx, |this, cx| {
                                            this.correct_intent(&correct_id, cx)
                                        });
                                    }),
                            ),
                    ),
            )
            .capture_key_down(move |event, _, cx| {
                let modifiers = &event.keystroke.modifiers;
                if busy
                    || event.keystroke.key != "enter"
                    || !(modifiers.platform || modifiers.control)
                {
                    return;
                }
                let _ = view.update(cx, |this, cx| this.submit_intent(&intent_id, cx));
                cx.stop_propagation();
            });
    }
    card.into_any_element()
}

pub(crate) fn markdown(id: SharedString, text: &str) -> AnyElement {
    render_row(id, escape_raw_html(text).into_owned().into()).into_any_element()
}

fn render_native_row(
    row: TranscriptRow,
    ix: usize,
    view: gpui_kit::WeakEntity<TranscriptView>,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    let id = row.id.clone();
    let Some(content) = row.native else {
        return markdown(id, &row.source);
    };
    match content {
        RowContent::Startup { title, setup } => h_flex()
            .id("workspace-startup")
            .role(Role::Status)
            .aria_label(title.clone())
            .px_4()
            .py_2()
            .gap_2()
            .text_color(color(Token::MutedForeground, cx))
            .child(Spinner::new().small())
            .child(div().flex_1().min_w_0().child(title))
            .children(setup.then(|| {
                Button::new("transcript-open-setup")
                    .ghost()
                    .small()
                    .label("Open Setup tab")
                    .on_click(move |_, _, cx| {
                        let _ = view.update(cx, |_, cx| cx.emit(TranscriptEvent::OpenSetup));
                    })
            }))
            .into_any_element(),
        RowContent::Working { .. } => div()
            .px_4()
            .py_2()
            .text_color(color(Token::MutedForeground, cx))
            .child("Working…")
            .into_any_element(),
        RowContent::Work { turn, items, dim } => {
            let running = turn.status == TurnStatus::Running;
            let header = if running {
                let elapsed = turn
                    .started_at
                    .map(|start| chat_model::format_duration(now_ms() - start))
                    .unwrap_or_default();
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_2()
                    .child(Spinner::new())
                    .child(div().flex_1().min_w_0().truncate().child(
                        chat_model::current_step(&items).unwrap_or_else(|| "Working".into()),
                    ))
                    .child(
                        div()
                            .text_color(color(Token::MutedForeground, cx))
                            .child(elapsed),
                    )
                    .into_any_element()
            } else {
                let duration = turn
                    .started_at
                    .zip(turn.ended_at)
                    .map(|(start, end)| end - start);
                div()
                    .w_full()
                    .min_w_0()
                    .truncate()
                    .text_color(color(Token::MutedForeground, cx))
                    .child(chat_model::work_summary(&items, duration))
                    .into_any_element()
            };
            let content = v_flex()
                .children(items.into_iter().map(|item| {
                    render_native_row(
                        TranscriptRow::from_native(RowContent::Item {
                            item: Box::new(item),
                            dim: false,
                            revertable: false,
                        }),
                        ix,
                        view.clone(),
                        cx,
                    )
                }))
                .into_any_element();
            let key = work_key(&turn);
            let open = view
                .upgrade()
                .is_some_and(|v| v.read(cx).is_open(&key, running));
            div()
                .w_full()
                .px_4()
                .opacity(if dim { 0.5 } else { 1. })
                .child(
                    Collapsible::new()
                        .open(open)
                        .child(
                            Button::new(SharedString::from(format!("{id}:toggle")))
                                .ghost()
                                .w_full()
                                .px_0()
                                .accessibility_label("Work")
                                .child(header)
                                .on_click(move |_, _, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        let open = this.is_open(&key, running);
                                        this.open.insert(key.clone(), !open);
                                        this.scroller
                                            .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                                        cx.notify();
                                    });
                                }),
                        )
                        .content(content),
                )
                .into_any_element()
        }
        RowContent::Footer { turn, work_row } => {
            let detail = chat_model::turn_usage_detail(&turn).map(SharedString::from);
            div()
                .id(SharedString::from(format!("turn-footer-{id}")))
                .px_4()
                .py_2()
                .opacity(if turn.reverted { 0.5 } else { 1. })
                .text_color(color(Token::MutedForeground, cx))
                .when_some(detail, |this, detail| {
                    this.tooltip(move |window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(detail.clone()).build(window, cx)
                    })
                })
                .child(chat_model::turn_footer(&turn, work_row))
                .into_any_element()
        }
        RowContent::Item {
            item,
            dim,
            revertable,
        } => {
            let body = match &item.content {
                ItemContent::AgentMessage(c) => v_flex()
                    .child(markdown(id.clone(), &c.text))
                    .children((item.status == ItemStatus::Streaming).then(|| {
                        let caret = color(Token::Foreground, cx).opacity(0.6);
                        div().mx_4().w(px(6.)).h(px(14.)).rounded(px(1.)).bg(caret)
                    }))
                    .into_any_element(),
                ItemContent::UserMessage(c) => {
                    user_message(&id, &item, c, revertable, view.clone(), cx)
                }
                ItemContent::AgentThought(c) => disclosure(
                    id.clone(),
                    Disclosure::new("Thinking"),
                    markdown(id.clone(), &c.text),
                    ix,
                    view.clone(),
                    cx,
                ),
                ItemContent::Handoff(c) => disclosure(
                    id.clone(),
                    Disclosure::new("Session restarted; transcript handed to the agent"),
                    markdown(id.clone(), &c.text),
                    ix,
                    view.clone(),
                    cx,
                ),
                ItemContent::ToolCall(c) if chat_model::plan_proposal_text(c).is_some() => {
                    plan_card(
                        &id,
                        &chat_model::plan_proposal_text(c).unwrap_or_default(),
                        cx,
                    )
                }
                ItemContent::Run(c) => run_card(&c.run_id, view.clone(), cx),
                ItemContent::AgentProposal(content) => {
                    let record = view.upgrade().and_then(|v| {
                        v.read(cx)
                            .agent_proposals
                            .get(&content.proposal_id)
                            .cloned()
                    });
                    if let Some(record) = record {
                        let disabled = view.upgrade().is_none_or(|v| v.read(cx).read_only);
                        let mut card = v_flex()
                            .gap_2()
                            .p_3()
                            .border_1()
                            .border_color(color(Token::Border, cx))
                            .child(format!(
                                "Agent changes · {}",
                                serde_json::to_value(record.status)
                                    .unwrap_or_default()
                                    .as_str()
                                    .unwrap_or_default()
                            ))
                            .child(record.proposal.note.clone())
                            .child(div().font_family("monospace").child(
                                serde_json::to_string_pretty(&record.proposal).unwrap_or_default(),
                            ));
                        if record.status == tempo_protocol::AgentProposalRecordStatus::Pending {
                            for (label, apply) in [("Apply", true), ("Reject", false)] {
                                let view = view.clone();
                                let id = record.id.clone();
                                card = card.child(
                                    Button::new(label).label(label).disabled(disabled).on_click(
                                        move |_, _, cx| {
                                            let _ = view.update(cx, |_, cx| {
                                                cx.emit(TranscriptEvent::ResolveAgentProposal {
                                                    proposal_id: id.clone(),
                                                    apply,
                                                })
                                            });
                                        },
                                    ),
                                );
                            }
                        }
                        card.into_any_element()
                    } else {
                        div().child("Loading agent proposal…").into_any_element()
                    }
                }
                ItemContent::Artifact(a) => artifact_card(&id, &item, a, view.clone(), cx),
                ItemContent::Intent(intent) => intent_card(&id, intent, view.clone(), cx),
                ItemContent::Proof(_) => div().mx_4().child("Proof").into_any_element(),
                ItemContent::ToolCall(c) => {
                    let blocks = c.content.iter().enumerate().map(|(index, block)| {
                        let key: SharedString = format!("{}:block:{index}", id).into();
                        if let Some(image) = view
                            .update(cx, |this, _| this.inline_images.get(key.as_ref()).cloned())
                            .ok()
                            .flatten()
                        {
                            return gpui_kit::img(image)
                                .max_w(gpui_kit::px(320.))
                                .max_h(gpui_kit::px(240.))
                                .into_any_element();
                        }
                        let value = serde_json::to_value(block).unwrap_or_default();
                        if value["type"] == "diff" {
                            let path = value["path"].as_str().unwrap_or("");
                            let old = value["oldText"].as_str().unwrap_or("");
                            let new = value["newText"].as_str().unwrap_or("");
                            let lines = old.lines().count() + new.lines().count();
                            if lines > super::diff_model::MAX_DIFF_LINES {
                                return div()
                                    .child("This diff is too large to show.")
                                    .into_any_element();
                            }
                            let text = format!(
                                "--- {path}\n+++ {path}\n{}{}",
                                old.lines().map(|l| format!("-{l}\n")).collect::<String>(),
                                new.lines().map(|l| format!("+{l}\n")).collect::<String>()
                            );
                            return div()
                                .font_family("monospace")
                                .child(text)
                                .into_any_element();
                        }
                        if value["type"] == "terminal" {
                            return div()
                                .font_family("monospace")
                                .child(format!(
                                    "Terminal {}",
                                    value["terminalId"].as_str().unwrap_or("")
                                ))
                                .into_any_element();
                        }
                        let inner = if value["type"] == "content" {
                            &value["content"]
                        } else {
                            &value
                        };
                        markdown(
                            key,
                            &tool_text(
                                inner["text"].as_str().unwrap_or("Inline media"),
                                c.tool_kind.as_deref() == Some("execute"),
                            ),
                        )
                    });
                    let details = v_flex()
                        .children(blocks)
                        .children(c.raw_input.as_ref().map(|v| {
                            div()
                                .font_family("monospace")
                                .child(serde_json::to_string_pretty(v).unwrap_or_default())
                        }))
                        .children(c.raw_output.as_ref().map(|v| {
                            div()
                                .font_family("monospace")
                                .child(serde_json::to_string_pretty(v).unwrap_or_default())
                        }))
                        .children(c.locations.iter().enumerate().map(|(ix, loc)| {
                            let path = links::workspace_path(&loc.path).map(str::to_string);
                            let line = loc
                                .line
                                .filter(|n| n.is_finite() && *n >= 1. && *n <= u32::MAX as f64)
                                .map(|n| n as u32);
                            Button::new(("tool-location", ix))
                                .label(format!(
                                    "{}{}",
                                    loc.path,
                                    line.map(|n| format!(":{n}")).unwrap_or_default()
                                ))
                                .disabled(path.is_none())
                                .on_click(move |_, window, cx| {
                                    if let Some(path) = &path {
                                        if let Some(line) = line {
                                            window.dispatch_action(
                                                Box::new(OpenWorkspaceFileAt {
                                                    path: path.clone().into(),
                                                    line,
                                                }),
                                                cx,
                                            );
                                        } else {
                                            window.dispatch_action(
                                                Box::new(OpenWorkspaceFile(path.clone().into())),
                                                cx,
                                            );
                                        }
                                    }
                                })
                        }));
                    let kind = chat_model::work_type(c);
                    let status = match item.status {
                        ItemStatus::Pending
                        | ItemStatus::InProgress
                        | ItemStatus::Failed
                        | ItemStatus::Cancelled => format!(" · {}", item.status),
                        _ => String::new(),
                    };
                    let (label, mono) = if kind == WorkType::Edit {
                        let counts = chat_model::edit_counts(c);
                        let name = if counts.path.is_empty() {
                            c.title.as_str()
                        } else {
                            counts.file_name()
                        };
                        (
                            format!("{name} +{} −{}", counts.added, counts.removed),
                            false,
                        )
                    } else {
                        chat_model::tool_label(c)
                    };
                    let row = disclosure(
                        id.clone(),
                        Disclosure {
                            title: format!("{} {label}{status}", work_icon(kind)).into(),
                            tooltip: Some(c.title.clone().into()),
                            mono,
                            default_open: item.status == ItemStatus::Failed,
                        },
                        details.into_any_element(),
                        ix,
                        view.clone(),
                        cx,
                    );
                    if kind == WorkType::Edit {
                        v_flex()
                            .child(row)
                            .child(
                                div().px_4().child(
                                    Button::new(SharedString::from(format!("{id}:changes")))
                                        .ghost()
                                        .label("Changes")
                                        .on_click(|_, window, cx| {
                                            window.dispatch_action(Box::new(ShowChanges), cx)
                                        }),
                                ),
                            )
                            .into_any_element()
                    } else {
                        row
                    }
                }
                ItemContent::Plan(c) => v_flex()
                    .px_4()
                    .gap_1()
                    .children(
                        c.entries
                            .iter()
                            .map(|e| div().child(format!("{} · {}", e.status, e.content))),
                    )
                    .into_any_element(),
                ItemContent::Notice(c) => div()
                    .px_4()
                    .py_2()
                    .text_center()
                    .text_color(color(
                        match c.level {
                            NoticeLevel::Info => Token::MutedForeground,
                            NoticeLevel::Warning => Token::Warning,
                            NoticeLevel::Error => Token::Destructive,
                        },
                        cx,
                    ))
                    .child(c.text.clone())
                    .children(c.agent_id.clone().map(|agent_id| {
                        let view = view.clone();
                        Button::new(SharedString::from(format!("run-anyway-{agent_id}")))
                            .ghost()
                            .label("Run anyway")
                            .disabled(view.upgrade().is_none_or(|v| v.read(cx).read_only))
                            .on_click(move |_, _, cx| {
                                let _ = view.update(cx, |_, cx| {
                                    cx.emit(TranscriptEvent::RequestAgent {
                                        agent_id: agent_id.clone(),
                                    })
                                });
                            })
                    }))
                    .children(c.checkpoint_id.clone().map(|checkpoint| {
                        let view = view.clone();
                        Button::new(SharedString::from(format!("role-revert-{checkpoint}")))
                            .ghost()
                            .label("Revert")
                            .disabled(!revertable)
                            .on_click(move |_, _, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    if this.can_revert && !this.read_only {
                                        cx.emit(TranscriptEvent::RevertCheckpoint {
                                            checkpoint_id: checkpoint.clone(),
                                        });
                                    }
                                });
                            })
                    }))
                    .into_any_element(),
                ItemContent::RevertMarker(c) => div()
                    .px_4()
                    .py_2()
                    .border_t_1()
                    .border_color(color(Token::Border, cx))
                    .child(format!("Reverted to turn {}", c.to_turn_seq))
                    .into_any_element(),
                ItemContent::Error(c) => error_card(&id, &item, c, ix, view.clone(), cx),
                ItemContent::Permission(p) => {
                    let read_only = view.upgrade().is_none_or(|v| v.read(cx).read_only);
                    let answered = p.chosen_option_id.is_some()
                        || matches!(
                            item.status,
                            ItemStatus::Completed | ItemStatus::Cancelled | ItemStatus::Failed
                        );
                    let focus = view
                        .upgrade()
                        .and_then(|v| v.read(cx).permission_focus.get(&p.request_id).cloned());
                    let buttons = p.options.iter().map(|option| {
                        let weak = view.clone();
                        let request_id = p.request_id.clone();
                        let option_id = option.option_id.clone();
                        Button::new(SharedString::from(format!("{id}:{}", option.option_id)))
                            .label(option.name.clone())
                            .disabled(read_only || answered)
                            .on_click(move |_, _, cx| {
                                let _ = weak.update(cx, |_, cx| {
                                    cx.emit(TranscriptEvent::Permission {
                                        request_id: request_id.clone(),
                                        option_id: option_id.clone(),
                                    })
                                });
                            })
                    });
                    let mut card = div()
                        .id(id.clone())
                        .role(Role::Group)
                        .aria_label("Agent permission")
                        .px_4()
                        .py_3()
                        .border_1()
                        .border_color(color(Token::Border, cx))
                        .child(
                            v_flex()
                                .gap_2()
                                .child(p.title.clone())
                                .child(h_flex().gap_2().children(buttons)),
                        );
                    if let Some(focus) = focus {
                        let options = p.options.clone();
                        let request_id = p.request_id.clone();
                        let weak = view.clone();
                        card = card.track_focus(&focus).on_key_down(move |event, _, cx| {
                            if read_only || answered {
                                return;
                            }
                            let kind = match event.keystroke.key.as_str() {
                                "enter" => "allow",
                                "backspace" => "reject",
                                _ => return,
                            };
                            if let Some(option) =
                                super::chat_model::first_permission_option(&options, kind)
                            {
                                let _ = weak.update(cx, |_, cx| {
                                    cx.emit(TranscriptEvent::Permission {
                                        request_id: request_id.clone(),
                                        option_id: option.option_id.clone(),
                                    })
                                });
                                cx.stop_propagation();
                            }
                        });
                    }
                    card.into_any_element()
                }
            };
            div()
                .opacity(if dim { 0.5 } else { 1. })
                .child(body)
                .into_any_element()
        }
    }
}

/// 04, Transcript, `user_message`: text, mention chips and attachment thumbnails; the time and
/// `Revert to here` show on hover.
fn user_message(
    id: &SharedString,
    item: &tempo_protocol::Item,
    c: &tempo_protocol::UserMessageContent,
    revertable: bool,
    view: gpui_kit::WeakEntity<TranscriptView>,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    let (thumbnails, can_revert) = view
        .upgrade()
        .map(|v| {
            let v = v.read(cx);
            let images: HashMap<_, _> = c
                .attachments
                .iter()
                .filter_map(|a| Some((a.id.clone(), v.thumbnails.images.get(&a.id)?.clone())))
                .collect();
            (images, !v.read_only && v.can_revert)
        })
        .unwrap_or_default();
    let muted = color(Token::MutedForeground, cx);
    let border = color(Token::Border, cx);
    let chip = move |key: SharedString, label: String| {
        div()
            .id(key)
            .role(Role::Note)
            .aria_label(format!("Attachment {label}"))
            .px_1p5()
            .border_1()
            .border_color(border)
            .rounded_sm()
            .text_xs()
            .child(label)
            .into_any_element()
    };
    let attachments = c.attachments.iter().map(|a| {
        let key: SharedString = format!("{id}:attachment:{}", a.id).into();
        let name = a.name.clone();
        match thumbnails.get(&a.id).cloned() {
            Some(image) => {
                let fallback_key = key.clone();
                div()
                    .id(key.clone())
                    .role(Role::Image)
                    .aria_label(name.clone())
                    .child(
                        gpui_kit::img(image)
                            .size(px(64.))
                            .object_fit(ObjectFit::Cover)
                            .rounded_sm()
                            .border_1()
                            .border_color(border)
                            .with_fallback({
                                let name = name.clone();
                                move || chip(fallback_key.clone(), name.clone())
                            }),
                    )
                    .into_any_element()
            }
            None => chip(key, name),
        }
    });
    let mentions = c.mentions.iter().enumerate().map(|(ix, m)| {
        let path = links::workspace_path(&m.path).map(str::to_string);
        Button::new(SharedString::from(format!("{id}:mention:{ix}")))
            .ghost()
            .label(format!("@{}", m.path))
            .accessibility_label(format!("Open {}", m.path))
            .disabled(path.is_none())
            .on_click(move |_, window, cx| {
                if let Some(path) = &path {
                    window.dispatch_action(Box::new(OpenWorkspaceFile(path.clone().into())), cx)
                }
            })
    });
    let turn = item.turn_id.clone();
    let group: SharedString = format!("{id}:hover").into();
    let now = now_ms();
    v_flex()
        .id(SharedString::from(format!("{id}:user")))
        .group(group.clone())
        .role(Role::Article)
        .aria_label("Your message")
        .w_full()
        .items_end()
        .gap_1()
        .child(
            v_flex()
                .min_w_0()
                .max_w(gpui_kit::relative(0.85))
                .rounded_lg()
                .bg(color(Token::Muted, cx))
                .px_3()
                .py_2()
                .gap_2()
                .children((!c.text.is_empty()).then(|| {
                    div()
                        .min_w_0()
                        .text_sm()
                        .whitespace_normal()
                        .child(c.text.clone())
                }))
                .children(
                    (!c.mentions.is_empty() || !c.attachments.is_empty()).then(|| {
                        h_flex()
                            .gap_1()
                            .flex_wrap()
                            .children(mentions)
                            .children(attachments)
                    }),
                ),
        )
        .child(
            h_flex()
                .px_4()
                .gap_2()
                .h(px(20.))
                .text_xs()
                .text_color(muted)
                .invisible()
                .group_hover(group, |s| s.visible())
                .child(chat_model::format_relative(item.created_at, now))
                .children((revertable && can_revert && turn.is_some()).then(|| {
                    Button::new(SharedString::from(format!("revert-{}", item.id)))
                        .ghost()
                        .label("Revert to here")
                        .on_click(move |_, _, cx| {
                            let _ = view.update(cx, |this, cx| {
                                if !this.read_only
                                    && let Some(turn) = &turn
                                {
                                    cx.emit(TranscriptEvent::Revert {
                                        turn_id: turn.clone(),
                                    });
                                }
                            });
                        })
                })),
        )
        .into_any_element()
}

/// 04, Transcript, `error`: a red card with the message, the code, and Retry.
fn error_card(
    id: &SharedString,
    item: &tempo_protocol::Item,
    c: &tempo_protocol::ErrorContent,
    ix: usize,
    view: gpui_kit::WeakEntity<TranscriptView>,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    let detail_key = format!("{id}:detail");
    let (agent, read_only, open) = view
        .upgrade()
        .map(|v| {
            let v = v.read(cx);
            (v.agent, v.read_only, v.is_open(&detail_key, false))
        })
        .unwrap_or((None, true, false));
    let message = crate::errors::error_message(&c.code, agent);
    let toggle = view.clone();
    let retry = view;
    let turn_id = item.turn_id.clone();
    v_flex()
        .id(SharedString::from(format!("{id}:error")))
        .role(Role::Alert)
        .aria_label(message.clone())
        .mx_4()
        .my_1()
        .p_2()
        .gap_1()
        .border_1()
        .border_color(color(Token::Destructive, cx))
        .rounded_md()
        .child(
            h_flex()
                .gap_2()
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(div().text_sm().child(message))
                        .child(
                            div()
                                .font_family("monospace")
                                .text_xs()
                                .text_color(color(Token::MutedForeground, cx))
                                .child(c.code.clone()),
                        ),
                )
                .children(c.detail.is_some().then(|| {
                    Button::new(SharedString::from(format!("{id}:details")))
                        .ghost()
                        .label("Details")
                        .on_click(move |_, _, cx| {
                            let _ = toggle.update(cx, |this, cx| {
                                let open = this.is_open(&detail_key, false);
                                this.open.insert(detail_key.clone(), !open);
                                this.scroller
                                    .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                                cx.notify();
                            });
                        })
                }))
                .children(turn_id.filter(|_| !read_only).map(|turn_id| {
                    Button::new(SharedString::from(format!("{id}:retry")))
                        .label("Retry")
                        .on_click(move |_, _, cx| {
                            let _ = retry.update(cx, |_, cx| {
                                cx.emit(TranscriptEvent::Retry {
                                    turn_id: turn_id.clone(),
                                })
                            });
                        })
                })),
        )
        .children(open.then(|| c.detail.clone()).flatten().map(|detail| {
            div()
                .font_family("monospace")
                .text_xs()
                .text_color(color(Token::MutedForeground, cx))
                .child(detail)
        }))
        .into_any_element()
}

struct Disclosure {
    title: SharedString,
    tooltip: Option<SharedString>,
    mono: bool,
    default_open: bool,
}

impl Disclosure {
    fn new(title: &'static str) -> Self {
        Self {
            title: title.into(),
            tooltip: None,
            mono: false,
            default_open: false,
        }
    }
}

fn disclosure(
    id: SharedString,
    header: Disclosure,
    content: AnyElement,
    ix: usize,
    view: gpui_kit::WeakEntity<TranscriptView>,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    let key = id.to_string();
    let default = header.default_open;
    let expanded = view
        .upgrade()
        .is_some_and(|v| v.read(cx).is_open(&key, default));
    let mut button = Button::new(SharedString::from(format!("{id}:disclosure")))
        .ghost()
        .w_full()
        .px_0()
        .accessibility_label(header.title.clone())
        .child(div().w_full().min_w_0().truncate().child(header.title))
        .on_click(move |_, _, cx| {
            let _ = view.update(cx, |this, cx| {
                let open = this.is_open(&key, default);
                this.open.insert(key.clone(), !open);
                this.scroller.update(cx, |s, cx| {
                    s.remeasure_items(ix..ix + 1, cx);
                });
                cx.notify();
            });
        });
    if let Some(tooltip) = header.tooltip {
        button = button.tooltip(tooltip);
    }
    if header.mono {
        button = button.font_family("monospace");
    }
    Collapsible::new()
        .w_full()
        .px_4()
        .open(expanded)
        .child(button)
        .content(div().min_w_0().pl_4().child(content))
        .into_any_element()
}

fn work_icon(kind: WorkType) -> &'static str {
    match kind {
        WorkType::Explore => "⌕",
        WorkType::Edit => "✎",
        WorkType::Run => ">_",
        WorkType::Web => "↗",
        WorkType::SubAgent => "◎",
        WorkType::Other => "◇",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deltas_are_escaped_as_they_stream() {
        let mut row = TranscriptRow::new("r1", "Hello ");
        row.push_delta("<img src=https://x.test/p.png>");
        row.push_delta(" and `Vec<u8>`");
        assert_eq!(
            row.rendered().as_ref(),
            "Hello &lt;img src=https://x.test/p.png> and `Vec<u8>`"
        );
    }

    #[test]
    fn thumbnails_take_served_images_and_evict_the_oldest_past_the_budget() {
        let file = |mime: &str, len: usize| AttachmentFile {
            mime: mime.into(),
            bytes: vec![1; len],
        };
        assert!(thumbnail_image(file("image/png", 3)).is_some());
        assert!(thumbnail_image(file("application/octet-stream", 3)).is_none());
        assert!(thumbnail_image(file("image/webp", 0)).is_none());
        let mut cache = Thumbnails::default();
        let big = THUMBNAIL_BUDGET / 2 + 1;
        cache.pending.insert("a".into());
        assert!(cache.wants("b") && !cache.wants("a"));
        let image = |len| thumbnail_image(file("image/png", len)).unwrap();
        assert!(cache.insert("a".into(), image(big)).is_empty());
        assert_eq!(cache.insert("b".into(), image(big)).len(), 1);
        assert!(!cache.images.contains_key("a") && cache.images.contains_key("b"));
        assert!(
            !cache.wants("a"),
            "an evicted thumbnail is not fetched again"
        );
        cache.fail("c");
        assert!(!cache.wants("c"));
    }

    #[gpui_kit::test]
    fn expand_all_toggles_work_rows_and_folded_tool_calls(cx: &mut gpui_kit::TestAppContext) {
        let mut state = tempo_client::state::workspace::WorkspaceState::new();
        for line in include_str!(
            "../../../../packages/protocol/fixtures/channel/workspace-first-load.jsonl"
        )
        .lines()
        {
            state.apply(serde_json::from_str(line).unwrap());
        }
        let rows: Vec<_> = state
            .sessions
            .keys()
            .flat_map(|id| {
                chat_model::transcript_rows(&state, id, chat_model::TranscriptDetail::Default)
            })
            .map(TranscriptRow::from_native)
            .collect();
        let work = rows
            .iter()
            .filter(|r| matches!(r.native, Some(RowContent::Work { .. })))
            .count();
        assert!(work > 0);
        let view = cx.new(|cx| TranscriptView::new(rows, cx));
        view.update(cx, |view, cx| view.toggle_tools(cx));
        view.read_with(cx, |view, _| {
            assert!(view.open.keys().filter(|k| k.starts_with("work:")).count() == work);
            assert!(view.open.values().all(|open| *open));
        });
        view.update(cx, |view, cx| view.toggle_tools(cx));
        view.read_with(cx, |view, _| assert!(view.open.values().all(|open| !open)));
    }

    #[gpui_kit::test]
    fn expand_all_toggles_only_tool_rows(cx: &mut gpui_kit::TestAppContext) {
        let mut state = tempo_client::state::workspace::WorkspaceState::new();
        for line in include_str!(
            "../../../../packages/protocol/fixtures/channel/workspace-first-load.jsonl"
        )
        .lines()
        {
            state.apply(serde_json::from_str(line).unwrap());
        }
        let rows: Vec<_> = state
            .items
            .values()
            .filter(|item| matches!(item.content, ItemContent::ToolCall(_)))
            .cloned()
            .map(|item| {
                TranscriptRow::from_native(RowContent::Item {
                    item: Box::new(item),
                    dim: false,
                    revertable: false,
                })
            })
            .collect();
        assert!(!rows.is_empty());
        let count = rows.len();
        let view = cx.new(|cx| TranscriptView::new(rows, cx));
        view.update(cx, |view, cx| view.toggle_tools(cx));
        view.read_with(cx, |view, _| {
            assert_eq!(view.open.len(), count);
            assert!(view.open.values().all(|open| *open));
        });
        view.update(cx, |view, cx| view.toggle_tools(cx));
        view.read_with(cx, |view, _| assert!(view.open.values().all(|open| !open)));
    }
}
