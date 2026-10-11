//! Terminal tab (04, bottom panel): tabs `t1` to `t9` and `+`, drawn by `tempo-terminal` in the `Terminal` key context (07). Built in M4.
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, Role,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};

#[derive(IntoElement, Default)]
pub struct TerminalPanel;

impl RenderOnce for TerminalPanel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id("terminal-panel")
            .role(Role::Group)
            .aria_label("Terminal")
            .size_full()
            .child(super::skeleton_rows(4))
    }
}
