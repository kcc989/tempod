//! Setup tab (04, bottom panel): status, output from `script.output` in a custom monospace log view on `VirtualList` (07). Built in M4.
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, Role,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};

#[derive(IntoElement, Default)]
pub struct SetupPanel;

impl RenderOnce for SetupPanel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id("setup-panel")
            .role(Role::Group)
            .aria_label("Setup")
            .size_full()
            .child(super::skeleton_rows(4))
    }
}
