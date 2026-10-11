//! Key bindings: the Conductor column of the shortcut table in 04 (07, Shortcuts).
use crate::actions::*;
use gpui_kit::{App, KeyBinding, NoAction};

pub const WORKSPACE: &str = "Workspace";
pub const COMPOSER: &str = "Composer";
pub const DIFF: &str = "Diff";
pub const TERMINAL: &str = "Terminal";

// The composer's text field has GPUI Kit's own `Input` context, which binds
// enter, escape and shift-tab. A binding on the inner context outranks it.
const COMPOSER_INPUT: &str = "Composer > Input";

/// Keys bound outside the terminal that are not ⌘ shortcuts. In the terminal
/// they must reach the shell (07, Terminal), so the terminal context unbinds them.
/// `tab` and `shift-tab` are GPUI Kit's focus traversal in its `Root` context.
pub const TERMINAL_PASSTHROUGH: &[&str] =
    &["tab", "shift-tab", "ctrl-tab", "ctrl-shift-tab", "ctrl-o"];

pub fn bindings() -> Vec<KeyBinding> {
    let ws = Some(WORKSPACE);
    let mut out = vec![
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-h", HideApp, None),
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-k", CommandPalette, ws),
        KeyBinding::new("cmd-n", NewWorkspace, ws),
        KeyBinding::new("cmd-t", NewChat, ws),
        KeyBinding::new("cmd-w", CloseTab, ws),
        KeyBinding::new("ctrl-tab", NextTab, ws),
        KeyBinding::new("ctrl-shift-tab", PreviousTab, ws),
        KeyBinding::new("cmd-alt-down", NextWorkspace, ws),
        KeyBinding::new("cmd-alt-up", PreviousWorkspace, ws),
        KeyBinding::new("cmd-alt-l", NextWorkspaceNeedingYou, ws),
        KeyBinding::new("cmd-b", ToggleSidebar, ws),
        KeyBinding::new("cmd-alt-b", ToggleRightSide, ws),
        KeyBinding::new("cmd-j", ToggleBottomPanel, ws),
        KeyBinding::new("cmd-l", FocusComposer, ws),
        KeyBinding::new("cmd-shift-backspace", StopTurn, ws),
        KeyBinding::new("cmd-/", ModelPicker, ws),
        KeyBinding::new("cmd-u", AttachFile, ws),
        KeyBinding::new("ctrl-o", ExpandAllToolCalls, ws),
        KeyBinding::new("cmd-shift-d", ShowDiff, ws),
        KeyBinding::new("cmd-alt-u", ToggleDiffScope, ws),
        KeyBinding::new("cmd-p", OpenFile, ws),
        KeyBinding::new("cmd-shift-f", SearchFiles, ws),
        KeyBinding::new("cmd-shift-y", CommitAndPush, ws),
        KeyBinding::new("cmd-shift-p", CreatePr, ws),
        KeyBinding::new("cmd-shift-m", Merge, ws),
        KeyBinding::new("cmd-shift-a", Archive, ws),
        KeyBinding::new("cmd-r", ToggleRun, ws),
        KeyBinding::new("enter", Send, Some(COMPOSER_INPUT)),
        KeyBinding::new("escape", StopTurn, Some(COMPOSER_INPUT)),
        KeyBinding::new("shift-tab", TogglePlanMode, Some(COMPOSER_INPUT)),
        KeyBinding::new(
            "down",
            NextComposerChoice,
            Some("Composer > ComposerPicker > Input"),
        ),
        KeyBinding::new(
            "up",
            PreviousComposerChoice,
            Some("Composer > ComposerPicker > Input"),
        ),
        KeyBinding::new(
            "escape",
            DismissComposerChoice,
            Some("Composer > ComposerPicker > Input"),
        ),
        KeyBinding::new("enter", Send, Some("Composer > ComposerPicker > Input")),
        KeyBinding::new("down", NextFile, Some(DIFF)),
        KeyBinding::new("up", PreviousFile, Some(DIFF)),
        KeyBinding::new("ctrl-v", MarkFileViewed, Some(DIFF)),
    ];
    for n in 1..=9 {
        out.push(KeyBinding::new(
            &format!("cmd-{n}"),
            SwitchToWorkspace(n),
            ws,
        ));
    }
    for keys in TERMINAL_PASSTHROUGH {
        out.push(KeyBinding::new(keys, NoAction, Some(TERMINAL)));
    }
    out
}

/// Call after `gpui_kit::init`, so these bindings outrank GPUI Kit's at the same depth.
pub fn bind(cx: &mut App) {
    cx.bind_keys(bindings());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn table() -> Vec<(String, String, String)> {
        bindings()
            .iter()
            .map(|b| {
                let keys = b
                    .keystrokes()
                    .iter()
                    .map(|k| k.unparse().replace("super-", "cmd-"))
                    .collect::<Vec<_>>()
                    .join(" ");
                let context = b.predicate().map(|p| p.to_string()).unwrap_or_default();
                (keys, b.action().name().to_string(), context)
            })
            .collect()
    }

    fn find(action: &str) -> Vec<(String, String)> {
        table()
            .into_iter()
            .filter(|(_, name, _)| name == action)
            .map(|(keys, _, context)| (keys, context))
            .collect()
    }

    #[test]
    fn no_key_is_bound_twice_in_one_context() {
        let mut seen = HashSet::new();
        for (keys, _, context) in table() {
            assert!(
                seen.insert((keys.clone(), context.clone())),
                "{keys} twice in {context:?}"
            );
        }
    }

    #[test]
    fn conductor_column_of_04() {
        let expected = [
            ("tempo::CommandPalette", "cmd-k"),
            ("tempo::NewWorkspace", "cmd-n"),
            ("tempo::NewChat", "cmd-t"),
            ("tempo::CloseTab", "cmd-w"),
            ("tempo::NextTab", "ctrl-tab"),
            ("tempo::PreviousTab", "ctrl-shift-tab"),
            ("tempo::NextWorkspace", "alt-cmd-down"),
            ("tempo::PreviousWorkspace", "alt-cmd-up"),
            ("tempo::NextWorkspaceNeedingYou", "alt-cmd-l"),
            ("tempo::ToggleSidebar", "cmd-b"),
            ("tempo::ToggleRightSide", "alt-cmd-b"),
            ("tempo::ToggleBottomPanel", "cmd-j"),
            ("tempo::FocusComposer", "cmd-l"),
            ("tempo::Send", "enter"),
            ("tempo::TogglePlanMode", "shift-tab"),
            ("tempo::ModelPicker", "cmd-/"),
            ("tempo::AttachFile", "cmd-u"),
            ("tempo::ExpandAllToolCalls", "ctrl-o"),
            ("tempo::ShowDiff", "cmd-shift-d"),
            ("tempo::ToggleDiffScope", "alt-cmd-u"),
            ("tempo::NextFile", "down"),
            ("tempo::PreviousFile", "up"),
            ("tempo::MarkFileViewed", "ctrl-v"),
            ("tempo::OpenFile", "cmd-p"),
            ("tempo::SearchFiles", "cmd-shift-f"),
            ("tempo::CommitAndPush", "cmd-shift-y"),
            ("tempo::CreatePr", "cmd-shift-p"),
            ("tempo::Merge", "cmd-shift-m"),
            ("tempo::Archive", "cmd-shift-a"),
            ("tempo::ToggleRun", "cmd-r"),
            ("tempo::OpenSettings", "cmd-,"),
        ];
        for (action, keys) in expected {
            let bound = find(action);
            assert!(
                bound.iter().any(|(k, _)| k == keys),
                "{action}: expected {keys}, got {bound:?}"
            );
        }
        let stop = find("tempo::StopTurn");
        assert!(stop.iter().any(|(k, _)| k == "escape"));
        assert!(stop.iter().any(|(k, _)| k == "cmd-shift-backspace"));
        let switch = find("tempo::SwitchToWorkspace");
        assert_eq!(switch.len(), 9);
    }

    #[test]
    fn bindings_use_only_spec_regions_and_nested_input_contexts() {
        let allowed = [
            "",
            WORKSPACE,
            DIFF,
            TERMINAL,
            "Composer > Input",
            "Composer > ComposerPicker > Input",
        ];
        for (keys, action, context) in table() {
            assert!(
                allowed.contains(&context.as_str()),
                "{keys} {action} in {context}"
            );
        }
    }

    #[test]
    fn terminal_keeps_every_non_command_key_bound_outside_it() {
        let passthrough: HashSet<String> = table()
            .into_iter()
            .filter(|(_, action, context)| context == TERMINAL && action == "zed::NoAction")
            .map(|(keys, _, _)| keys)
            .collect();
        for (keys, action, context) in table() {
            let outside = context.is_empty() || context == WORKSPACE;
            if outside && !keys.contains("cmd") {
                assert!(
                    passthrough.contains(&keys),
                    "{keys} ({action}) would not reach the shell"
                );
            }
        }
        assert!(passthrough.contains("tab") && passthrough.contains("shift-tab"));
    }
}
