//! Settings → Shell (04): the owner's shell files (01, Shell and dotfiles). The path and size
//! rules match `isDotfilePath` and `dotfilesProblem` in `packages/protocol/src/dotfiles.ts`.
use tempo_protocol as p;

pub const HELP: &str = "Terminals use zsh. Changes apply when a workspace starts or wakes. Don't put secrets here; use Environments.";
pub const DESCRIPTION: &str = "Shell files for your workspace terminals.";
pub const EMPTY: &str = "No shell files. Workspaces use the image defaults.";
pub const SAVED: &str = "Shell files saved";
pub const PATH_PLACEHOLDER: &str = ".gitconfig";
pub const PATH_INVALID: &str = "Enter a path in your home folder, such as .gitconfig. Tempo and agent folders such as .ssh and .claude are not allowed.";

pub const FILES_MAX: usize = 20;
pub const PATH_MAX: usize = 200;
pub const FILE_MAX_BYTES: usize = 64 * 1024;
pub const TOTAL_MAX_BYTES: usize = 256 * 1024;

/// Agent state, Tempo state and credentials stay out of reach.
pub const RESERVED: [&str; 7] = [
    ".tempod",
    ".claude",
    ".codex",
    ".pi",
    ".local/share/opencode",
    ".ssh",
    "attachments",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dotfile {
    pub path: String,
    pub content: String,
}

impl Dotfile {
    fn new(path: &str, content: &str) -> Self {
        Self {
            path: path.to_owned(),
            content: content.to_owned(),
        }
    }
}

fn is_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

pub fn is_dotfile_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= PATH_MAX
        && path.split('/').all(is_segment)
        && !RESERVED
            .iter()
            .any(|r| path == *r || path.strip_prefix(r).is_some_and(|t| t.starts_with('/')))
}

/// Size and duplicate checks the path rule cannot express: the first problem, or none.
pub fn dotfiles_problem(files: &[Dotfile]) -> Option<String> {
    let mut seen: Vec<&str> = vec![];
    let mut total = 0;
    let nested = |a: &str, b: &str| a.strip_prefix(b).is_some_and(|t| t.starts_with('/'));
    for f in files {
        if seen.contains(&f.path.as_str()) {
            return Some(format!("{} is listed twice.", f.path));
        }
        if seen
            .iter()
            .any(|p| nested(&f.path, p) || nested(p, &f.path))
        {
            return Some(format!("{} conflicts with another path.", f.path));
        }
        seen.push(&f.path);
        if f.content.len() > FILE_MAX_BYTES {
            return Some(format!("{} is larger than 64 KB.", f.path));
        }
        total += f.content.len();
    }
    (total > TOTAL_MAX_BYTES).then(|| "Shell files are larger than 256 KB in total.".to_owned())
}

/// The page's edits: the list being edited, the saved list for Reset, and the image defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct ShellDraft {
    pub files: Vec<Dotfile>,
    saved: Vec<Dotfile>,
    defaults: Vec<Dotfile>,
    selected: Option<String>,
}

impl ShellDraft {
    /// Keeps `selected` when the new list still has it, else selects the first file.
    pub fn from_state(state: &p::GetDotfilesOut, selected: Option<&str>) -> Self {
        let files: Vec<_> = state
            .files
            .iter()
            .map(|f| Dotfile::new(&f.path, &f.content))
            .collect();
        let mut draft = Self {
            saved: files.clone(),
            files,
            defaults: state
                .defaults
                .iter()
                .map(|f| Dotfile::new(&f.path, &f.content))
                .collect(),
            selected: selected.map(str::to_owned),
        };
        draft.fix_selection();
        draft
    }

    fn fix_selection(&mut self) {
        if !self
            .files
            .iter()
            .any(|f| Some(&f.path) == self.selected.as_ref())
        {
            self.selected = self.files.first().map(|f| f.path.clone());
        }
    }

    pub fn current(&self) -> Option<&Dotfile> {
        self.files
            .iter()
            .find(|f| Some(&f.path) == self.selected.as_ref())
    }

    pub fn select(&mut self, path: &str) {
        self.selected = Some(path.to_owned());
        self.fix_selection();
    }

    pub fn set_content(&mut self, path: &str, content: &str) {
        if let Some(f) = self.files.iter_mut().find(|f| f.path == path) {
            content.clone_into(&mut f.content);
        }
    }

    pub fn dirty(&self) -> bool {
        self.files != self.saved
    }

    pub fn can_add(&self) -> bool {
        self.files.len() < FILES_MAX
    }

    /// Adds an empty file at the trimmed `path` and selects it, or returns the inline error.
    pub fn add(&mut self, path: &str) -> Result<(), String> {
        let path = path.trim();
        if !is_dotfile_path(path) {
            return Err(PATH_INVALID.into());
        }
        let mut files: Vec<_> = self
            .files
            .iter()
            .map(|f| Dotfile::new(&f.path, ""))
            .collect();
        files.push(Dotfile::new(path, ""));
        if let Some(problem) = dotfiles_problem(&files) {
            return Err(problem);
        }
        self.files.push(Dotfile::new(path, ""));
        self.selected = Some(path.to_owned());
        Ok(())
    }

    pub fn remove(&mut self, path: &str) {
        self.files.retain(|f| f.path != path);
        self.fix_selection();
    }

    /// Reset to defaults: replaces the list without saving.
    pub fn reset_to_defaults(&mut self) {
        self.files = self.defaults.clone();
        self.selected = None;
        self.fix_selection();
    }

    /// The Save bar's Reset: back to the saved list.
    pub fn reset(&mut self) {
        self.files = self.saved.clone();
        self.fix_selection();
    }

    /// The `updateDotfiles` input with the whole list, or the first problem.
    pub fn save_input(&self) -> Result<p::UpdateDotfilesIn, String> {
        if let Some(problem) = dotfiles_problem(&self.files) {
            return Err(problem);
        }
        Ok(p::UpdateDotfilesIn {
            files: self
                .files
                .iter()
                .map(|f| p::UpdateDotfilesInFilesItem {
                    path: f.path.clone(),
                    content: f.content.clone(),
                })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> p::GetDotfilesOut {
        serde_json::from_value(serde_json::json!({
            "files": [
                {"path": ".zshrc", "content": "export A=1\n"},
                {"path": ".tmux.conf", "content": "set -g status off\n"}
            ],
            "defaults": [
                {"path": ".zshrc", "content": "default zshrc\n"},
                {"path": ".tmux.conf", "content": "default tmux\n"}
            ],
            "saved": true,
            "updatedAt": 1.0
        }))
        .unwrap()
    }

    #[test]
    fn paths_follow_is_dotfile_path() {
        for ok in [
            ".zshrc",
            ".config/starship.toml",
            ".gitconfig",
            "bin/my-tool_v1+x",
            ".sshrc",
            ".local/share/other",
            "...",
        ] {
            assert!(is_dotfile_path(ok), "{ok}");
        }
        let long = "a".repeat(PATH_MAX + 1);
        for bad in [
            "",
            ".ssh",
            ".ssh/config",
            ".claude/settings.json",
            ".local/share/opencode/auth.json",
            "attachments",
            "..",
            "../etc/passwd",
            "a/../b",
            "./a",
            "a//b",
            "/abs",
            "a/",
            "with space",
            "ünï",
            long.as_str(),
        ] {
            assert!(!is_dotfile_path(bad), "{bad}");
        }
        assert!(is_dotfile_path(&"a".repeat(PATH_MAX)));
    }

    #[test]
    fn problems_report_duplicates_conflicts_and_sizes_in_order() {
        let f = Dotfile::new;
        assert_eq!(
            dotfiles_problem(&[f(".zshrc", ""), f(".tmux.conf", "")]),
            None
        );
        assert_eq!(
            dotfiles_problem(&[f(".zshrc", ""), f(".zshrc", "")]).as_deref(),
            Some(".zshrc is listed twice.")
        );
        assert_eq!(
            dotfiles_problem(&[f(".config", ""), f(".config/a", "")]).as_deref(),
            Some(".config/a conflicts with another path.")
        );
        assert_eq!(
            dotfiles_problem(&[f(".config/a", ""), f(".config", "")]).as_deref(),
            Some(".config conflicts with another path.")
        );
        assert_eq!(dotfiles_problem(&[f(".conf", ""), f(".config", "")]), None);
        let max = "x".repeat(FILE_MAX_BYTES);
        assert_eq!(dotfiles_problem(&[f(".a", &max)]), None);
        assert_eq!(
            dotfiles_problem(&[f(".a", &format!("{max}x"))]).as_deref(),
            Some(".a is larger than 64 KB.")
        );
        assert_eq!(
            dotfiles_problem(&[f(".a", &"é".repeat(FILE_MAX_BYTES / 2 + 1))]).as_deref(),
            Some(".a is larger than 64 KB."),
            "bytes, not characters"
        );
        let four: Vec<_> = (0..4).map(|i| f(&format!(".f{i}"), &max)).collect();
        assert_eq!(dotfiles_problem(&four), None);
        let mut five = four.clone();
        five.push(f(".f4", "x"));
        assert_eq!(
            dotfiles_problem(&five).as_deref(),
            Some("Shell files are larger than 256 KB in total.")
        );
    }

    #[test]
    fn edits_mark_the_draft_dirty_and_save_sends_the_whole_list() {
        let mut draft = ShellDraft::from_state(&state(), None);
        assert_eq!(draft.current().unwrap().path, ".zshrc");
        assert!(!draft.dirty());
        draft.set_content(".tmux.conf", "set -g mouse on\n");
        assert!(draft.dirty());
        draft.add(" .gitconfig ").unwrap();
        assert_eq!(draft.current().unwrap().path, ".gitconfig");
        let json = serde_json::to_value(draft.save_input().unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"files": [
                {"path": ".zshrc", "content": "export A=1\n"},
                {"path": ".tmux.conf", "content": "set -g mouse on\n"},
                {"path": ".gitconfig", "content": ""}
            ]})
        );
        draft.reset();
        assert!(!draft.dirty());
        assert_eq!(draft.current().unwrap().path, ".zshrc");
    }

    #[test]
    fn add_rejects_bad_paths_conflicts_and_a_full_list() {
        let mut draft = ShellDraft::from_state(&state(), None);
        assert_eq!(draft.add(".ssh/config"), Err(PATH_INVALID.into()));
        assert_eq!(draft.add("a//b"), Err(PATH_INVALID.into()));
        assert_eq!(
            draft.add(".zshrc"),
            Err(".zshrc is listed twice.".to_owned())
        );
        assert_eq!(
            draft.add(".zshrc/x"),
            Err(".zshrc/x conflicts with another path.".to_owned())
        );
        assert!(!draft.dirty());
        for i in 2..FILES_MAX {
            assert!(draft.can_add());
            draft.add(&format!(".f{i}")).unwrap();
        }
        assert!(!draft.can_add());
    }

    #[test]
    fn remove_and_reset_to_defaults_keep_a_valid_selection_without_saving() {
        let mut draft = ShellDraft::from_state(&state(), Some(".tmux.conf"));
        assert_eq!(draft.current().unwrap().path, ".tmux.conf");
        draft.remove(".tmux.conf");
        assert_eq!(draft.current().unwrap().path, ".zshrc");
        draft.remove(".zshrc");
        assert!(draft.current().is_none());
        assert_eq!(draft.save_input().unwrap().files, vec![]);
        draft.reset_to_defaults();
        assert!(draft.dirty());
        assert_eq!(
            draft.files,
            [
                Dotfile::new(".zshrc", "default zshrc\n"),
                Dotfile::new(".tmux.conf", "default tmux\n")
            ]
        );
        assert_eq!(draft.current().unwrap().path, ".zshrc");
        let gone = ShellDraft::from_state(&state(), Some(".gone"));
        assert_eq!(gone.current().unwrap().path, ".zshrc");
    }

    #[test]
    fn save_reports_the_first_problem_instead_of_an_input() {
        let mut draft = ShellDraft::from_state(&state(), None);
        draft.set_content(".zshrc", &"x".repeat(FILE_MAX_BYTES + 1));
        assert_eq!(
            draft.save_input(),
            Err(".zshrc is larger than 64 KB.".to_owned())
        );
    }
}
