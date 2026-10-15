use super::{
    review::ReviewPanel,
    tokens::{Token, color},
    workspace_info::InfoAction,
};
use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Disableable as _, Selectable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, Context, Entity, EventEmitter, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div,
};
use serde_json::Value;
use std::collections::HashSet;
use tempo_client::Client;
use tempo_protocol::{self as p, api};

pub const PR_GUIDE_PATH: &str = ".tempo/pr-guide.json";

/// Where a guide link points: a chapter or flow file, or a visual's artifact file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuideTarget {
    File(String),
    Artifact(String),
}

fn utf16_len(value: &Value, min: usize, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| (min..=max).contains(&text.encode_utf16().count()))
}

fn label(value: &Value) -> bool {
    utf16_len(value, 1, 200)
}

fn text(value: &Value) -> bool {
    utf16_len(value, 1, 20_000)
}

fn optional(value: &Value, check: fn(&Value) -> bool) -> bool {
    value.is_null() || check(value)
}

fn items(value: &Value, min: usize, max: usize) -> Option<&Vec<Value>> {
    value
        .as_array()
        .filter(|items| (min..=max).contains(&items.len()))
}

/// `GuidePath` of `packages/protocol/src/pr-guide.ts`.
fn guide_path(value: &Value) -> bool {
    utf16_len(value, 1, 1024)
        && value.as_str().is_some_and(|path| {
            !path.contains('\\')
                && !path.chars().any(|c| c.is_ascii_control())
                && path
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
        })
}

fn valid_visual(value: &Value) -> bool {
    if !label(&value["title"]) {
        return false;
    }
    match value["kind"].as_str() {
        Some("comparison") => text(&value["before"]) && text(&value["after"]),
        Some("flow") => {
            let (Some(nodes), Some(edges)) =
                (items(&value["nodes"], 1, 30), items(&value["edges"], 0, 60))
            else {
                return false;
            };
            let ids: HashSet<&str> = nodes.iter().filter_map(|n| n["id"].as_str()).collect();
            ids.len() == nodes.len()
                && nodes.iter().all(|n| {
                    label(&n["id"])
                        && label(&n["label"])
                        && text(&n["description"])
                        && optional(&n["path"], guide_path)
                })
                && edges.iter().all(|e| {
                    label(&e["label"])
                        && [&e["from"], &e["to"]]
                            .iter()
                            .all(|end| end.as_str().is_some_and(|id| ids.contains(id)))
                })
        }
        Some("markdown" | "image" | "html") => {
            guide_path(&value["path"]) && optional(&value["caption"], text)
        }
        _ => false,
    }
}

/// The checks of `parsePrGuide` in `packages/protocol/src/pr-guide.ts`.
pub fn parse_guide(content: &str) -> Option<Value> {
    let guide: Value = serde_json::from_str(content).ok()?;
    let chapters = items(&guide["chapters"], 1, 50)?;
    let ids: HashSet<&str> = chapters.iter().filter_map(|c| c["id"].as_str()).collect();
    let valid = guide["version"] == 1
        && label(&guide["title"])
        && ["summary", "before", "after"]
            .iter()
            .all(|key| text(&guide[*key]))
        && ids.len() == chapters.len()
        && chapters.iter().all(|c| {
            label(&c["id"])
                && label(&c["title"])
                && text(&c["description"])
                && items(&c["files"], 0, 100).is_some_and(|files| files.iter().all(guide_path))
                && items(&c["visuals"], 0, 10)
                    .is_some_and(|visuals| visuals.iter().all(valid_visual))
        });
    valid.then_some(guide)
}

fn muted<T>(label: impl Into<SharedString>, cx: &Context<T>) -> gpui_kit::Div {
    div()
        .text_sm()
        .text_color(color(Token::MutedForeground, cx))
        .child(label.into())
}

fn heading(text: &Value) -> gpui_kit::Div {
    div()
        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
        .child(text.as_str().unwrap_or("").to_string())
}

fn link<T: 'static>(
    id: String,
    target: GuideTarget,
    open: impl Fn(&mut T, GuideTarget, &mut Window, &mut Context<T>) + 'static,
    cx: &mut Context<T>,
) -> Button {
    let (GuideTarget::File(path) | GuideTarget::Artifact(path)) = &target;
    let path = path.clone();
    Button::new(SharedString::from(id))
        .ghost()
        .w_full()
        .accessibility_label(path.clone())
        .child(div().w_full().text_left().truncate().child(path))
        .on_click(cx.listener(move |this, _, window, cx| open(this, target.clone(), window, cx)))
}

fn render_visual<T: 'static>(
    index: usize,
    visual: &Value,
    open: impl Fn(&mut T, GuideTarget, &mut Window, &mut Context<T>) + Clone + 'static,
    cx: &mut Context<T>,
) -> AnyElement {
    let markdown = |part: &str, text: &Value| {
        super::chat::markdown(
            format!("guide-visual-{index}-{part}").into(),
            text.as_str().unwrap_or(""),
        )
    };
    let mut column = v_flex().gap_2().child(heading(&visual["title"]));
    match visual["kind"].as_str() {
        Some("comparison") => {
            column = column
                .child(muted("Before", cx))
                .child(markdown("before", &visual["before"]))
                .child(muted("After", cx))
                .child(markdown("after", &visual["after"]));
        }
        Some("flow") => {
            let nodes = visual["nodes"].as_array().cloned().unwrap_or_default();
            let name = |id: &Value| {
                nodes
                    .iter()
                    .find(|n| &n["id"] == id)
                    .and_then(|n| n["label"].as_str())
                    .unwrap_or("")
                    .to_string()
            };
            for (i, node) in nodes.iter().enumerate() {
                column = column
                    .child(heading(&node["label"]))
                    .child(markdown(&format!("node-{i}"), &node["description"]));
                if let Some(path) = node["path"].as_str() {
                    column = column.child(link(
                        format!("guide-visual-{index}-node-{i}"),
                        GuideTarget::File(path.into()),
                        open.clone(),
                        cx,
                    ));
                }
            }
            for edge in visual["edges"].as_array().into_iter().flatten() {
                column = column.child(muted(
                    format!(
                        "{} → {} · {}",
                        name(&edge["from"]),
                        name(&edge["to"]),
                        edge["label"].as_str().unwrap_or("")
                    ),
                    cx,
                ));
            }
        }
        _ => {
            if visual["caption"].is_string() {
                column = column.child(markdown("caption", &visual["caption"]));
            }
            if let Some(path) = visual["path"].as_str() {
                column = column.child(link(
                    format!("guide-visual-{index}-path"),
                    GuideTarget::Artifact(path.into()),
                    open,
                    cx,
                ));
            }
        }
    }
    column.into_any_element()
}

/// A validated guide: title, summary, before/after, chapters and the selected chapter.
pub fn render_guide<T: 'static>(
    guide: &Value,
    selected: usize,
    cx: &mut Context<T>,
    select: fn(&mut T, usize, &mut Context<T>),
    open: impl Fn(&mut T, GuideTarget, &mut Window, &mut Context<T>) + Clone + 'static,
) -> AnyElement {
    let markdown = |key: &str, value: &Value| {
        super::chat::markdown(format!("guide-{key}").into(), value.as_str().unwrap_or(""))
    };
    let chapters = guide["chapters"].as_array().cloned().unwrap_or_default();
    let mut body = v_flex()
        .gap_3()
        .child(heading(&guide["title"]).text_lg())
        .child(markdown("summary", &guide["summary"]))
        .child(muted("Before", cx))
        .child(markdown("before", &guide["before"]))
        .child(muted("After", cx))
        .child(markdown("after", &guide["after"]))
        .children(chapters.iter().enumerate().map(|(i, c)| {
            Button::new(("guide-chapter", i))
                .ghost()
                .w_full()
                .selected(i == selected)
                .child(div().w_full().text_left().truncate().child(format!(
                    "{}. {}",
                    i + 1,
                    c["title"].as_str().unwrap_or("")
                )))
                .on_click(cx.listener(move |this, _, _, cx| select(this, i, cx)))
        }));
    if let Some(chapter) = chapters.get(selected) {
        body = body
            .child(heading(&chapter["title"]))
            .child(markdown("chapter-description", &chapter["description"]));
        for (i, visual) in chapter["visuals"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            body = body.child(render_visual(i, visual, open.clone(), cx));
        }
        for (i, path) in chapter["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .enumerate()
        {
            body = body.child(link(
                format!("guide-file-{i}"),
                GuideTarget::File(path.into()),
                open.clone(),
                cx,
            ));
        }
    }
    body.into_any_element()
}

impl EventEmitter<InfoAction> for GuidePanel {}
pub struct GuidePanel {
    store: Entity<WorkspaceStore>,
    client: Client,
    review: Entity<ReviewPanel>,
    guide: Option<serde_json::Value>,
    error: Option<String>,
    loading: bool,
    pub active_chat: Option<String>,
    selected: usize,
    opened: bool,
    completed: usize,
    was_live: bool,
    _changed: Subscription,
}
impl GuidePanel {
    pub fn new(
        store: Entity<WorkspaceStore>,
        client: Client,
        review: Entity<ReviewPanel>,
        cx: &mut Context<Self>,
    ) -> Self {
        let changed = cx.observe(&store, |this, store, cx| {
            let state = &store.read(cx).state;
            let completed = state
                .turns
                .values()
                .filter(|t| !matches!(t.status, p::TurnStatus::Running | p::TurnStatus::Queued))
                .count();
            let live = state.workspace.as_ref().is_some_and(|w| {
                matches!(
                    w.state,
                    p::WorkspaceState::Ready | p::WorkspaceState::Working
                )
            });
            let refresh = this.opened && live && (completed != this.completed || !this.was_live);
            this.completed = completed;
            this.was_live = live;
            if refresh {
                this.refresh(cx);
            }
            cx.notify();
        });
        Self {
            store,
            client,
            review,
            guide: None,
            error: None,
            loading: false,
            active_chat: None,
            selected: 0,
            opened: false,
            completed: 0,
            was_live: false,
            _changed: changed,
        }
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.opened = true;
        if self.loading
            || !self
                .store
                .read(cx)
                .state
                .workspace
                .as_ref()
                .is_some_and(|w| {
                    matches!(
                        w.state,
                        p::WorkspaceState::Ready | p::WorkspaceState::Working
                    )
                })
        {
            return;
        }
        let request = self.client.call::<api::ReadFile>(p::ReadFileIn {
            workspace_id: self.store.read(cx).workspace_id.clone(),
            path: PR_GUIDE_PATH.into(),
        });
        self.loading = true;
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this,cx| {
                this.loading = false;
                match result {
                    Ok(out) if out.encoding == p::ReadFileOutEncoding::Utf8 => {
                        match parse_guide(&out.content) {
                            Some(value) => { this.guide=Some(value); this.selected=0; }
                            None => {this.guide=None; this.error=Some("The guide preview could not be read. Ask your agent to repair it.".into());}
                        }
                    }
                    Ok(_) => {this.guide=None; this.error=Some("The guide must be a text JSON file.".into());}
                    Err(e) if super::toast::error_code(&e)=="NOT_FOUND" => {this.guide=None;}
                    Err(e) => this.error=Some(super::toast::error_text(&e,None)),
                }
                cx.notify();
            });
        }).detach();
    }
}
impl Render for GuidePanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = &self.store.read(cx).state;
        let live = state.workspace.as_ref().is_some_and(|w| {
            matches!(
                w.state,
                p::WorkspaceState::Ready | p::WorkspaceState::Working
            )
        });
        let can_generate = live
            && self
                .active_chat
                .as_ref()
                .and_then(|id| state.sessions.get(id))
                .is_some_and(|s| s.status != p::SessionStatus::Closed)
            && !state.turns.values().any(|t| {
                Some(&t.session_id) == self.active_chat.as_ref()
                    && matches!(t.status, p::TurnStatus::Running | p::TurnStatus::Queued)
            });
        let mut body = v_flex()
            .id("guides-preview")
            .size_full()
            .overflow_y_scroll()
            .p_4()
            .gap_3()
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("refresh-guide")
                            .ghost()
                            .small()
                            .label(if self.loading {
                                "Loading…"
                            } else {
                                "Refresh"
                            })
                            .disabled(!live || self.loading)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                    )
                    .child(
                        Button::new("generate-guide")
                            .outline()
                            .small()
                            .label(if self.guide.is_some() {
                                "Update guide"
                            } else {
                                "Create guide"
                            })
                            .disabled(!can_generate)
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(InfoAction::GenerateGuide)),
                            ),
                    ),
            )
            .child(
                Button::new("open-guided-review")
                    .accessibility_label("Open guided review")
                    .ghost()
                    .w_full()
                    .child(div().w_full().text_left().child("Open guided review ↗"))
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(InfoAction::OpenGuideReview))),
            );
        if !live {
            body = body
                .child(div().text_color(color(Token::MutedForeground, cx)).child(
                    if self.guide.is_some() {
                        "Showing the last loaded guide."
                    } else {
                        "Wake to load this workspace’s guide."
                    },
                ))
                .child(
                    Button::new("wake-guide")
                        .outline()
                        .small()
                        .label("Wake workspace")
                        .disabled(
                            !state
                                .workspace
                                .as_ref()
                                .is_some_and(|w| w.state == p::WorkspaceState::Sleeping),
                        )
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(InfoAction::Wake))),
                );
        }
        if self.active_chat.is_none() {
            body = body.child("Open a chat to choose the agent that creates your guide.");
        }
        if let Some(error) = &self.error {
            body = body.child(error.clone());
        }
        if let Some(guide) = &self.guide {
            body = body
                .child(div().text_sm().text_color(color(Token::MutedForeground, cx)).child(
                    "Agent-authored preview. Verify it against the branch diff. Open guided review for chapter diffs, comments and interactive artifacts.",
                ))
                .child(render_guide(
                    guide,
                    self.selected,
                    cx,
                    |this: &mut Self, index, cx| {
                        this.selected = index;
                        cx.notify();
                    },
                    |this: &mut Self, target, window, cx| {
                        this.review.update(cx, |review, cx| match target {
                            GuideTarget::File(path) => review.open_diff(path, window, cx),
                            GuideTarget::Artifact(path) => review.open_file(path, window, cx),
                        })
                    },
                ));
        } else if live && !self.loading && self.error.is_none() {
            body=body.child("Create a guide to explain this branch with chapters, linked files and comparisons.");
        }
        body
    }
}

#[cfg(test)]
mod tests {
    use super::parse_guide;
    use serde_json::{Value, json};

    fn guide() -> Value {
        json!({"version":1,"title":"Cache reads","summary":"Avoid repeated reads.",
            "before":"Always fetch.","after":"Cache repeated reads.","chapters":[
            {"id":"lookup","title":"Read from cache","description":"Try the cache first.",
                "files":["src/cache.ts"],"visuals":[
                {"kind":"comparison","title":"Reads","before":"Miss","after":"Hit"},
                {"kind":"flow","title":"Flow","nodes":[
                    {"id":"cache","label":"Cache","description":"Check a key."},
                    {"id":"db","label":"Database","description":"Fetch.","path":"src/db.ts"}],
                    "edges":[{"from":"cache","to":"db","label":"miss"}]},
                {"kind":"image","title":"Screenshot","path":".tempo/shot.png","caption":"After"}]}]})
    }

    fn rejects(change: impl FnOnce(&mut Value)) -> bool {
        let mut value = guide();
        change(&mut value);
        parse_guide(&value.to_string()).is_none()
    }

    #[test]
    fn guides_follow_the_shared_parse_rules() {
        assert!(parse_guide(&guide().to_string()).is_some());
        assert!(parse_guide("not json").is_none());
        assert!(rejects(|g| g["version"] = json!(2)));
        assert!(rejects(|g| g["chapters"] = json!([])));
        assert!(rejects(|g| g["summary"] = json!("")));
        assert!(rejects(|g| {
            let chapter = g["chapters"][0].clone();
            g["chapters"].as_array_mut().unwrap().push(chapter);
        }));
        for path in [
            "../secret",
            "/etc/passwd",
            "src//a.ts",
            "src\\a.ts",
            "a/./b",
            "a\u{7f}",
        ] {
            assert!(
                rejects(|g| g["chapters"][0]["files"] = json!([path])),
                "{path}"
            );
        }
        assert!(rejects(
            |g| g["chapters"][0]["visuals"][1]["edges"][0]["to"] = json!("gone")
        ));
        assert!(rejects(
            |g| g["chapters"][0]["visuals"][1]["nodes"][1]["id"] = json!("cache")
        ));
        assert!(rejects(
            |g| g["chapters"][0]["visuals"][2]["kind"] = json!("svg")
        ));
    }
}
