//! Transcript (04, Center; 07, Transcript): `MessageScroller` with one `TextView::markdown` row
//! per message. Agent text is escaped before it reaches `TextView` (`crate::markdown`); each row
//! sits in the transcript's `LocalImageCache` (`crate::image_policy`); link clicks follow
//! `crate::links`. A streamed delta appends to its row and remeasures only that row.
use crate::image_policy::LocalImageCache;
use crate::links::{self, LinkTarget};
use crate::markdown::escape_raw_html;
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::text::TextView;
use gpui_kit::{
    Action, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, image_cache,
};

/// Opens a file tab at a workspace path (07, Links). Handled by the workspace view in M3.
#[derive(Clone, PartialEq, Eq, Debug, Action)]
#[action(namespace = tempo, no_json)]
pub struct OpenWorkspaceFile(pub SharedString);

#[derive(Clone, Debug)]
pub struct TranscriptRow {
    pub id: SharedString,
    source: String,
    rendered: SharedString,
}

impl TranscriptRow {
    pub fn new(id: impl Into<SharedString>, markdown: impl Into<String>) -> Self {
        let source = markdown.into();
        let rendered = escape_raw_html(&source).into_owned().into();
        Self {
            id: id.into(),
            source,
            rendered,
        }
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

pub struct TranscriptView {
    rows: Vec<TranscriptRow>,
    scroller: Entity<MessageScrollerState>,
    images: Entity<LocalImageCache>,
}

impl TranscriptView {
    pub fn new(rows: Vec<TranscriptRow>, cx: &mut Context<Self>) -> Self {
        let count = rows.len();
        Self {
            rows,
            scroller: cx.new(|cx| MessageScrollerState::new(count, cx)),
            images: LocalImageCache::new(cx),
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
            let row = view.upgrade().and_then(|v| {
                v.read(cx)
                    .rows
                    .get(ix)
                    .map(|r| (r.id.clone(), r.rendered.clone()))
            });
            // GPUI lays out list rows during prepaint, where an outer `image_cache` element is not
            // on the stack; wrapping each row puts the cache in scope for its images.
            image_cache(images.clone())
                .w_full()
                .children(row.map(|(id, text)| render_row(id, text)))
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
