//! Sidebar (04, Sidebar): Pinned, then one section per project, then a `History` link. GPUI Kit
//! `Sidebar`; workspace rows become custom rows with the status icon in M1 (07).
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::hover_card::HoverCard;
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use gpui_kit::component::sidebar::Sidebar;
use gpui_kit::component::{WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};
use std::rc::Rc;
use tempo_protocol::{self as p, api};

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
    pub summary: Option<p::WorkspaceSummary>,
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
                .child(
                    Button::new("add-project")
                        .primary()
                        .label("Add project")
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(crate::actions::AddProject), cx)
                        }),
                )
                .into_any_element();
        }
        let active = self.active.clone();
        let groups = self.sections.into_iter().map(|section| {
            let select = self.on_select.clone();
            let active = active.clone();
            let label = section.label.clone();
            let rows = section.rows;
            let renderer = Rc::new(move |_: &mut Window, cx: &mut App| {
                let app = crate::app::AppState::try_global(cx);
                let project = app.as_ref().and_then(|a| {
                    a.read(cx)
                        .hub
                        .read(cx)
                        .projects
                        .iter()
                        .find(|p| format!("{}/{}", p.owner, p.name) == label.as_ref())
                        .cloned()
                });
                let collapsed = project.as_ref().is_some_and(|p| {
                    app.as_ref()
                        .is_some_and(|a| a.read(cx).collapsed_projects.contains(&p.id))
                });
                let items = rows.clone().into_iter().map(|row| {
                    let on_select = select.clone();
                    let id = row.id.clone();
                    if let Some(summary) = row.summary {
                        let select = select.clone();
                        let workspace_id = id.clone();
                        let menu_summary = summary.clone();
                        let hover_summary = summary.clone();
                        let (icon, tooltip) = indicator(&summary);
                        let bold = matches!(
                            summary.attention,
                            p::Attention::Unread | p::Attention::NeedsInput
                        );
                        let title = if bold {
                            div()
                                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                .child(row.title.clone())
                        } else {
                            div().child(row.title.clone())
                        };
                        let status_color = match summary.attention {
                            p::Attention::Error => Token::Destructive,
                            p::Attention::NeedsInput => Token::Warning,
                            _ => Token::MutedForeground,
                        };
                        let mut line = h_flex()
                            .gap_1()
                            .child(div().text_color(color(status_color, cx)).child(icon))
                            .child(title);
                        if let Some(number) = summary.pr_number {
                            line = line.child(format!(
                                "#{} {}",
                                number,
                                summary.pr_state.map(|s| s.to_string()).unwrap_or_default()
                            ));
                        }
                        if let Some(checks) = summary.checks_state {
                            line = line.child(format!("· {checks}"));
                        }
                        let mut trigger = div()
                            .id(gpui_kit::ElementId::Name(format!("workspace-{id}").into()))
                            .role(gpui_kit::Role::ListItem)
                            .aria_label(format!("{} · {} · {}", row.title, row.detail, tooltip))
                            .px_3()
                            .py_1()
                            .w_full()
                            .child(line)
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(color(Token::MutedForeground, cx))
                                    .child(row.detail),
                            )
                            .on_click(move |_, window, cx| {
                                if let Some(f) = &select {
                                    f(&workspace_id, window, cx);
                                }
                            });
                        if active.as_ref() == Some(&id) {
                            trigger = trigger.bg(color(Token::Primary, cx).opacity(0.12));
                        }
                        let trigger = trigger.context_menu(move |menu, _, cx| {
                            let summary = menu_summary.clone();
                            let pin = summary.clone();
                            let archive = summary.clone();
                            let copy = summary.branch.clone();
                            let rename = summary.id.clone();
                            let gh = github_url(&summary, cx);
                            menu.item(PopupMenuItem::new("Rename").on_click(
                                move |_, window, cx| {
                                    crate::app::AppState::global(cx).update(cx, |a, cx| {
                                        a.show_workspace(&rename, cx);
                                    });
                                    window.dispatch_action(
                                        Box::new(crate::actions::RenameWorkspace),
                                        cx,
                                    );
                                },
                            ))
                            .item(
                                PopupMenuItem::new(if summary.pinned { "Unpin" } else { "Pin" })
                                    .on_click(move |_, window, cx| {
                                        mutate::<api::SetPinned>(
                                            p::SetPinnedIn {
                                                workspace_id: pin.id.clone(),
                                                pinned: !pin.pinned,
                                            },
                                            window,
                                            cx,
                                        )
                                    }),
                            )
                            .item(PopupMenuItem::new("Copy branch name").on_click(
                                move |_, _, cx| {
                                    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(
                                        copy.clone(),
                                    ))
                                },
                            ))
                            .item(
                                PopupMenuItem::new("Open on GitHub").on_click(move |_, _, cx| {
                                    if let Some(url) = &gh {
                                        cx.open_url(url);
                                    }
                                }),
                            )
                            .item(
                                PopupMenuItem::new("Archive").on_click(move |_, window, cx| {
                                    mutate::<api::ArchiveWorkspace>(
                                        p::ArchiveWorkspaceIn {
                                            workspace_id: archive.id.clone(),
                                        },
                                        window,
                                        cx,
                                    )
                                }),
                            )
                        });
                        HoverCard::new(gpui_kit::ElementId::Name(format!("hover-{id}").into()))
                            .open_delay(std::time::Duration::from_millis(400))
                            .trigger(trigger)
                            .content(move |_, _, _| {
                                let wake = hover_summary.id.clone();
                                let archive = hover_summary.id.clone();
                                let sleeping = hover_summary.state == p::WorkspaceState::Sleeping;
                                v_flex()
                                    .gap_2()
                                    .child(tooltip)
                                    .child(format!(
                                        "{} · Last activity {}",
                                        hover_summary.state, hover_summary.last_activity_at
                                    ))
                                    .child(
                                        Button::new("wake-sleep-hover")
                                            .label(if sleeping { "Wake" } else { "Sleep" })
                                            .on_click(move |_, window, cx| {
                                                if sleeping {
                                                    mutate::<api::WakeWorkspace>(
                                                        p::WakeWorkspaceIn {
                                                            workspace_id: wake.clone(),
                                                        },
                                                        window,
                                                        cx,
                                                    )
                                                } else {
                                                    mutate::<api::SleepWorkspace>(
                                                        p::SleepWorkspaceIn {
                                                            workspace_id: wake.clone(),
                                                        },
                                                        window,
                                                        cx,
                                                    )
                                                }
                                            }),
                                    )
                                    .child(Button::new("archive-hover").label("Archive").on_click(
                                        move |_, window, cx| {
                                            mutate::<api::ArchiveWorkspace>(
                                                p::ArchiveWorkspaceIn {
                                                    workspace_id: archive.clone(),
                                                },
                                                window,
                                                cx,
                                            )
                                        },
                                    ))
                            })
                            .into_any_element()
                    } else {
                        div()
                            .id(id.clone())
                            .p_2()
                            .child(row.title)
                            .child(row.detail)
                            .on_click(move |_, window, cx| {
                                if let Some(f) = &on_select {
                                    f(&id, window, cx);
                                }
                            })
                            .into_any_element()
                    }
                });
                let header = if let Some(project) = project {
                    let toggle_id = project.id.clone();
                    h_flex()
                        .gap_1()
                        .child(
                            Button::new(SharedString::from(format!("collapse-{}", project.id)))
                                .ghost()
                                .label(format!("{} {}", if collapsed { "▸" } else { "▾" }, label))
                                .on_click(move |_, _, cx| {
                                    if let Some(app) = crate::app::AppState::try_global(cx) {
                                        app.update(cx, |a, cx| {
                                            if !a.collapsed_projects.remove(&toggle_id) {
                                                a.collapsed_projects.insert(toggle_id.clone());
                                            }
                                            cx.notify();
                                        });
                                    }
                                }),
                        )
                        .child(
                            Button::new(SharedString::from(format!("new-in-{}", project.id)))
                                .ghost()
                                .label("+")
                                .accessibility_label("New workspace in this project")
                                .on_click(move |_, window, cx| {
                                    window.dispatch_action(
                                        Box::new(crate::actions::NewWorkspaceForProject(
                                            project.id.clone(),
                                        )),
                                        cx,
                                    )
                                }),
                        )
                        .into_any_element()
                } else {
                    div()
                        .p_2()
                        .text_sm()
                        .child(label.clone())
                        .into_any_element()
                };
                let body = if collapsed {
                    div().into_any_element()
                } else {
                    v_flex().children(items).into_any_element()
                };
                v_flex().child(header).child(body).into_any_element()
            });
            SidebarRows(renderer)
        });
        Sidebar::new("sidebar")
            .collapsible(false)
            .w_full()
            .children(groups)
            .footer(
                v_flex()
                    .child(
                        Button::new("new-workspace-sidebar")
                            .ghost()
                            .label("New workspace")
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(crate::actions::NewWorkspace), cx)
                            }),
                    )
                    .child(
                        Button::new("add-project-sidebar")
                            .ghost()
                            .label("Add project")
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(crate::actions::AddProject), cx)
                            }),
                    )
                    .child(Button::new("history").ghost().label("History").on_click(
                        |_, window, cx| {
                            window.dispatch_action(Box::new(crate::actions::ShowHistory), cx)
                        },
                    ))
                    .child(
                        Button::new("sidebar-sort")
                            .ghost()
                            .label("Sort: activity / created")
                            .on_click(|_, _, cx| {
                                cx.global_mut::<crate::storage::Local>().update_state(|s| {
                                    s.sort = if s.sort == crate::storage::SortMode::Activity {
                                        crate::storage::SortMode::Created
                                    } else {
                                        crate::storage::SortMode::Activity
                                    }
                                });
                                cx.refresh_windows();
                            }),
                    ),
            )
            .into_any_element()
    }
}

fn indicator(w: &p::WorkspaceSummary) -> (&'static str, &'static str) {
    match (w.attention, w.state) {
        (p::Attention::NeedsInput, _) => ("?", "Waiting for you"),
        (p::Attention::Error, _) => ("!", "Needs attention"),
        (_, p::WorkspaceState::Working) => ("◌", "Working"),
        (p::Attention::Unread, _) => ("●", "New activity"),
        (_, p::WorkspaceState::Sleeping) => ("☾", "Sleeping"),
        (
            _,
            p::WorkspaceState::Creating
            | p::WorkspaceState::Starting
            | p::WorkspaceState::SettingUp
            | p::WorkspaceState::Stopping,
        ) => ("◌", "Starting"),
        _ => ("", "Ready"),
    }
}
fn github_url(w: &p::WorkspaceSummary, cx: &App) -> Option<String> {
    let app = crate::app::AppState::try_global(cx)?;
    let project = app
        .read(cx)
        .hub
        .read(cx)
        .projects
        .iter()
        .find(|p| p.id == w.project_id)?;
    Some(if let Some(number) = w.pr_number {
        format!(
            "https://github.com/{}/{}/pull/{number}",
            project.owner, project.name
        )
    } else {
        format!("https://github.com/{}/{}", project.owner, project.name)
    })
}
fn mutate<F: p::Function>(input: F::Input, window: &mut Window, cx: &mut App) {
    let Some(client) = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client())
    else {
        return;
    };
    let archived = (F::NAME == "archiveWorkspace")
        .then(|| {
            serde_json::to_value(&input)
                .ok()
                .and_then(|v| v["workspaceId"].as_str().map(ToOwned::to_owned))
        })
        .flatten();
    let request = client.call::<F>(input);
    let handle = window.window_handle();
    cx.spawn(async move |cx| match request.await {
        Ok(_) => {
            if let Some(id) = archived {
                let _ = handle.update(cx, |_, window, cx| archive_undo(id, window, cx));
            }
        }
        Err(e) => {
            let _ = handle.update(cx, |_, window, cx| {
                window.push_notification(
                    gpui_kit::component::notification::Notification::error(e.to_string()),
                    cx,
                )
            });
        }
    })
    .detach();
}
struct ArchiveUndo;
pub fn archive_undo(id: String, window: &mut Window, cx: &mut App) {
    let key = SharedString::from(id.clone());
    window.push_notification(
        gpui_kit::component::notification::Notification::new()
            .id1::<ArchiveUndo>(key.clone())
            .message("Workspace archived")
            .action(move |_, _, _| {
                let id = id.clone();
                Button::new("undo-archive")
                    .label("Undo")
                    .on_click(move |_, window, cx| {
                        mutate::<api::RestoreWorkspace>(
                            p::RestoreWorkspaceIn {
                                workspace_id: id.clone(),
                            },
                            window,
                            cx,
                        )
                    })
            }),
        cx,
    );
    let handle = window.window_handle();
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(std::time::Duration::from_secs(8))
            .await;
        let _ = handle.update(cx, |_, window, cx| {
            window.remove_notification1::<ArchiveUndo>(key, cx)
        });
    })
    .detach();
}

type SidebarRenderer = Rc<dyn Fn(&mut Window, &mut App) -> gpui_kit::AnyElement>;
#[derive(Clone)]
struct SidebarRows(SidebarRenderer);
impl gpui_kit::component::Collapsible for SidebarRows {
    fn collapsed(self, _: bool) -> Self {
        self
    }
    fn is_collapsed(&self) -> bool {
        false
    }
}
impl gpui_kit::component::sidebar::SidebarItem for SidebarRows {
    fn render(
        self,
        _: impl Into<gpui_kit::ElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> impl IntoElement {
        (self.0)(window, cx)
    }
}
