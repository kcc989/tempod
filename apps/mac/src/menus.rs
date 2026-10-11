//! App menus (07, macOS integration). Shortcuts shown in the menus come from `keymap`.
use crate::actions::*;
use gpui_kit::component::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};
use gpui_kit::{App, Menu, MenuItem, OsAction};

pub fn app_menus() -> Vec<Menu> {
    let mut window = vec![
        MenuItem::action("Minimize", Minimize),
        MenuItem::action("Zoom", Zoom),
        MenuItem::separator(),
    ];
    window.extend((1..=9).map(|n| MenuItem::action(format!("Workspace {n}"), SwitchToWorkspace(n))));

    vec![
        Menu::new("Tempo").items([
            MenuItem::action("About Tempo", About),
            MenuItem::action("Check for Updates…", CheckForUpdates),
            MenuItem::separator(),
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::action("Sign Out", SignOut),
            MenuItem::separator(),
            MenuItem::action("Hide Tempo", HideApp),
            MenuItem::action("Quit Tempo", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New Workspace", NewWorkspace),
            MenuItem::action("New Chat", NewChat),
            MenuItem::action("Close Tab", CloseTab),
            MenuItem::action("Open File", OpenFile),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
            MenuItem::separator(),
            MenuItem::action("Search Files", SearchFiles),
        ]),
        Menu::new("View").items([
            MenuItem::action("Command Palette", CommandPalette),
            MenuItem::action("Toggle Sidebar", ToggleSidebar),
            MenuItem::action("Toggle Right Side", ToggleRightSide),
            MenuItem::action("Toggle Bottom Panel", ToggleBottomPanel),
            MenuItem::action("Diff", ShowDiff),
        ]),
        Menu::new("Workspace").items([
            MenuItem::action("Commit and Push", CommitAndPush),
            MenuItem::action("Create PR", CreatePr),
            MenuItem::action("Merge", Merge),
            MenuItem::action("Archive", Archive),
            MenuItem::action("Start or Stop Run", ToggleRun),
            MenuItem::action("Next Workspace That Needs You", NextWorkspaceNeedingYou),
        ]),
        Menu::new("Window").items(window),
        Menu::new("Help").items([MenuItem::action("Open Tempo in Browser", OpenTempoInBrowser)]),
    ]
}

pub fn set(cx: &mut App) {
    cx.set_menus(app_menus());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(menu: &Menu) -> Vec<String> {
        menu.items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Action { name, .. } => Some(name.to_string()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn menus_match_the_table_in_07() {
        let menus = app_menus();
        let titles: Vec<_> = menus.iter().map(|m| m.name.to_string()).collect();
        assert_eq!(titles, ["Tempo", "File", "Edit", "View", "Workspace", "Window", "Help"]);
        assert_eq!(
            names(&menus[0]),
            ["About Tempo", "Check for Updates…", "Settings…", "Sign Out", "Hide Tempo", "Quit Tempo"]
        );
        assert_eq!(names(&menus[1]), ["New Workspace", "New Chat", "Close Tab", "Open File"]);
        assert_eq!(
            names(&menus[2]),
            ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All", "Search Files"]
        );
        assert_eq!(
            names(&menus[3]),
            ["Command Palette", "Toggle Sidebar", "Toggle Right Side", "Toggle Bottom Panel", "Diff"]
        );
        assert_eq!(
            names(&menus[4]),
            [
                "Commit and Push",
                "Create PR",
                "Merge",
                "Archive",
                "Start or Stop Run",
                "Next Workspace That Needs You"
            ]
        );
        let window = names(&menus[5]);
        assert_eq!(window[..2], ["Minimize", "Zoom"]);
        assert_eq!(window.len(), 11);
        assert_eq!(window[10], "Workspace 9");
        assert_eq!(names(&menus[6]), ["Open Tempo in Browser"]);
    }

    #[test]
    fn every_menu_action_except_edit_and_zoom_has_a_shortcut() {
        let bound: Vec<String> = crate::keymap::bindings()
            .iter()
            .map(|b| b.action().name().to_string())
            .collect();
        let unbound = [
            "tempo::About",
            "tempo::CheckForUpdates",
            "tempo::SignOut",
            "tempo::Zoom",
            "tempo::OpenTempoInBrowser",
        ];
        for menu in app_menus() {
            for item in &menu.items {
                if let MenuItem::Action { action, os_action: None, .. } = item {
                    let name = action.name();
                    if !unbound.contains(&name) {
                        assert!(bound.iter().any(|b| b == name), "{name} has no key binding");
                    }
                }
            }
        }
    }
}
