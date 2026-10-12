//! Transcript (04, Center; 07, Transcript): `MessageScroller` with one `TextView::markdown` row
//! per message. Agent text is escaped before it reaches `TextView` (`crate::markdown`); each row
//! sits in the transcript's `LocalImageCache` (`crate::image_policy`); link clicks follow
//! `crate::links`. A streamed delta appends to its row and remeasures only that row.
use super::chat_model::RowContent;
use super::tokens::{Token, color};
use crate::image_policy::LocalImageCache;
use crate::links::{self, LinkTarget};
use crate::markdown::{escape_raw_html, tool_text};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::collapsible::Collapsible;
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    Action, AnyElement, AppContext as _, Context, Entity, EventEmitter, FocusHandle,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, image_cache,
};
use std::collections::{HashMap, HashSet};
use tempo_protocol::{ItemContent, ItemStatus, NoticeLevel};

/// Opens a file tab at a workspace path (07, Links). Handled by the workspace view in M3.
#[derive(Clone, PartialEq, Eq, Debug, Action)]
#[action(namespace = tempo, no_json)]
pub struct OpenWorkspaceFile(pub SharedString);

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
}

impl EventEmitter<TranscriptEvent> for TranscriptView {}

pub struct TranscriptView {
    rows: Vec<TranscriptRow>,
    scroller: Entity<MessageScrollerState>,
    images: Entity<LocalImageCache>,
    expanded: HashSet<String>,
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
            expanded: HashSet::new(),
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
        cx.notify();
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
        .size_full()
    }
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
                .selectable(true)
                .on_link_click(|url, _, window, cx| match links::classify(url) {
                    LinkTarget::Browser(url) => cx.open_url(&url),
                    LinkTarget::FileTab(path) => {
                        window.dispatch_action(Box::new(OpenWorkspaceFile(path.into())), cx)
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
        RowContent::Footer { turn } => {
            let duration = turn
                .started_at
                .zip(turn.ended_at)
                .map(|(start, end)| format!("{:.1}s · ", (end - start).max(0.) / 1000.))
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
                    .into_any_element(),
                ItemContent::AgentThought(c) => disclosure(
                    id.clone(),
                    "Thinking".into(),
                    markdown(id.clone(), &c.text),
                    ix,
                    view.clone(),
                    cx,
                ),
                ItemContent::Handoff(c) => disclosure(
                    id.clone(),
                    "Session restarted; transcript handed to the agent".into(),
                    markdown(id.clone(), &c.text),
                    ix,
                    view.clone(),
                    cx,
                ),
                ItemContent::ToolCall(c) => {
                    let blocks = c.content.iter().enumerate().map(|(index, block)| {
                        let text = block
                            .0
                            .get("content")
                            .unwrap_or(&block.0)
                            .get("text")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("");
                        markdown(
                            format!("{}:block:{index}", id).into(),
                            &tool_text(text, c.tool_kind.as_deref() == Some("execute")),
                        )
                    });
                    let details =
                        v_flex()
                            .children(blocks)
                            .children(c.locations.iter().map(|loc| {
                                markdown(
                                    format!("{}:{}", id, loc.path).into(),
                                    &format!(
                                        "[{}](file:///workspace/{})",
                                        loc.path,
                                        loc.path.trim_start_matches("/workspace/")
                                    ),
                                )
                            }));
                    disclosure(
                        id.clone(),
                        format!("{} · {}", c.title, item.status).into(),
                        details.into_any_element(),
                        ix,
                        view.clone(),
                        cx,
                    )
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

fn disclosure(
    id: SharedString,
    title: SharedString,
    content: AnyElement,
    ix: usize,
    view: gpui_kit::WeakEntity<TranscriptView>,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    let expanded = view
        .upgrade()
        .is_some_and(|v| v.read(cx).expanded.contains(id.as_ref()));
    let key = id.to_string();
    Collapsible::new()
        .open(expanded)
        .child(
            Button::new(SharedString::from(format!("{id}:disclosure")))
                .ghost()
                .label(title)
                .on_click(move |_, _, cx| {
                    let _ = view.update(cx, |this, cx| {
                        if !this.expanded.remove(&key) {
                            this.expanded.insert(key.clone());
                        }
                        this.scroller.update(cx, |s, cx| {
                            s.remeasure_items(ix..ix + 1, cx);
                        });
                        cx.notify();
                    });
                }),
        )
        .content(content)
        .into_any_element()
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
}
