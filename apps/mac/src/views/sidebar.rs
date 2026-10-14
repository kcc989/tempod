//! Sidebar (04, Sidebar and Indicators; 07): Pinned, then one section per project, then
//! `History`. GPUI Kit `Sidebar` with custom rows, a `HoverCard`, a `Menu` on right-click, a `Tag`
//! for the PR and a `Spinner`.
use super::indicators::{self as ind, IndicatorKind};
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::hover_card::HoverCard;
use gpui_kit::component::menu::{ContextMenuExt as _, DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::sidebar::Sidebar;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{
    Disableable as _, Icon, IconName, Sizable as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, Context, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Task,
    TestSupportExt as _, Window, div, px,
};
use std::collections::BTreeSet;
use std::rc::Rc;
use tempo_client::state::hub;
use tempo_protocol::{self as p, api};

/// Width in px (04): 280 by default, 220 to 400.
pub const DEFAULT_WIDTH: f32 = 280.;
pub const MIN_WIDTH: f32 = 220.;
pub const MAX_WIDTH: f32 = 400.;

/// 04: the hover card opens after 400 ms.
const HOVER_DELAY: std::time::Duration = std::time::Duration::from_millis(400);

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

/// A section as drawn. `key` is `pinned` or the project id, as the web's collapsed list.
#[derive(Clone, Debug)]
struct Section {
    key: String,
    project_id: Option<String>,
    label: SharedString,
    rows: Vec<SidebarRow>,
}

pub fn sort_mode(cx: &App) -> hub::SortMode {
    match cx.global::<crate::storage::Local>().state().sort {
        crate::storage::SortMode::Created => hub::SortMode::Created,
        crate::storage::SortMode::Activity => hub::SortMode::Activity,
    }
}

fn set_sort(sort: crate::storage::SortMode, cx: &mut App) {
    cx.global_mut::<crate::storage::Local>()
        .update_state(|s| s.sort = sort);
    cx.refresh_windows();
}

/// Rows in sidebar order, leaving out collapsed sections. ⌘1–⌘9 and ⌘⌥↑/⌘⌥↓ follow it.
pub fn visible_order(
    sections: &[hub::SidebarSection],
    collapsed: &BTreeSet<String>,
) -> Vec<p::WorkspaceSummary> {
    sections
        .iter()
        .filter(|s| !collapsed.contains(&s.key))
        .flat_map(|s| s.workspaces.iter().cloned())
        .collect()
}

/// Every row in sidebar order, collapsed sections included.
pub fn full_order(sections: &[hub::SidebarSection]) -> Vec<p::WorkspaceSummary> {
    sections
        .iter()
        .flat_map(|s| s.workspaces.iter().cloned())
        .collect()
}

/// ⌘⌥↓ / ⌘⌥↑: the next or previous id, wrapping. With no current row, the first or the last.
pub fn step_workspace(ids: &[String], current: Option<&str>, forward: bool) -> Option<String> {
    if ids.is_empty() {
        return None;
    }
    let Some(ix) = current.and_then(|c| ids.iter().position(|id| id == c)) else {
        return if forward { ids.first() } else { ids.last() }.cloned();
    };
    let n = ids.len();
    Some(
        ids[if forward {
            (ix + 1) % n
        } else {
            (ix + n - 1) % n
        }]
        .clone(),
    )
}

fn needs_you_rank(attention: p::Attention) -> u8 {
    match attention {
        p::Attention::NeedsInput | p::Attention::Error => 2,
        p::Attention::Unread => 1,
        p::Attention::None => 0,
    }
}

/// ⌘⌥L: the next row after the current one (wrapping) that needs you. Waiting for input and
/// errors come before unread activity.
pub fn next_needing_you(order: &[p::WorkspaceSummary], current: Option<&str>) -> Option<String> {
    let best = order
        .iter()
        .filter(|w| Some(w.id.as_str()) != current)
        .map(|w| needs_you_rank(w.attention))
        .max()
        .unwrap_or(0);
    if best == 0 {
        return None;
    }
    let n = order.len();
    let start = current
        .and_then(|c| order.iter().position(|w| w.id == c))
        .map_or(n - 1, |ix| ix);
    (1..=n)
        .map(|k| &order[(start + k) % n])
        .find(|w| Some(w.id.as_str()) != current && needs_you_rank(w.attention) == best)
        .map(|w| w.id.clone())
}

pub struct Order {
    pub visible: Vec<p::WorkspaceSummary>,
    pub all: Vec<p::WorkspaceSummary>,
}

/// The workspaces in sidebar order: the same sort and collapsed sections as the sidebar.
pub fn order(cx: &App) -> Order {
    let Some(app) = crate::app::AppState::try_global(cx) else {
        return Order {
            visible: vec![],
            all: vec![],
        };
    };
    let app = app.read(cx);
    let hub = app.hub.read(cx);
    let sections = hub::sidebar_sections(&hub.state.workspaces, &hub.projects, sort_mode(cx));
    Order {
        visible: visible_order(&sections, &app.collapsed_sections),
        all: full_order(&sections),
    }
}

type OnSelect = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct WorkspaceSidebar {
    sections: Vec<Section>,
    active: Option<SharedString>,
    on_select: Option<OnSelect>,
}

impl WorkspaceSidebar {
    pub fn new(sections: Vec<SidebarSection>) -> Self {
        Self {
            sections: sections
                .into_iter()
                .map(|s| Section {
                    key: s.label.to_string(),
                    project_id: None,
                    label: s.label,
                    rows: s.rows,
                })
                .collect(),
            active: None,
            on_select: None,
        }
    }

    /// The live sidebar from the hub store, in the chosen sort.
    pub fn from_hub(cx: &App) -> Self {
        let Some(app) = crate::app::AppState::try_global(cx) else {
            return Self::new(vec![]);
        };
        let hub = app.read(cx).hub.read(cx);
        let sections = hub::sidebar_sections(&hub.state.workspaces, &hub.projects, sort_mode(cx))
            .into_iter()
            .map(|section| Section {
                label: match &section.project_id {
                    Some(id) => hub
                        .projects
                        .iter()
                        .find(|p| &p.id == id)
                        .map(|p| format!("{}/{}", p.owner, p.name))
                        .unwrap_or_else(|| "Project".into())
                        .into(),
                    None => "Pinned".into(),
                },
                key: section.key,
                project_id: section.project_id,
                rows: section
                    .workspaces
                    .into_iter()
                    .map(|w| SidebarRow {
                        id: w.id.clone().into(),
                        title: w.title.clone().into(),
                        detail: format!("{} · {}", w.branch, w.slug).into(),
                        summary: Some(w),
                    })
                    .collect(),
            })
            .collect();
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

fn header(cx: &App) -> impl IntoElement {
    let sort = cx.global::<crate::storage::Local>().state().sort;
    let label = match sort {
        crate::storage::SortMode::Activity => "Last activity",
        crate::storage::SortMode::Created => "Created",
    };
    h_flex()
        .h(px(36.))
        .pl_3()
        .pr_2()
        .gap_1()
        .border_b_1()
        .border_color(color(Token::Border, cx))
        .child(
            div()
                .flex_1()
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_size(px(11.))
                .text_color(color(Token::MutedForeground, cx))
                .child("Projects"),
        )
        .child(
            Button::new("sidebar-sort")
                .ghost()
                .small()
                .icon(IconName::SortAscending)
                .accessibility_label(format!("Sort workspaces: {label}"))
                .tooltip("Sort by")
                .dropdown_menu(move |menu, _, _| {
                    menu.label("Sort by")
                        .item(
                            PopupMenuItem::new("Last activity")
                                .checked(sort == crate::storage::SortMode::Activity)
                                .on_click(|_, _, cx| {
                                    set_sort(crate::storage::SortMode::Activity, cx)
                                }),
                        )
                        .item(
                            PopupMenuItem::new("Created")
                                .checked(sort == crate::storage::SortMode::Created)
                                .on_click(|_, _, cx| {
                                    set_sort(crate::storage::SortMode::Created, cx)
                                }),
                        )
                }),
        )
        .child(
            Button::new("add-project-header")
                .ghost()
                .small()
                .icon(IconName::Folder)
                .accessibility_label("Add project")
                .tooltip("Add project")
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(crate::actions::AddProject), cx)
                }),
        )
}

fn navigation(cx: &App) -> impl IntoElement {
    v_flex()
        .flex_none()
        .p_2()
        .gap_1()
        .border_b_1()
        .border_color(color(Token::Border, cx))
        .child(
            Button::new("sidebar-new-workspace")
                .ghost()
                .small()
                .w_full()
                .accessibility_label("New workspace")
                .child(
                    h_flex()
                        .w_full()
                        .gap_2()
                        .child(Icon::new(IconName::Plus).small())
                        .child("New workspace")
                        .child(
                            div()
                                .ml_auto()
                                .text_xs()
                                .text_color(color(Token::MutedForeground, cx))
                                .child("⌘N"),
                        ),
                )
                .tooltip("New workspace (⌘N)")
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(crate::actions::NewWorkspace), cx)
                }),
        )
        .child(
            Button::new("sidebar-search")
                .ghost()
                .small()
                .w_full()
                .accessibility_label("Search workspaces")
                .child(
                    h_flex()
                        .w_full()
                        .gap_2()
                        .child(Icon::new(IconName::Search).small())
                        .child("Search workspaces")
                        .child(
                            div()
                                .ml_auto()
                                .text_xs()
                                .text_color(color(Token::MutedForeground, cx))
                                .child("⌘K"),
                        ),
                )
                .tooltip("Search workspaces and actions (⌘K)")
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(crate::actions::CommandPalette), cx)
                }),
        )
}

fn footer(cx: &App) -> impl IntoElement {
    h_flex()
        .flex_wrap()
        .flex_none()
        .w_full()
        .px_2()
        .py_2()
        .justify_between()
        .border_t_1()
        .border_color(color(Token::Border, cx))
        .child(
            Button::new("repositories")
                .ghost()
                .small()
                .label("Repositories")
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(crate::actions::ShowRepositories), cx)
                }),
        )
        .child(
            Button::new("history")
                .ghost()
                .small()
                .label("History")
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(crate::actions::ShowHistory), cx)
                }),
        )
        .child(
            Button::new("saved-conversations")
                .ghost()
                .small()
                .label("Saved conversations")
                .on_click(|_, _, cx| {
                    if let Some(state) = crate::app::AppState::try_global(cx)
                        && let Some(origin) = state.read(cx).server_url.clone()
                    {
                        cx.open_url(&format!("{}/history", origin.trim_end_matches('/')));
                    }
                }),
        )
        .child(
            Button::new("sidebar-settings")
                .ghost()
                .small()
                .icon(IconName::Settings)
                .label("Settings")
                .accessibility_label("Settings")
                .tooltip("Settings (⌘,)")
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(crate::actions::OpenSettings), cx)
                }),
        )
}

pub fn shell(content: impl IntoElement, cx: &App) -> AnyElement {
    v_flex()
        .size_full()
        .min_h_0()
        .text_size(px(13.))
        .bg(color(Token::Sidebar, cx))
        .border_r_1()
        .border_color(color(Token::Border, cx))
        .child(navigation(cx))
        .child(header(cx))
        .child(div().flex_1().min_h_0().child(content))
        .child(footer(cx))
        .into_any_element()
}

impl RenderOnce for WorkspaceSidebar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let content = if self.sections.is_empty() {
            v_flex()
                .size_full()
                .p_3()
                .items_center()
                .justify_center()
                .gap_3()
                .text_color(color(Token::MutedForeground, cx))
                .child("Link a repo to start.")
                .child(
                    Button::new("add-project")
                        .primary()
                        .label("Add repository")
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(crate::actions::ShowRepositories), cx)
                        }),
                )
                .into_any_element()
        } else {
            let groups = self.sections.into_iter().map(|section| {
                let select = self.on_select.clone();
                let active = self.active.clone();
                SidebarRows(Rc::new(move |_: &mut Window, cx: &mut App| {
                    render_section(&section, active.as_ref(), select.clone(), cx)
                }))
            });
            Sidebar::new("sidebar")
                .collapsible(false)
                .w_full()
                .h_full()
                .children(groups)
                .into_any_element()
        };
        shell(content, cx)
    }
}

fn render_section(
    section: &Section,
    active: Option<&SharedString>,
    select: Option<OnSelect>,
    cx: &mut App,
) -> AnyElement {
    let collapsed = crate::app::AppState::try_global(cx)
        .is_some_and(|a| a.read(cx).collapsed_sections.contains(&section.key));
    let muted = color(Token::MutedForeground, cx);
    let key = section.key.clone();
    let label = section.label.clone();
    let header = h_flex()
        .h(px(32.))
        .flex_none()
        .gap_1()
        .child(
            h_flex()
                .id(ElementId::Name(format!("section-{key}").into()))
                .role(gpui_kit::Role::Button)
                .aria_label(format!(
                    "{label}, {}",
                    if collapsed { "collapsed" } else { "expanded" }
                ))
                .flex_1()
                .min_w_0()
                .gap_1()
                .px_1()
                .text_size(px(12.))
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(muted)
                .rounded_md()
                .hover(move |style| style.bg(muted.opacity(0.08)))
                .child(
                    Icon::new(if collapsed {
                        IconName::ChevronRight
                    } else {
                        IconName::ChevronDown
                    })
                    .xsmall(),
                )
                .when(section.project_id.is_some(), |this| {
                    this.child(Icon::new(IconName::Folder).small())
                })
                .child(div().flex_1().min_w_0().truncate().child(label.clone()))
                .when(!section.rows.is_empty(), |this| {
                    this.child(section.rows.len().to_string())
                })
                .on_click(move |_, _, cx| {
                    if let Some(app) = crate::app::AppState::try_global(cx) {
                        app.update(cx, |a, cx| {
                            if !a.collapsed_sections.remove(&key) {
                                a.collapsed_sections.insert(key.clone());
                            }
                            cx.notify();
                        });
                    }
                })
                .test_support(),
        )
        .children(section.project_id.clone().map(|project_id| {
            Button::new(SharedString::from(format!("new-in-{project_id}")))
                .ghost()
                .xsmall()
                .icon(IconName::Plus)
                .accessibility_label(format!("New workspace in {label}"))
                .on_click(move |_, window, cx| {
                    window.dispatch_action(
                        Box::new(crate::actions::NewWorkspaceForProject(project_id.clone())),
                        cx,
                    )
                })
        }));
    let body = if collapsed {
        div().into_any_element()
    } else if section.rows.is_empty() {
        match section.project_id.clone() {
            Some(project_id) => Button::new(SharedString::from(format!("start-in-{project_id}")))
                .ghost()
                .small()
                .label("Start a workspace")
                .on_click(move |_, window, cx| {
                    window.dispatch_action(
                        Box::new(crate::actions::NewWorkspaceForProject(project_id.clone())),
                        cx,
                    )
                })
                .into_any_element(),
            None => div().into_any_element(),
        }
    } else {
        v_flex()
            .id(ElementId::Name(format!("rows-{}", section.key).into()))
            .role(gpui_kit::Role::List)
            .aria_label(section.label.clone())
            .children(
                section
                    .rows
                    .iter()
                    .map(|row| render_row(row, active == Some(&row.id), select.clone(), cx)),
            )
            .into_any_element()
    };
    v_flex()
        .w_full()
        .gap_1()
        .pb_2()
        .child(header)
        .child(body)
        .into_any_element()
}

/// The status icon of 04's Indicators table, with its tooltip as the accessible name.
pub fn status_icon(
    id: impl Into<ElementId>,
    indicator: Option<ind::Indicator>,
    cx: &App,
) -> AnyElement {
    let Some(indicator) = indicator else {
        return div().size(px(14.)).flex_none().into_any_element();
    };
    let tint = color(indicator.kind.token(), cx);
    let icon = match indicator.kind {
        IndicatorKind::NeedsInput => div()
            .size(px(13.))
            .rounded_full()
            .border_1()
            .border_color(tint)
            .text_color(tint)
            .text_size(px(9.))
            .font_weight(gpui_kit::FontWeight::BOLD)
            .flex()
            .items_center()
            .justify_center()
            .child("?")
            .into_any_element(),
        IndicatorKind::Error => Icon::new(IconName::CircleAlert)
            .text_color(tint)
            .small()
            .into_any_element(),
        IndicatorKind::Working => Spinner::new().color(tint).small().into_any_element(),
        IndicatorKind::Unread => div()
            .size(px(8.))
            .rounded_full()
            .bg(tint)
            .into_any_element(),
        IndicatorKind::Busy => Spinner::new().color(tint).xsmall().into_any_element(),
        IndicatorKind::Sleeping => Icon::new(IconName::Moon)
            .text_color(tint)
            .small()
            .into_any_element(),
    };
    let tooltip = indicator.tooltip.clone();
    div()
        .id(id.into())
        .role(gpui_kit::Role::Image)
        .aria_label(indicator.tooltip)
        .size(px(14.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
        .child(icon)
        .test_support()
        .into_any_element()
}

/// `#<number>` coloured by `pr_state`.
pub fn pr_badge(
    id: impl Into<ElementId>,
    number: f64,
    state: Option<p::PrState>,
    cx: &App,
) -> AnyElement {
    let tint = color(ind::pr_token(state), cx);
    let label = match state {
        Some(state) => format!(
            "PR #{}, {}",
            number as u64,
            ind::pr_state_label(state).to_lowercase()
        ),
        None => format!("PR #{}", number as u64),
    };
    div()
        .id(id.into())
        .role(gpui_kit::Role::Image)
        .aria_label(label)
        .child(
            Tag::custom(tint.opacity(0.15), tint, tint.opacity(0.))
                .xsmall()
                .child(format!("#{}", number as u64)),
        )
        .test_support()
        .into_any_element()
}

/// A dot when `checks_state` is set: pending amber, success green, failure red.
pub fn checks_dot(id: impl Into<ElementId>, state: p::ChecksState, cx: &App) -> AnyElement {
    let label = ind::checks_label(state);
    div()
        .id(id.into())
        .role(gpui_kit::Role::Image)
        .aria_label(label)
        .size(px(12.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .tooltip(move |window, cx| Tooltip::new(label).build(window, cx))
        .child(
            div()
                .size(px(6.))
                .rounded_full()
                .bg(color(ind::checks_token(state), cx)),
        )
        .test_support()
        .into_any_element()
}

fn render_row(
    row: &SidebarRow,
    active: bool,
    select: Option<OnSelect>,
    cx: &mut App,
) -> AnyElement {
    let id = row.id.clone();
    let muted = color(Token::MutedForeground, cx);
    let Some(summary) = row.summary.clone() else {
        let on_select = select.clone();
        return div()
            .id(ElementId::Name(format!("workspace-{id}").into()))
            .role(gpui_kit::Role::ListItem)
            .aria_label(format!("{} · {}", row.title, row.detail))
            .px_2()
            .py_1()
            .child(row.title.clone())
            .child(div().text_xs().text_color(muted).child(row.detail.clone()))
            .on_click(move |_, window, cx| {
                if let Some(f) = &on_select {
                    f(&id, window, cx);
                }
            })
            .into_any_element();
    };
    let indicator = ind::status_indicator(summary.attention, summary.state, None);
    let status = indicator
        .as_ref()
        .map(|i| i.tooltip.clone())
        .unwrap_or_default();
    let title = div()
        .flex_1()
        .min_w_0()
        .truncate()
        .when(ind::is_bold(summary.attention), |this| {
            this.font_weight(gpui_kit::FontWeight::SEMIBOLD)
        })
        .child(row.title.clone());
    let line =
        h_flex()
            .w_full()
            .gap_1p5()
            .child(status_icon(
                ElementId::Name(format!("status-{id}").into()),
                indicator,
                cx,
            ))
            .child(title)
            .child(
                h_flex()
                    .flex_none()
                    .gap_1()
                    .children(summary.pr_number.map(|n| {
                        pr_badge(
                            ElementId::Name(format!("pr-{id}").into()),
                            n,
                            summary.pr_state,
                            cx,
                        )
                    }))
                    .children(summary.checks_state.map(|s| {
                        checks_dot(ElementId::Name(format!("checks-{id}").into()), s, cx)
                    })),
            );
    let workspace_id = id.clone();
    let mut trigger = div()
        .id(ElementId::Name(format!("workspace-{id}").into()))
        .role(gpui_kit::Role::ListItem)
        .aria_label(
            [row.title.to_string(), row.detail.to_string(), status]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · "),
        )
        .px_2()
        .py_1p5()
        .w_full()
        .min_h(px(48.))
        .rounded_md()
        .hover(move |style| style.bg(muted.opacity(0.08)))
        .child(line)
        .child(
            div()
                .pl(px(20.))
                .text_size(px(11.))
                .truncate()
                .text_color(muted)
                .child(row.detail.clone()),
        )
        .on_click(move |_, window, cx| {
            if let Some(f) = &select {
                f(&workspace_id, window, cx);
            }
        });
    if active {
        trigger = trigger.bg(color(Token::SidebarAccent, cx));
    }
    let menu_summary = summary.clone();
    let trigger = trigger
        .test_support()
        .context_menu(move |menu, _, cx| row_menu(menu, &menu_summary, cx));
    let hover_summary = summary;
    HoverCard::new(ElementId::Name(format!("hover-{id}").into()))
        .open_delay(HOVER_DELAY)
        .trigger(trigger)
        .content(move |_, window, cx| hover_card(&hover_summary, window, cx))
        .into_any_element()
}

fn project_of(w: &p::WorkspaceSummary, cx: &App) -> Option<p::Project> {
    crate::app::AppState::try_global(cx)?
        .read(cx)
        .hub
        .read(cx)
        .projects
        .iter()
        .find(|p| p.id == w.project_id)
        .cloned()
}

/// 04, Right-click menu: Rename, Pin or Unpin, Copy branch name, Open on GitHub, Archive.
fn row_menu(
    menu: gpui_kit::component::menu::PopupMenu,
    summary: &p::WorkspaceSummary,
    cx: &App,
) -> gpui_kit::component::menu::PopupMenu {
    let rename = summary.id.clone();
    let pin = summary.clone();
    let archive = summary.id.clone();
    let branch = summary.branch.clone();
    let github = project_of(summary, cx)
        .map(|p| ind::github_url_for(&p.owner, &p.name, summary.pr_number, &summary.branch));
    menu.item(PopupMenuItem::new("Rename").on_click(move |_, window, cx| {
        crate::app::AppState::global(cx).update(cx, |a, cx| {
            a.show_workspace(&rename, cx);
        });
        window.dispatch_action(Box::new(crate::actions::RenameWorkspace), cx);
    }))
    .item(
        PopupMenuItem::new(if summary.pinned { "Unpin" } else { "Pin" }).on_click(
            move |_, window, cx| {
                mutate::<api::SetPinned>(
                    p::SetPinnedIn {
                        workspace_id: pin.id.clone(),
                        pinned: !pin.pinned,
                    },
                    None,
                    window,
                    cx,
                )
            },
        ),
    )
    .item(
        PopupMenuItem::new("Copy branch name").on_click(move |_, window, cx| {
            cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(branch.clone()));
            super::toast::success("Branch name copied.", window, cx);
        }),
    )
    .item(
        PopupMenuItem::new("Open on GitHub")
            .disabled(github.is_none())
            .on_click(move |_, _, cx| {
                if let Some(url) = &github {
                    cx.open_url(url);
                }
            }),
    )
    .separator()
    .item(
        PopupMenuItem::new("Archive")
            .disabled(!ind::can_archive(summary.state))
            .on_click(move |_, window, cx| {
                mutate::<api::ArchiveWorkspace>(
                    p::ArchiveWorkspaceIn {
                        workspace_id: archive.clone(),
                    },
                    None,
                    window,
                    cx,
                )
            }),
    )
}

/// The detail the hover card needs (op step, instance, primary action): from the open store, or
/// fetched with `getWorkspace` while the card shows.
struct HoverDetail {
    detail: Option<p::WorkspaceDetail>,
    _task: Option<Task<()>>,
}

impl HoverDetail {
    fn new(workspace_id: String, cx: &mut Context<Self>) -> Self {
        let open = crate::app::AppState::try_global(cx).and_then(|a| {
            a.read(cx)
                .workspaces
                .iter()
                .find(|w| w.read(cx).workspace_id == workspace_id)
                .and_then(|w| w.read(cx).state.workspace.clone())
        });
        if open.is_some() {
            return Self {
                detail: open,
                _task: None,
            };
        }
        let client = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client());
        let task = client.map(|client| {
            let request = client.call::<api::GetWorkspace>(p::GetWorkspaceIn { workspace_id });
            cx.spawn(async move |this, cx| {
                if let Ok(detail) = request.await {
                    let _ = this.update(cx, |this, cx| {
                        this.detail = Some(detail);
                        cx.notify();
                    });
                }
            })
        });
        Self {
            detail: None,
            _task: task,
        }
    }
}

/// 04, Hover card: state, last activity, PR and checks; the next action, Wake or Sleep, Archive.
fn hover_card(summary: &p::WorkspaceSummary, window: &mut Window, cx: &mut App) -> AnyElement {
    let id = summary.id.clone();
    let state = window.use_keyed_state(
        ElementId::Name(format!("hover-detail-{id}").into()),
        cx,
        |_, cx| HoverDetail::new(id.clone(), cx),
    );
    let detail = state.read(cx).detail.clone().map(|mut d| {
        if summary.rev > d.rev {
            d.state = summary.state;
            d.attention = summary.attention;
            d.pr_number = summary.pr_number;
            d.pr_state = summary.pr_state;
            d.checks_state = summary.checks_state;
        }
        d
    });
    let w_state = detail.as_ref().map_or(summary.state, |d| d.state);
    let attention = detail.as_ref().map_or(summary.attention, |d| d.attention);
    let op = detail.as_ref().and_then(|d| d.op.as_ref());
    let pill = ind::pill_text(
        w_state,
        op,
        detail.as_ref().map(|d| &d.settings.environment.instance),
    );
    let primary = detail
        .as_ref()
        .and_then(ind::primary_action)
        .filter(|p| *p != ind::Primary::Archive);
    let power = ind::power_action(w_state);
    let muted = color(Token::MutedForeground, cx);
    let term = |label: &'static str| div().w(px(84.)).text_color(muted).child(label);
    let row = |label: &'static str, value: AnyElement| {
        h_flex().gap_3().text_xs().child(term(label)).child(value)
    };
    let pr = match summary.pr_number {
        None => div().child("None").into_any_element(),
        Some(n) => h_flex()
            .gap_1p5()
            .child(pr_badge(
                ElementId::Name(format!("hover-pr-{id}").into()),
                n,
                summary.pr_state,
                cx,
            ))
            .children(
                summary
                    .pr_state
                    .map(|s| div().text_color(muted).child(ind::pr_state_label(s))),
            )
            .into_any_element(),
    };
    let checks = match summary.checks_state {
        None => div().child("None").into_any_element(),
        Some(s) => h_flex()
            .gap_1p5()
            .child(checks_dot(
                ElementId::Name(format!("hover-checks-{id}").into()),
                s,
                cx,
            ))
            .child(ind::checks_label(s))
            .into_any_element(),
    };
    let next = id.clone();
    let power_id = id.clone();
    let archive_id = id.clone();
    v_flex()
        .w(px(288.))
        .gap_2p5()
        .child(
            h_flex()
                .gap_1p5()
                .child(status_icon(
                    ElementId::Name(format!("hover-status-{id}").into()),
                    ind::status_indicator(attention, w_state, op),
                    cx,
                ))
                .child(
                    div()
                        .truncate()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child(summary.title.clone()),
                ),
        )
        .child(
            v_flex()
                .gap_1()
                .child(row(
                    "State",
                    div()
                        .when(pill.tone == ind::PillTone::Error, |this| {
                            this.text_color(color(Token::Destructive, cx))
                        })
                        .child(pill.text)
                        .into_any_element(),
                ))
                .child(row(
                    "Last activity",
                    div()
                        .child(ind::format_relative(
                            summary.last_activity_at,
                            ind::now_ms(),
                        ))
                        .into_any_element(),
                ))
                .child(row("PR", pr))
                .child(row("Checks", checks)),
        )
        .child(
            h_flex()
                .gap_1p5()
                .flex_wrap()
                .children(primary.map(|primary| {
                    Button::new(SharedString::from(format!("hover-next-{id}")))
                        .primary()
                        .small()
                        .label(primary.label())
                        .on_click(move |_, window, cx| run_primary(primary, &next, window, cx))
                }))
                .child(
                    Button::new(SharedString::from(format!("hover-power-{id}")))
                        .outline()
                        .small()
                        .label(power.label())
                        .disabled(!power.enabled)
                        .on_click(move |_, window, cx| {
                            let workspace_id = power_id.clone();
                            if power.wake {
                                mutate::<api::WakeWorkspace>(
                                    p::WakeWorkspaceIn { workspace_id },
                                    None,
                                    window,
                                    cx,
                                )
                            } else {
                                mutate::<api::SleepWorkspace>(
                                    p::SleepWorkspaceIn { workspace_id },
                                    None,
                                    window,
                                    cx,
                                )
                            }
                        }),
                )
                .child(
                    Button::new(SharedString::from(format!("hover-archive-{id}")))
                        .outline()
                        .small()
                        .label("Archive")
                        .disabled(!ind::can_archive(w_state))
                        .on_click(move |_, window, cx| {
                            mutate::<api::ArchiveWorkspace>(
                                p::ArchiveWorkspaceIn {
                                    workspace_id: archive_id.clone(),
                                },
                                None,
                                window,
                                cx,
                            )
                        }),
                ),
        )
        .into_any_element()
}

/// The hover card's next action, as the web's `runPrimaryElsewhere`.
fn run_primary(primary: ind::Primary, workspace_id: &str, window: &mut Window, cx: &mut App) {
    let workspace_id = workspace_id.to_string();
    match primary {
        ind::Primary::CommitPush | ind::Primary::ViewChecks => {
            crate::app::AppState::global(cx).update(cx, |a, cx| {
                a.show_workspace(&workspace_id, cx);
            });
            let action: Box<dyn gpui_kit::Action> = if primary == ind::Primary::CommitPush {
                Box::new(crate::actions::CommitAndPush)
            } else {
                Box::new(crate::actions::ViewChecks)
            };
            window.defer(cx, move |window, cx| window.dispatch_action(action, cx));
        }
        ind::Primary::CreatePr => mutate::<api::CreatePullRequest>(
            p::CreatePullRequestIn {
                workspace_id,
                title: String::new(),
                body: String::new(),
                draft: false,
            },
            Some(Box::new(|out: &p::CreatePullRequestOut| {
                format!("Created PR #{}.", out.number as u64)
            })),
            window,
            cx,
        ),
        ind::Primary::Merge => mutate::<api::MergePullRequest>(
            p::MergePullRequestIn {
                workspace_id,
                method: p::MergeMethod::Squash,
            },
            Some(Box::new(|_| "Merged.".into())),
            window,
            cx,
        ),
        ind::Primary::Archive => {}
    }
}

type SuccessText<O> = Box<dyn Fn(&O) -> String>;

fn mutate<F: p::Function>(
    input: F::Input,
    success: Option<SuccessText<F::Output>>,
    window: &mut Window,
    cx: &mut App,
) where
    F::Output: 'static,
{
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
    cx.spawn(async move |cx| {
        let result = request.await;
        let _ = handle.update(cx, |_, window, cx| match result {
            Ok(output) => {
                if let Some(id) = archived {
                    archive_undo(id, window, cx);
                }
                if let Some(text) = success {
                    super::toast::success(text(&output), window, cx);
                }
            }
            Err(e) => super::toast::error(&e, None, window, cx),
        });
    })
    .detach();
}

struct ArchiveUndo;
pub fn archive_undo(id: String, window: &mut Window, cx: &mut App) {
    let key = SharedString::from(id.clone());
    window.push_notification(
        gpui_kit::component::notification::Notification::new()
            .id1::<ArchiveUndo>(key.clone())
            .message("Workspace archived.")
            .action(move |_, _, _| {
                let id = id.clone();
                Button::new("undo-archive")
                    .label("Undo")
                    .on_click(move |_, window, cx| {
                        mutate::<api::RestoreWorkspace>(
                            p::RestoreWorkspaceIn {
                                workspace_id: id.clone(),
                            },
                            None,
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

type SidebarRenderer = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, project: &str, activity: f64, attention: &str) -> p::WorkspaceSummary {
        serde_json::from_value(serde_json::json!({
            "id": id, "projectId": project, "title": id, "slug": id, "branch": format!("tempo/{id}"),
            "baseBranch": "main", "state": "ready", "attention": attention, "defaultAgent": "claude",
            "pinned": false, "prNumber": null, "prState": null, "checksState": null,
            "createdAt": 1.0, "lastActivityAt": activity, "archivedAt": null, "rev": 1.0
        }))
        .unwrap()
    }

    fn sections() -> Vec<hub::SidebarSection> {
        vec![
            hub::SidebarSection {
                key: "pinned".into(),
                project_id: None,
                workspaces: vec![summary("p1", "a", 9., "none")],
            },
            hub::SidebarSection {
                key: "a".into(),
                project_id: Some("a".into()),
                workspaces: vec![
                    summary("a1", "a", 8., "unread"),
                    summary("a2", "a", 7., "none"),
                ],
            },
            hub::SidebarSection {
                key: "b".into(),
                project_id: Some("b".into()),
                workspaces: vec![summary("b1", "b", 6., "needs_input")],
            },
        ]
    }

    fn ids(order: &[p::WorkspaceSummary]) -> Vec<&str> {
        order.iter().map(|w| w.id.as_str()).collect()
    }

    #[test]
    fn order_follows_the_sidebar_and_skips_collapsed_sections() {
        let sections = sections();
        assert_eq!(
            ids(&visible_order(&sections, &BTreeSet::new())),
            ["p1", "a1", "a2", "b1"]
        );
        let collapsed = BTreeSet::from(["a".to_string()]);
        assert_eq!(ids(&visible_order(&sections, &collapsed)), ["p1", "b1"]);
        assert_eq!(ids(&full_order(&sections)), ["p1", "a1", "a2", "b1"]);
    }

    #[test]
    fn sidebar_sort_comes_from_the_saved_state() {
        let mut projects: Vec<p::Project> = vec![];
        projects.push(
            serde_json::from_value(serde_json::json!({
                "id": "a", "installationId": 1, "repoId": 1, "owner": "o", "name": "a",
                "defaultBranch": "main", "settings": {}, "sortOrder": 0
            }))
            .unwrap(),
        );
        let mut older_activity = summary("x", "a", 1., "none");
        older_activity.created_at = 5.;
        let newer_activity = summary("y", "a", 2., "none");
        let workspaces = [older_activity, newer_activity]
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
        let by = |sort| {
            full_order(&hub::sidebar_sections(&workspaces, &projects, sort))
                .into_iter()
                .map(|w| w.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(by(hub::SortMode::Activity), ["y", "x"]);
        assert_eq!(by(hub::SortMode::Created), ["x", "y"]);
    }

    #[test]
    fn stepping_wraps_and_starts_at_either_end() {
        let ids: Vec<String> = ["a", "b", "c"].map(String::from).to_vec();
        assert_eq!(step_workspace(&ids, Some("c"), true).as_deref(), Some("a"));
        assert_eq!(step_workspace(&ids, Some("a"), false).as_deref(), Some("c"));
        assert_eq!(step_workspace(&ids, None, true).as_deref(), Some("a"));
        assert_eq!(
            step_workspace(&ids, Some("gone"), false).as_deref(),
            Some("c")
        );
        assert_eq!(step_workspace(&[], None, true), None);
    }

    #[test]
    fn next_needing_you_prefers_input_and_errors() {
        let order = full_order(&sections());
        assert_eq!(next_needing_you(&order, Some("p1")).as_deref(), Some("b1"));
        assert_eq!(next_needing_you(&order, Some("b1")).as_deref(), Some("a1"));
        assert_eq!(next_needing_you(&order, None).as_deref(), Some("b1"));
        let calm = vec![summary("x", "a", 1., "none")];
        assert_eq!(next_needing_you(&calm, None), None);
    }
}
