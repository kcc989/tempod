//! Checks tab (04): PR and one row per check run, on a `VirtualList` (07). Built in M3.
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, Role,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};

#[derive(IntoElement, Default)]
pub struct ChecksPanel;

impl RenderOnce for ChecksPanel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id("checks-panel")
            .role(Role::Group)
            .aria_label("Checks")
            .size_full()
            .child(super::skeleton_rows(4))
    }
}
