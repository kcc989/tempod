//! Command palette (04: ⌘K; 07: GPUI Kit `Command`): jump to any workspace by title, branch or
//! slug; run any action that has a shortcut. Up and Down choose, Enter runs, Esc closes.
use super::indicators as ind;
use super::tokens::{Token, color};
use crate::actions::*;
use gpui_kit::component::command::{Command, CommandGroup, CommandItem, CommandState};
use gpui_kit::component::kbd::Kbd;
use gpui_kit::component::{IndexPath, WindowExt as _, h_flex};
use gpui_kit::{
    Action, App, AppContext as _, Context, Entity, FocusHandle, IntoElement, Keystroke,
    ParentElement as _, Render, SharedString, Styled as _, Window, div, px,
};
use tempo_protocol as p;

/// One action of 04's shortcut table that the Mac app runs, with its Mac binding.
pub struct PaletteAction {
    pub label: &'static str,
    pub keys: &'static str,
    pub action: Box<dyn Action>,
}

fn entry(label: &'static str, keys: &'static str, action: impl Action) -> PaletteAction {
    PaletteAction {
        label,
        keys,
        action: Box::new(action),
    }
}

const WORKSPACE_KEYS: [&str; 9] = [
    "cmd-1", "cmd-2", "cmd-3", "cmd-4", "cmd-5", "cmd-6", "cmd-7", "cmd-8", "cmd-9",
];
const WORKSPACE_LABELS: [&str; 9] = [
    "Switch to workspace 1",
    "Switch to workspace 2",
    "Switch to workspace 3",
    "Switch to workspace 4",
    "Switch to workspace 5",
    "Switch to workspace 6",
    "Switch to workspace 7",
    "Switch to workspace 8",
    "Switch to workspace 9",
];

/// What the palette can run right now, in the order of 04's table. `visible` is how many rows
/// the sidebar shows; `open` is whether a workspace is shown.
pub fn actions(visible: usize, needs_you: bool, open: bool) -> Vec<PaletteAction> {
    let mut out = vec![entry("New workspace", "cmd-n", NewWorkspace)];
    if open {
        out.extend([
            entry("New chat tab", "cmd-t", NewChat),
            entry("Close tab", "cmd-w", CloseTab),
            entry("Next tab", "ctrl-tab", NextTab),
            entry("Previous tab", "ctrl-shift-tab", PreviousTab),
        ]);
    }
    for n in 0..visible.min(9) {
        out.push(entry(
            WORKSPACE_LABELS[n],
            WORKSPACE_KEYS[n],
            SwitchToWorkspace(n + 1),
        ));
    }
    if visible > 0 {
        out.push(entry("Next workspace", "cmd-alt-down", NextWorkspace));
        out.push(entry("Previous workspace", "cmd-alt-up", PreviousWorkspace));
    }
    if needs_you {
        out.push(entry(
            "Next workspace that needs you",
            "cmd-alt-l",
            NextWorkspaceNeedingYou,
        ));
    }
    out.extend([
        entry("Toggle sidebar", "cmd-b", ToggleSidebar),
        entry("Toggle right side", "cmd-alt-b", ToggleRightSide),
        entry("Toggle bottom panel", "cmd-j", ToggleBottomPanel),
    ]);
    if open {
        out.extend([
            entry("Focus composer", "cmd-l", FocusComposer),
            entry("Stop the turn", "cmd-shift-backspace", StopTurn),
            entry("Toggle plan mode", "shift-tab", TogglePlanMode),
            entry("Model picker", "cmd-/", ModelPicker),
            entry("Attach a file", "cmd-u", AttachFile),
            entry("Expand all tool calls", "ctrl-o", ExpandAllToolCalls),
            entry("Diff tab", "cmd-shift-d", ShowDiff),
            entry("Branch or uncommitted scope", "cmd-alt-u", ToggleDiffScope),
            entry("Next file", "down", NextFile),
            entry("Previous file", "up", PreviousFile),
            entry("Mark file viewed", "ctrl-v", MarkFileViewed),
            entry("Open file", "cmd-p", OpenFile),
            entry("Search files", "cmd-shift-f", SearchFiles),
            entry("Commit and push", "cmd-shift-y", CommitAndPush),
            entry("Create PR", "cmd-shift-p", CreatePr),
            entry("Merge", "cmd-shift-m", Merge),
            entry("Archive", "cmd-shift-a", Archive),
            entry("Start or stop the default run script", "cmd-r", ToggleRun),
        ]);
    }
    out.push(entry("Settings", "cmd-,", OpenSettings));
    out
}

/// Case-insensitive: the query appears in any of the terms. An empty query matches everything.
pub fn matches(terms: &[&str], query: &str) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty() || terms.iter().any(|t| t.to_lowercase().contains(&query))
}

/// Workspaces match by title, branch or slug.
pub fn workspace_matches(w: &p::WorkspaceSummary, query: &str) -> bool {
    matches(&[&w.title, &w.branch, &w.slug], query)
}

pub struct CommandPalette {
    state: Entity<CommandState>,
    query: String,
    main_focus: FocusHandle,
    shown_workspaces: Vec<String>,
    shown_actions: Vec<Box<dyn Action>>,
}

impl CommandPalette {
    fn new(main_focus: FocusHandle, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            state: cx.new(|cx| CommandState::new(window, cx)),
            query: String::new(),
            main_focus,
            shown_workspaces: vec![],
            shown_actions: vec![],
        }
    }

    fn confirm(&mut self, index: IndexPath, window: &mut Window, cx: &mut Context<Self>) {
        let workspace = (index.section == 0)
            .then(|| self.shown_workspaces.get(index.row).cloned())
            .flatten();
        let action = (index.section == 1)
            .then(|| self.shown_actions.get(index.row).map(|a| a.boxed_clone()))
            .flatten();
        window.close_dialog(cx);
        if let Some(id) = workspace {
            crate::app::AppState::global(cx).update(cx, |a, cx| {
                a.show_workspace(&id, cx);
            });
        }
        if let Some(action) = action {
            let main_focus = self.main_focus.clone();
            window.defer(cx, move |window, cx| run(action, &main_focus, window, cx));
        }
    }
}

/// Dispatches as the menus and key bindings do, from the focus the dialog gave back.
fn run(action: Box<dyn Action>, main_focus: &FocusHandle, window: &mut Window, cx: &mut App) {
    if window.focused(cx).is_none() {
        window.focus(main_focus, cx);
    }
    if action.name() == TogglePlanMode.name() {
        window.dispatch_action(Box::new(FocusComposer), cx);
        window.defer(cx, move |window, cx| window.dispatch_action(action, cx));
    } else {
        window.dispatch_action(action, cx);
    }
}

fn keys(keys: &str) -> Option<Kbd> {
    Keystroke::parse(keys).ok().map(Kbd::new)
}

impl Render for CommandPalette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let order = super::sidebar::order(cx);
        let current =
            crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).active_workspace.clone());
        let open = current.is_some();
        let needs_you = super::sidebar::next_needing_you(&order.all, current.as_deref()).is_some();
        let workspaces: Vec<_> = order
            .all
            .into_iter()
            .filter(|w| workspace_matches(w, &self.query))
            .collect();
        let actions: Vec<_> = actions(order.visible.len(), needs_you, open)
            .into_iter()
            .filter(|a| matches(&[a.label], &self.query))
            .collect();
        self.shown_workspaces = workspaces.iter().map(|w| w.id.clone()).collect();
        self.shown_actions = actions.iter().map(|a| a.action.boxed_clone()).collect();
        let muted = color(Token::MutedForeground, cx);
        let workspace_items = workspaces.into_iter().map(|w| {
            let detail = SharedString::from(format!("{} · {}", w.branch, w.slug));
            let title = SharedString::from(w.title.clone());
            let id = w.id.clone();
            let indicator = ind::status_indicator(w.attention, w.state, None);
            CommandItem::new()
                .label(title.clone())
                .keywords([detail.clone()])
                .child(move |_, cx| {
                    h_flex()
                        .w_full()
                        .gap_2()
                        .child(super::sidebar::status_icon(
                            SharedString::from(format!("palette-status-{id}")),
                            indicator.clone(),
                            cx,
                        ))
                        .child(div().min_w_0().truncate().child(title.clone()))
                        .child(
                            div()
                                .ml_auto()
                                .min_w_0()
                                .truncate()
                                .text_xs()
                                .text_color(muted)
                                .child(detail.clone()),
                        )
                })
        });
        let action_items = actions.into_iter().map(|a| {
            let label = a.label;
            let shortcut = a.keys;
            CommandItem::new().label(label).child(move |_, _| {
                h_flex()
                    .w_full()
                    .gap_2()
                    .child(div().flex_1().child(label))
                    .children(keys(shortcut))
            })
        });
        let weak = cx.weak_entity();
        div().w_full().child(
            Command::new(&self.state)
                .bordered(false)
                .filterable(false)
                .max_h(px(400.))
                .placeholder("Jump to a workspace or run an action")
                .empty(|_, _, _| div().p_3().child("No results."))
                .group(
                    CommandGroup::new()
                        .label("Workspaces")
                        .items(workspace_items),
                )
                .group(CommandGroup::new().label("Actions").items(action_items))
                .on_query({
                    let weak = weak.clone();
                    move |query, _, cx| {
                        let query = query.to_string();
                        let _ = weak.update(cx, |this, cx| {
                            this.query = query;
                            cx.notify();
                        });
                    }
                })
                .on_confirm(move |index, window, cx| {
                    let _ = weak.update(cx, |this, cx| this.confirm(index, window, cx));
                }),
        )
    }
}

/// Opens the palette over the main window. `main_focus` takes focus when nothing else has it, so
/// the action reaches the main window's handlers.
pub fn open(main_focus: FocusHandle, window: &mut Window, cx: &mut App) {
    let palette = cx.new(|cx| CommandPalette::new(main_focus, window, cx));
    let state = palette.read(cx).state.clone();
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.w(px(560.)).p_0().child(palette.clone())
    });
    state.update(cx, |s, cx| s.focus(window, cx));
    window.defer(cx, move |window, cx| {
        state.update(cx, |s, cx| s.focus(window, cx))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(title: &str, branch: &str, slug: &str) -> p::WorkspaceSummary {
        serde_json::from_value(serde_json::json!({
            "id": slug, "projectId": "p", "title": title, "slug": slug, "branch": branch,
            "baseBranch": "main", "state": "ready", "attention": "none", "defaultAgent": "claude",
            "pinned": false, "prNumber": null, "prState": null, "checksState": null,
            "createdAt": 1.0, "lastActivityAt": 1.0, "archivedAt": null, "rev": 1.0
        }))
        .unwrap()
    }

    #[test]
    fn workspaces_match_by_title_branch_or_slug() {
        let w = workspace("Fix pagination", "tempo/fix-pages", "lisbon");
        assert!(workspace_matches(&w, ""));
        assert!(workspace_matches(&w, "PAGINATION"));
        assert!(workspace_matches(&w, "fix-pages"));
        assert!(workspace_matches(&w, "lisb"));
        assert!(!workspace_matches(&w, "oslo"));
    }

    #[test]
    fn actions_depend_on_what_is_open() {
        let labels = |a: Vec<PaletteAction>| a.into_iter().map(|a| a.label).collect::<Vec<_>>();
        let none = labels(actions(0, false, false));
        assert_eq!(
            none,
            [
                "New workspace",
                "Toggle sidebar",
                "Toggle right side",
                "Toggle bottom panel",
                "Settings"
            ]
        );
        let all = labels(actions(12, true, true));
        assert!(all.contains(&"Switch to workspace 9"));
        assert!(!all.iter().any(|l| l.ends_with("workspace 10")));
        for label in [
            "Next tab",
            "Previous tab",
            "Branch or uncommitted scope",
            "Next file",
            "Previous file",
            "Mark file viewed",
            "Stop the turn",
            "Toggle plan mode",
            "Next workspace that needs you",
        ] {
            assert!(all.contains(&label), "{label}");
        }
        assert_eq!(
            labels(actions(2, false, false))
                .into_iter()
                .filter(|l| l.starts_with("Switch"))
                .count(),
            2
        );
    }

    #[test]
    fn every_entry_shows_the_key_its_action_is_bound_to() {
        let bound: Vec<(String, String)> = crate::keymap::bindings()
            .iter()
            .map(|b| {
                (
                    b.action().name().to_string(),
                    b.keystrokes()
                        .iter()
                        .map(|k| gpui_kit::AsKeystroke::as_keystroke(k).unparse())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            })
            .collect();
        for a in actions(9, true, true) {
            let keys = Keystroke::parse(a.keys).unwrap().unparse();
            assert!(
                bound
                    .iter()
                    .any(|(name, k)| name == a.action.name() && *k == keys),
                "{} ({}) is not bound to {}",
                a.label,
                a.keys,
                a.action.name()
            );
        }
    }
}
