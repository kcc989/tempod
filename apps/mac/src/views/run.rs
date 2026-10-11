//! Run tab (04, bottom panel): run scripts, Start and Stop, live output; ⌘R toggles the default script (07). Built in M4.
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, Role,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};

#[derive(IntoElement, Default)]
pub struct RunPanel;

impl RenderOnce for RunPanel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id("run-panel")
            .role(Role::Group)
            .aria_label("Run")
            .size_full()
            .child(super::skeleton_rows(4))
    }
}
