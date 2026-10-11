//! Changes tab (04, Right and bottom panels): file list from `getChanges` on a `VirtualList` with `Badge` and `Tag` (07). Built in M3.
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, Role,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};

#[derive(IntoElement, Default)]
pub struct ChangesPanel;

impl RenderOnce for ChangesPanel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id("changes-panel")
            .role(Role::Group)
            .aria_label("Changes")
            .size_full()
            .child(super::skeleton_rows(4))
    }
}
