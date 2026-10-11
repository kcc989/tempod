//! All files tab (04): a `Tree` from `listFiles`; file tabs use a read-only `Editor` (07). Built in M3.
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, Role,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};

#[derive(IntoElement, Default)]
pub struct FilesPanel;

impl RenderOnce for FilesPanel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id("files-panel")
            .role(Role::Group)
            .aria_label("All files")
            .size_full()
            .child(super::skeleton_rows(4))
    }
}
