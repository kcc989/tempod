use super::tokens::{Token, color};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::select::{Select, SelectItem, SelectState};
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    App, Div, Entity, IntoElement, ParentElement as _, SharedString, Styled as _, Window, div, px,
};

pub(crate) const COMPOSER_WIDTH: f32 = 792.;
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Choice {
    pub value: String,
    pub label: SharedString,
    pub trigger_label: Option<SharedString>,
}
impl SelectItem for Choice {
    type Value = String;
    fn title(&self) -> SharedString {
        self.trigger_label
            .clone()
            .unwrap_or_else(|| self.label.clone())
    }
    fn render(&self, _: &mut Window, _: &mut gpui_kit::App) -> impl IntoElement {
        div().py_1().child(self.label.clone())
    }
    fn value(&self) -> &String {
        &self.value
    }
}
pub(crate) type Picker = SelectState<Vec<Choice>>;

pub(crate) fn surface(cx: &App) -> Div {
    v_flex()
        .w_full()
        .p_3()
        .gap_2()
        .rounded(px(16.))
        .shadow_md()
        .border_1()
        .border_color(color(Token::Input, cx))
        .bg(color(Token::Muted, cx))
}
pub(crate) fn input(state: &Entity<TextareaState>, label: &'static str) -> Textarea {
    Textarea::new(state)
        .aria_label(label)
        .appearance(false)
        .bordered(false)
}
pub(crate) fn toolbar() -> Div {
    h_flex().items_center().flex_wrap().gap_2()
}
pub(crate) fn model_picker(
    state: &Entity<Picker>,
    choices: &[Choice],
    placeholder: &'static str,
    disabled: bool,
    cx: &App,
) -> impl IntoElement {
    let width = choices
        .iter()
        .find(|choice| state.read(cx).selected_value() == Some(&choice.value))
        .map(|choice| (choice.title().chars().count() as f32 * 7. + 34.).clamp(64., 220.))
        .unwrap_or(120.);
    div().w(px(width)).flex_shrink_0().child(
        Select::new(state)
            .menu_width(px(320.))
            .search_placeholder("Search models")
            .icon(
                Icon::new(IconName::ChevronDown)
                    .size(px(12.))
                    .text_color(color(Token::MutedForeground, cx)),
            )
            .w_full()
            .large()
            .h(px(28.))
            .py_0()
            .text_sm()
            .appearance(false)
            .accessibility_label("Model")
            .placeholder(placeholder)
            .disabled(disabled),
    )
}
