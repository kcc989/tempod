use gpui_kit::component::IndexPath;
use gpui_kit::component::list::{ListDelegate, ListItem, ListState};
use gpui_kit::{App, Context, IntoElement, ParentElement as _, Styled as _, Window, div};

#[derive(Default)]
pub struct FilePicker {
    pub paths: Vec<String>,
    pub status: String,
    selected: Option<IndexPath>,
}
impl ListDelegate for FilePicker {
    type Item = ListItem;
    fn items_count(&self, _: usize, _: &App) -> usize {
        self.paths.len()
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Option<Self::Item> {
        self.paths.get(ix.row).map(|path| {
            ListItem::new(ix).accessibility_label(path.clone()).child(
                div().min_w_0().truncate().child(if path.starts_with("@") {
                    format!("Roles · {path}")
                } else {
                    path.clone()
                }),
            )
        })
    }
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix;
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div().child(self.status.clone())
    }
}

#[derive(gpui_kit::IntoElement)]
pub struct MentionTrigger(pub gpui_kit::Div);
impl gpui_kit::component::Selectable for MentionTrigger {
    fn is_selected(&self) -> bool {
        false
    }
    fn selected(self, _: bool) -> Self {
        self
    }
}
impl gpui_kit::RenderOnce for MentionTrigger {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        self.0
    }
}
