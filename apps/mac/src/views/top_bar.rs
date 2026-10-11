//! Top bar (04, Top bar): title, branch and `→ <base branch>`, the container pill and exactly one
//! primary git action. GPUI Kit `Toolbar`, `Button`, `Badge` and `Tooltip` in M2 (07).
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Sizable as _, h_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div, px,
};

#[derive(IntoElement, Clone)]
pub struct TopBar {
    pub title: SharedString,
    pub branch: SharedString,
    pub base_branch: SharedString,
    /// The container pill text from 04's table, for example `Running · standard`.
    pub pill: SharedString,
    /// The primary action from 04's table, for example `Commit and push`.
    pub primary: Option<SharedString>,
}

impl RenderOnce for TopBar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        h_flex()
            .h(px(40.))
            .px_3()
            .gap_2()
            .border_b_1()
            .border_color(color(Token::Border, cx))
            .child(
                div()
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child(self.title),
            )
            .child(div().text_color(muted).child(self.branch))
            .child(
                div()
                    .text_color(muted)
                    .child(format!("→ {}", self.base_branch)),
            )
            .child(div().flex_1())
            .child(div().text_color(muted).child(self.pill))
            .when_some(self.primary, |bar, label| {
                bar.child(Button::new("primary-action").primary().small().label(label))
            })
    }
}
