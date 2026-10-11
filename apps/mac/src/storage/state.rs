use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Sidebar sort order (04, Sidebar), as the web's `SortMode`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortMode {
    #[default]
    Activity,
    Created,
}

/// Diff view (04, Changes; 07, Changes and diff view).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffViewMode {
    #[default]
    Unified,
    Split,
}

/// Pane sizes in points; `None` means the view's default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PaneSizes {
    pub sidebar: Option<f32>,
    pub right: Option<f32>,
    /// The process panel (Setup, Run, Terminal) under the review tabs on the right side.
    pub bottom: Option<f32>,
}

/// Which panels are open. The defaults match the web layout (`workspace-ui.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Panels {
    pub sidebar: bool,
    pub right: bool,
    /// Below 1,100 pt the right side has its own toggle, closed by default (07).
    pub right_when_narrow: bool,
    pub bottom: bool,
}

impl Default for Panels {
    fn default() -> Self {
        Self {
            sidebar: true,
            right: true,
            right_when_narrow: false,
            bottom: true,
        }
    }
}

/// The main window frame in points, restored on launch (07, Window state).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl WindowFrame {
    /// The frame grown to at least `min` (07: 900 × 600 pt), or `None` if it holds no finite number.
    pub fn clamped(self, min: (f32, f32)) -> Option<Self> {
        let finite = [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite());
        finite.then(|| Self {
            width: self.width.max(min.0),
            height: self.height.max(min.1),
            ..self
        })
    }
}

/// `state.json` (07, Local storage): layout, sort order, last workspace, window frame, composer
/// drafts and diff viewed marks. The 07 table is the full list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub panes: PaneSizes,
    pub panels: Panels,
    pub sort: SortMode,
    pub last_workspace: Option<String>,
    pub window: Option<WindowFrame>,
    /// workspaceId → chat tab (session id) → draft text.
    pub drafts: BTreeMap<String, BTreeMap<String, String>>,
    pub diff_view: DiffViewMode,
    /// workspaceId → file path → the diff hash the file was marked viewed at.
    pub viewed: BTreeMap<String, BTreeMap<String, String>>,
}

impl State {
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }

    pub fn draft(&self, workspace_id: &str, tab: &str) -> Option<&str> {
        self.drafts.get(workspace_id)?.get(tab).map(String::as_str)
    }

    /// Keeps a draft; an empty one is removed.
    pub fn set_draft(&mut self, workspace_id: &str, tab: &str, text: &str) {
        set_or_remove(&mut self.drafts, workspace_id, tab, text);
    }

    /// The mark holds only while the file's diff hash is unchanged (04, Mark as viewed).
    pub fn is_viewed(&self, workspace_id: &str, path: &str, diff_hash: &str) -> bool {
        self.viewed
            .get(workspace_id)
            .and_then(|marks| marks.get(path))
            .is_some_and(|h| h == diff_hash)
    }

    pub fn set_viewed(&mut self, workspace_id: &str, path: &str, diff_hash: &str, viewed: bool) {
        let hash = if viewed { diff_hash } else { "" };
        set_or_remove(&mut self.viewed, workspace_id, path, hash);
    }

    /// Drops drafts and viewed marks of a workspace that no longer exists.
    pub fn forget_workspace(&mut self, workspace_id: &str) {
        self.drafts.remove(workspace_id);
        self.viewed.remove(workspace_id);
        if self.last_workspace.as_deref() == Some(workspace_id) {
            self.last_workspace = None;
        }
    }
}

fn set_or_remove(
    map: &mut BTreeMap<String, BTreeMap<String, String>>,
    outer: &str,
    inner: &str,
    value: &str,
) {
    if value.is_empty() {
        if let Some(entries) = map.get_mut(outer) {
            entries.remove(inner);
            if entries.is_empty() {
                map.remove(outer);
            }
        }
    } else {
        map.entry(outer.to_string())
            .or_default()
            .insert(inner.to_string(), value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::file::{LoadOutcome, load_or_recover, tests::temp_dir, write_atomic};

    fn sample() -> State {
        let mut s = State {
            panes: PaneSizes {
                sidebar: Some(260.),
                right: Some(420.5),
                bottom: None,
            },
            panels: Panels {
                sidebar: false,
                right: true,
                right_when_narrow: true,
                bottom: false,
            },
            sort: SortMode::Created,
            last_workspace: Some("w1".into()),
            window: Some(WindowFrame {
                x: 10.,
                y: 20.,
                width: 1280.,
                height: 800.,
            }),
            diff_view: DiffViewMode::Split,
            ..State::default()
        };
        s.set_draft("w1", "s1", "half a thought");
        s.set_viewed("w1", "src/a.rs", "9f2c01aa", true);
        s
    }

    #[test]
    fn defaults() {
        let s = State::default();
        assert_eq!(s.panels, Panels::default());
        assert!(s.panels.sidebar && s.panels.right && s.panels.bottom);
        assert!(!s.panels.right_when_narrow);
        assert_eq!(s.sort, SortMode::Activity);
        assert_eq!(s.diff_view, DiffViewMode::Unified);
        assert_eq!(s.window, None);
        assert_eq!(State::parse("{}").unwrap(), s);
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = temp_dir("state");
        let path = dir.join("state.json");
        let s = sample();
        write_atomic(&path, s.to_json().as_bytes()).unwrap();
        let loaded = load_or_recover(&path, State::parse);
        assert_eq!(loaded.outcome, LoadOutcome::Loaded);
        assert_eq!(loaded.value, s);
    }

    #[test]
    fn json_uses_camel_case_and_lowercase_enums() {
        let v: serde_json::Value = serde_json::from_str(&sample().to_json()).unwrap();
        assert_eq!(v["lastWorkspace"], "w1");
        assert_eq!(v["diffView"], "split");
        assert_eq!(v["sort"], "created");
        assert_eq!(v["panels"]["rightWhenNarrow"], true);
        assert_eq!(v["drafts"]["w1"]["s1"], "half a thought");
        assert_eq!(v["viewed"]["w1"]["src/a.rs"], "9f2c01aa");
    }

    #[test]
    fn partial_state_keeps_defaults_for_the_rest() {
        let s = State::parse(r#"{"sort":"created","panels":{"bottom":false},"later":1}"#).unwrap();
        assert_eq!(s.sort, SortMode::Created);
        assert!(!s.panels.bottom);
        assert!(s.panels.sidebar);
    }

    #[test]
    fn a_state_that_does_not_parse_becomes_dot_bad() {
        let dir = temp_dir("state-bad");
        let path = dir.join("state.json");
        std::fs::write(&path, r#"{"sort":"sideways"}"#).unwrap();
        let loaded = load_or_recover(&path, State::parse);
        assert_eq!(loaded.value, State::default());
        assert_eq!(loaded.outcome, LoadOutcome::Bad { renamed: true });
        assert!(dir.join("state.json.bad").exists());
    }

    #[test]
    fn drafts_are_per_workspace_and_tab_and_empty_ones_are_removed() {
        let mut s = State::default();
        s.set_draft("w1", "s1", "a");
        s.set_draft("w1", "s2", "b");
        s.set_draft("w2", "s1", "c");
        assert_eq!(s.draft("w1", "s2"), Some("b"));
        assert_eq!(s.draft("w2", "s2"), None);
        s.set_draft("w1", "s1", "");
        s.set_draft("w1", "s2", "");
        assert!(!s.drafts.contains_key("w1"));
        assert_eq!(s.draft("w2", "s1"), Some("c"));
    }

    #[test]
    fn viewed_marks_clear_when_the_diff_changes() {
        let mut s = State::default();
        s.set_viewed("w1", "a.rs", "h1", true);
        assert!(s.is_viewed("w1", "a.rs", "h1"));
        assert!(!s.is_viewed("w1", "a.rs", "h2"));
        assert!(!s.is_viewed("w2", "a.rs", "h1"));
        s.set_viewed("w1", "a.rs", "h1", false);
        assert!(s.viewed.is_empty());
    }

    #[test]
    fn forgetting_a_workspace_drops_its_drafts_and_marks() {
        let mut s = sample();
        s.forget_workspace("w1");
        assert!(s.drafts.is_empty() && s.viewed.is_empty());
        assert_eq!(s.last_workspace, None);
    }

    #[test]
    fn window_frame_is_held_to_the_minimum_size() {
        let f = WindowFrame {
            x: 0.,
            y: 0.,
            width: 500.,
            height: 900.,
        };
        let c = f.clamped((900., 600.)).unwrap();
        assert_eq!((c.width, c.height), (900., 900.));
        let nan = WindowFrame { x: f32::NAN, ..f };
        assert_eq!(nan.clamped((900., 600.)), None);
    }
}
