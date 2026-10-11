//! Sidebar (04, Sidebar): Pinned, then one section per project, then a `History` link. GPUI Kit
//! `Sidebar`; workspace rows become custom rows with the status icon in M1 (07).
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::sidebar::{Sidebar, SidebarGroup, SidebarMenu, SidebarMenuItem};
use gpui_kit::component::v_flex;
use gpui_kit::{
    App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window,
};
use std::rc::Rc;

/// Width in px (04): 280 by default, 220 to 400.
pub const DEFAULT_WIDTH: f32 = 280.;
pub const MIN_WIDTH: f32 = 220.;
pub const MAX_WIDTH: f32 = 400.;

#[derive(Clone, Debug)]
pub struct SidebarRow {
    pub id: SharedString,
    pub title: SharedString,
    /// Line 2: the branch, then `·`, then the slug.
    pub detail: SharedString,
}

#[derive(Clone, Debug)]
pub struct SidebarSection {
    pub label: SharedString,
    pub rows: Vec<SidebarRow>,
}

type OnSelect = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct WorkspaceSidebar {
    sections: Vec<SidebarSection>,
    active: Option<SharedString>,
    on_select: Option<OnSelect>,
}

impl WorkspaceSidebar {
    pub fn new(sections: Vec<SidebarSection>) -> Self {
        Self {
            sections,
            active: None,
            on_select: None,
        }
    }

    pub fn active(mut self, id: Option<SharedString>) -> Self {
        self.active = id;
        self
    }

    pub fn on_select(mut self, f: impl Fn(&SharedString, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for WorkspaceSidebar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        if self.sections.is_empty() {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_3()
                .text_color(color(Token::MutedForeground, cx))
                .child("Link a repo to start.")
                .child(Button::new("add-project").primary().label("Add project"))
                .into_any_element();
        }
        let active = self.active.clone();
        let groups = self.sections.into_iter().map(|section| {
            let items = section.rows.into_iter().map(|row| {
                let on_select = self.on_select.clone();
                let id = row.id.clone();
                SidebarMenuItem::new(row.title)
                    .active(active.as_ref() == Some(&row.id))
                    .on_click(move |_, window, cx| {
                        if let Some(f) = &on_select {
                            f(&id, window, cx);
                        }
                    })
            });
            SidebarGroup::new(section.label).child(SidebarMenu::new().children(items))
        });
        Sidebar::new("sidebar")
            .collapsible(false)
            .w_full()
            .children(groups)
            .footer(Button::new("history").ghost().label("History"))
            .into_any_element()
    }
}
