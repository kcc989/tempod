//! Diff tab (04): the custom `DiffView` on `VirtualList` (07, Changes, diff view and review comments), in the `Diff` key context. Built in M3.
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, Role,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};

#[derive(IntoElement, Default)]
pub struct DiffView;

impl RenderOnce for DiffView {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id("diff-view")
            .role(Role::Group)
            .aria_label("Diff")
            .size_full()
            .child(super::skeleton_rows(4))
    }
}
