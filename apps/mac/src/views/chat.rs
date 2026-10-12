//! Transcript (04, Center; 07, Transcript): `MessageScroller` with one `TextView::markdown` row
//! per message. Agent text is escaped before it reaches `TextView` (`crate::markdown`); each row
//! sits in the transcript's `LocalImageCache` (`crate::image_policy`); link clicks follow
//! `crate::links`. A streamed delta appends to its row and remeasures only that row.
use super::chat_model::{self, RowContent, WorkType};
use super::tokens::{Token, color};
use crate::image_policy::LocalImageCache;
use crate::links::{self, LinkTarget};
use crate::markdown::escape_raw_html;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::collapsible::Collapsible;
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    Action, AnyElement, AppContext as _, Context, Entity, EventEmitter, FocusHandle,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, image_cache,
};
use std::collections::{HashMap, HashSet};
use tempo_protocol::{ItemContent, ItemStatus, NoticeLevel, TurnStatus};

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
    Permission {
        request_id: String,
        option_id: String,
    },
    Retry {
        turn_id: String,
    },
    Revert {
        turn_id: String,
    },
}

impl EventEmitter<TranscriptEvent> for TranscriptView {}

pub struct TranscriptView {
    rows: Vec<TranscriptRow>,
    scroller: Entity<MessageScrollerState>,
    images: Entity<LocalImageCache>,
    open: HashMap<String, bool>,
    ticker: Option<gpui_kit::Task<()>>,
    inline_images: HashMap<String, std::sync::Arc<gpui_kit::Image>>,
    media_pending: HashSet<String>,
    permission_focus: HashMap<String, FocusHandle>,
    pub read_only: bool,
}

impl TranscriptView {
    pub fn new(rows: Vec<TranscriptRow>, cx: &mut Context<Self>) -> Self {
        let count = rows.len();
        Self {
            rows,
            scroller: cx.new(|cx| MessageScrollerState::new(count, cx)),
            images: LocalImageCache::new(cx),
            open: HashMap::new(),
            ticker: None,
            inline_images: HashMap::new(),
            media_pending: HashSet::new(),
            permission_focus: HashMap::new(),
            read_only: false,
        }
    }

    pub fn sync(&mut self, rows: Vec<TranscriptRow>, cx: &mut Context<Self>) {
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
                let block = serde_json::Value::Object(block.0.clone());
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
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.weak_entity();
        let images = self.images.clone();
        let background = color(Token::Background, cx);
        MessageScroller::new("transcript", self.scroller.clone(), move |ix, _, cx| {
            let row = view
                .upgrade()
                .and_then(|v| v.read(cx).rows.get(ix).cloned());
            // GPUI lays out list rows during prepaint, where an outer `image_cache` element is not
            // on the stack; wrapping each row puts the cache in scope for its images.
            image_cache(images.clone())
                .w_full()
                .children(row.map(|row| {
                    if row.native.is_some() {
                        render_native_row(row, ix, view.clone(), cx)
                    } else {
                        render_row(row.id, row.rendered).into_any_element()
                    }
                }))
        })
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
        .px_4()
        .py_2()
        .child(
            TextView::markdown(id, text)
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

fn markdown(id: SharedString, text: &str) -> AnyElement {
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
                .opacity(if dim { 0.5 } else { 1. })
                .child(
                    Collapsible::new()
                        .open(open)
                        .child(
                            Button::new(SharedString::from(format!("{id}:toggle")))
                                .ghost()
                                .w_full()
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
            let duration = turn
                .started_at
                .zip(turn.ended_at)
                .filter(|_| !work_row)
                .map(|(start, end)| format!("{} · ", chat_model::format_duration(end - start)))
                .unwrap_or_default();
            div()
                .px_4()
                .py_2()
                .opacity(if turn.reverted { 0.5 } else { 1. })
                .text_color(color(Token::MutedForeground, cx))
                .child(format!("{duration}{}", turn.status))
                .into_any_element()
        }
        RowContent::Item { item, dim } => {
            let body = match &item.content {
                ItemContent::AgentMessage(c) => v_flex()
                    .child(markdown(id.clone(), &c.text))
                    .children((item.status == ItemStatus::Streaming).then(|| {
                        div()
                            .px_4()
                            .text_color(color(Token::MutedForeground, cx))
                            .child("Streaming…")
                    }))
                    .into_any_element(),
                ItemContent::UserMessage(c) => v_flex()
                    .child(markdown(id.clone(), &c.text))
                    .children(
                        c.mentions
                            .iter()
                            .map(|m| div().px_4().text_sm().child(format!("@{}", m.path))),
                    )
                    .children(
                        c.attachments
                            .iter()
                            .map(|a| div().px_4().text_sm().child(a.name.clone())),
                    )
                    .child({
                        let turn = item.turn_id.clone();
                        let view = view.clone();
                        Button::new(SharedString::from(format!("revert-{}", item.id)))
                            .label("Revert to here")
                            .disabled(turn.is_none())
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
                    })
                    .into_any_element(),
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
                        let value = serde_json::Value::Object(block.0.clone());
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
                        markdown(key, inner["text"].as_str().unwrap_or("Inline media"))
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
                    .into_any_element(),
                ItemContent::RevertMarker(c) => div()
                    .px_4()
                    .py_2()
                    .border_t_1()
                    .border_color(color(Token::Border, cx))
                    .child(format!("Reverted to turn {}", c.to_turn_seq))
                    .into_any_element(),
                ItemContent::Error(c) => {
                    let turn_id = item.turn_id.clone();
                    let weak = view.clone();
                    v_flex()
                        .px_4()
                        .gap_2()
                        .text_color(color(Token::Destructive, cx))
                        .child(c.code.clone())
                        .children(c.detail.clone())
                        .children(turn_id.map(|turn_id| {
                            Button::new(SharedString::from(format!("{id}:retry")))
                                .label("Retry")
                                .on_click(move |_, _, cx| {
                                    let _ = weak.update(cx, |_, cx| {
                                        cx.emit(TranscriptEvent::Retry {
                                            turn_id: turn_id.clone(),
                                        })
                                    });
                                })
                        }))
                        .into_any_element()
                }
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
        .label(header.title)
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
        .open(expanded)
        .child(div().min_w_0().truncate().child(button))
        .content(content)
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
