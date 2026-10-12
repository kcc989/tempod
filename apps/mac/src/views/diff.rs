use super::diff_model::{DiffLine, LineKind, ParsedDiff, SplitRow};
use super::tokens::{Token, color};
use crate::storage::{DiffViewMode, Local};
use gpui_kit::component::button::Button;
use gpui_kit::component::{h_flex, v_flex, v_virtual_list};
use gpui_kit::{
    Context, EventEmitter, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px, size,
};
use std::rc::Rc;
use tempo_protocol::ReviewSide;

#[derive(Clone, Debug)]
pub enum DiffEvent {
    Comment {
        start: Option<u32>,
        end: Option<u32>,
        side: Option<ReviewSide>,
    },
    OpenFile,
    Close,
}
impl EventEmitter<DiffEvent> for DiffView {}

pub struct DiffView {
    pub workspace_id: String,
    pub path: String,
    pub parsed: ParsedDiff,
    split: Vec<SplitRow>,
    focus: gpui_kit::FocusHandle,
    selection: Option<(ReviewSide, u32)>,
    selection_end: u32,
    dragging: bool,
}
impl DiffView {
    pub fn new(
        workspace_id: String,
        path: String,
        mut parsed: ParsedDiff,
        cx: &mut Context<Self>,
    ) -> Self {
        let split = std::mem::take(&mut parsed.split);
        Self {
            workspace_id,
            path,
            parsed,
            split,
            focus: cx.focus_handle(),
            selection: None,
            selection_end: 0,
            dragging: false,
        }
    }
    pub fn mark_viewed(&mut self, cx: &mut Context<Self>) {
        let viewed = cx.global::<Local>().state().is_viewed(
            &self.workspace_id,
            &self.path,
            &self.parsed.hash,
        );
        cx.global_mut::<Local>().update_state(|s| {
            s.set_viewed(&self.workspace_id, &self.path, &self.parsed.hash, !viewed)
        });
        cx.notify();
    }
    fn line(
        &self,
        line: &DiffLine,
        side: Option<ReviewSide>,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let token = match line.kind {
            LineKind::Added => Token::Success,
            LineKind::Removed => Token::Destructive,
            _ => Token::Foreground,
        };
        let old = line.old.map(|n| n.to_string()).unwrap_or_default();
        let new = line.new.map(|n| n.to_string()).unwrap_or_default();
        let mut row = h_flex().h(px(22.)).text_color(color(token, cx));
        if matches!(line.kind, LineKind::Added | LineKind::Removed) {
            row = row.bg(color(token, cx).opacity(0.10));
        }
        if line.kind == LineKind::Header {
            row = row.border_b_1().border_color(color(Token::Border, cx));
        }
        if let Some((selected_side, start)) = self.selection {
            let number = if selected_side == ReviewSide::Old {
                line.old
            } else {
                line.new
            };
            if side.is_none_or(|s| s == selected_side)
                && number.is_some_and(|n| {
                    (start.min(self.selection_end)..=start.max(self.selection_end)).contains(&n)
                })
            {
                row = row.bg(color(Token::Primary, cx).opacity(0.16));
            }
        }
        for (label, number, gutter_side) in [
            (old, line.old, ReviewSide::Old),
            (new, line.new, ReviewSide::New),
        ] {
            if side.is_some_and(|s| s != gutter_side) {
                continue;
            }
            if number.is_none() {
                row = row.child(div().w(px(48.)).child(label));
                continue;
            }
            let id: SharedString = format!("{}-{:?}-{number:?}", self.path, gutter_side).into();
            row = row.child(
                div()
                    .id(id)
                    .role(gpui_kit::Role::Button)
                    .aria_label(format!(
                        "Comment on {} line {}",
                        gutter_side,
                        number.unwrap_or_default()
                    ))
                    .w(px(48.))
                    .text_color(color(Token::MutedForeground, cx))
                    .child(label)
                    .on_mouse_down(
                        gpui_kit::MouseButton::Left,
                        cx.listener(move |this, event: &gpui_kit::MouseDownEvent, _, cx| {
                            if let Some(n) = number {
                                let start = if event.modifiers.shift {
                                    this.selection
                                        .filter(|(s, _)| *s == gutter_side)
                                        .map(|(_, n)| n)
                                        .unwrap_or(n)
                                } else {
                                    n
                                };
                                this.selection = Some((gutter_side, start));
                                this.selection_end = n;
                                this.dragging = true;
                                cx.notify();
                            }
                        }),
                    )
                    .on_mouse_move(cx.listener(
                        move |this, event: &gpui_kit::MouseMoveEvent, _, cx| {
                            if this.dragging
                                && event.pressed_button == Some(gpui_kit::MouseButton::Left)
                                && this.selection.is_some_and(|(s, _)| s == gutter_side)
                                && let Some(n) = number
                            {
                                this.selection_end = n;
                                cx.notify();
                            }
                        },
                    ))
                    .on_mouse_up(
                        gpui_kit::MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            if this.dragging {
                                this.dragging = false;
                                if let Some((side, start)) = this.selection {
                                    cx.emit(DiffEvent::Comment {
                                        start: Some(start.min(this.selection_end)),
                                        end: Some(start.max(this.selection_end)),
                                        side: Some(side),
                                    });
                                }
                            }
                        }),
                    ),
            );
        }
        row.child(div().flex_1().whitespace_nowrap().child(line.text.clone()))
            .into_any_element()
    }
}
impl Render for DiffView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let split = f32::from(window.viewport_size().width) >= 1024.
            && cx.global::<Local>().state().diff_view == DiffViewMode::Split;
        let viewed = cx.global::<Local>().state().is_viewed(
            &self.workspace_id,
            &self.path,
            &self.parsed.hash,
        );
        let count = if split {
            self.split.len()
        } else {
            self.parsed.lines.len()
        };
        let sizes = Rc::new(vec![size(px(100.), px(22.)); count]);
        let body = if self.parsed.too_large {
            v_flex()
                .p_4()
                .child("This diff is too large to show.")
                .child(
                    Button::new("open-large-file")
                        .label("Open file")
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(DiffEvent::OpenFile))),
                )
                .into_any_element()
        } else if count == 0 {
            div()
                .p_4()
                .child("No changes in this file.")
                .into_any_element()
        } else {
            v_virtual_list(
                cx.entity(),
                "diff-lines",
                sizes,
                move |this, range, _, cx| {
                    range
                        .map(|ix| {
                            if split {
                                let row = this.split[ix].clone();
                                h_flex()
                                    .h(px(22.))
                                    .child(div().w_1_2().overflow_hidden().children(
                                        row.left.map(|l| this.line(&l, Some(ReviewSide::Old), cx)),
                                    ))
                                    .child(div().w_1_2().overflow_hidden().children(
                                        row.right.map(|l| this.line(&l, Some(ReviewSide::New), cx)),
                                    ))
                                    .into_any_element()
                            } else {
                                this.line(&this.parsed.lines[ix].clone(), None, cx)
                            }
                        })
                        .collect()
                },
            )
            .size_full()
            .into_any_element()
        };
        v_flex()
            .id("diff-view")
            .role(gpui_kit::Role::Document)
            .aria_label(format!("Diff for {}", self.path))
            .size_full()
            .key_context(crate::keymap::DIFF)
            .track_focus(&self.focus)
            .on_mouse_down(
                gpui_kit::MouseButton::Left,
                cx.listener(|this, _, window, cx| window.focus(&this.focus, cx)),
            )
            .on_action(
                cx.listener(|this, _: &crate::actions::MarkFileViewed, _, cx| this.mark_viewed(cx)),
            )
            .child(
                h_flex()
                    .gap_2()
                    .p_2()
                    .child(self.path.clone())
                    .child(
                        Button::new("diff-mode")
                            .label(if split { "Unified" } else { "Split" })
                            .on_click(cx.listener(|_, _, _, cx| {
                                cx.global_mut::<Local>().update_state(|s| {
                                    s.diff_view = if s.diff_view == DiffViewMode::Split {
                                        DiffViewMode::Unified
                                    } else {
                                        DiffViewMode::Split
                                    }
                                });
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("viewed")
                            .label(if viewed {
                                "Viewed ✓"
                            } else {
                                "Mark as viewed"
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.mark_viewed(cx))),
                    )
                    .child(
                        Button::new("file-comment")
                            .label("Comment")
                            .on_click(cx.listener(|_, _, _, cx| {
                                cx.emit(DiffEvent::Comment {
                                    start: None,
                                    end: None,
                                    side: None,
                                })
                            })),
                    )
                    .child(
                        Button::new("close-diff")
                            .label("Close")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(DiffEvent::Close))),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .font_family("monospace")
                    .child(body),
            )
    }
}
