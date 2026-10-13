use super::{
    review::ReviewPanel,
    tokens::{Token, color},
    workspace_info::InfoAction,
};
use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Disableable as _, Selectable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    Context, Entity, EventEmitter, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Window, div,
};
use tempo_client::Client;
use tempo_protocol::{self as p, api};

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
            path: ".tempo/pr-guide.json".into(),
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
                        match serde_json::from_str::<serde_json::Value>(&out.content) {
                            Ok(value) if value["version"] == 1 && value["title"].is_string() && value["summary"].is_string() && value["chapters"].as_array().is_some_and(|c| !c.is_empty() && c.len() <= 50) => { this.guide=Some(value); this.selected=0; }
                            _ => {this.guide=None; this.error=Some("The guide preview could not be read. Ask your agent to repair it.".into());}
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
            body=body.child(div().text_lg().font_weight(gpui_kit::FontWeight::SEMIBOLD).child(guide["title"].as_str().unwrap_or("Guide").to_string()))
                .child(super::chat::markdown("guide-summary".into(),guide["summary"].as_str().unwrap_or("")))
                .child(div().text_sm().text_color(color(Token::MutedForeground,cx)).child("Agent-authored preview. Verify it against the branch diff. Open guided review for comparisons, flows and interactive artifacts."));
            if let Some(chapters) = guide["chapters"].as_array() {
                body = body.children(chapters.iter().enumerate().map(|(i, c)| {
                    Button::new(("guide-chapter", i))
                        .ghost()
                        .w_full()
                        .selected(i == self.selected)
                        .child(
                            div().w_full().text_left().truncate().child(
                                c["title"]
                                    .as_str()
                                    .unwrap_or("Untitled chapter")
                                    .to_string(),
                            ),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.selected = i;
                            cx.notify();
                        }))
                }));
                if let Some(c) = chapters.get(self.selected) {
                    body = body.child(super::chat::markdown(
                        "guide-chapter-description".into(),
                        c["description"].as_str().unwrap_or(""),
                    ));
                    if let Some(files) = c["files"].as_array() {
                        body =
                            body.children(files.iter().filter_map(|p| p.as_str()).enumerate().map(
                                |(i, path)| {
                                    let path = path.to_string();
                                    let review = self.review.clone();
                                    Button::new(SharedString::from(format!("guide-file-{i}")))
                                        .ghost()
                                        .w_full()
                                        .child(
                                            div()
                                                .w_full()
                                                .text_left()
                                                .truncate()
                                                .child(path.clone()),
                                        )
                                        .on_click(move |_, window, cx| {
                                            review.update(cx, |r, cx| {
                                                r.open_diff(path.clone(), window, cx)
                                            })
                                        })
                                },
                            ));
                    }
                }
            }
        } else if live && !self.loading && self.error.is_none() {
            body=body.child("Create a guide to explain this branch with chapters, linked files and comparisons.");
        }
        body
    }
}
