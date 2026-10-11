//! Local storage (07, Local storage and settings): `config.toml` and `state.json`. The token is in
//! the Keychain (`crate::platform`); logs are in `crate::logging`. Nothing else goes to disk.
mod config;
mod file;
mod saver;
mod state;

pub use config::{Config, Theme};
pub use file::{LoadOutcome, Loaded, bad_path, load_or_recover, write_atomic};
pub use saver::{Debounce, STATE_SAVE_DELAY, STATE_SAVE_MAX_WAIT, Saver};
pub use state::{DiffViewMode, PaneSizes, Panels, SortMode, State, WindowFrame};

use crate::logging;
use serde_json::json;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "config.toml";
pub const STATE_FILE: &str = "state.json";

pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// `~/Library/Application Support/dev.tempo.mac` on macOS. On other systems (the Linux build
/// machine) `$XDG_DATA_HOME/dev.tempo.mac`, else `~/.local/share/dev.tempo.mac`.
pub fn support_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(
            home()?
                .join("Library/Application Support")
                .join(crate::BUNDLE_ID),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(|| Some(home()?.join(".local/share")))?;
        Some(base.join(crate::BUNDLE_ID))
    }
}

pub fn load_config(dir: &Path) -> Loaded<Config> {
    let loaded = load_or_recover(&dir.join(CONFIG_FILE), Config::parse);
    log_outcome(CONFIG_FILE, &loaded.outcome);
    loaded
}

pub fn load_state(dir: &Path) -> Loaded<State> {
    let loaded = load_or_recover(&dir.join(STATE_FILE), State::parse);
    log_outcome(STATE_FILE, &loaded.outcome);
    loaded
}

fn log_outcome(file: &str, outcome: &LoadOutcome) {
    match outcome {
        LoadOutcome::Missing | LoadOutcome::Loaded => {}
        LoadOutcome::Bad { renamed } => logging::warn(
            "storage",
            "file did not parse; using defaults",
            json!({"file": file, "renamedToBad": renamed}),
        ),
        LoadOutcome::Unreadable(kind) => logging::warn(
            "storage",
            "file could not be read; using defaults",
            json!({"file": file, "error": kind.to_string()}),
        ),
    }
}

/// The loaded config and state, kept as a GPUI global. Every change is saved off the main thread.
pub struct Local {
    config: Config,
    state: State,
    saver: Saver,
}

impl gpui_kit::Global for Local {}

impl Local {
    /// Loads both files from `dir` (or uses defaults with no folder) and starts the saver.
    pub fn load(dir: Option<PathBuf>) -> Self {
        let (config, state) = match &dir {
            Some(dir) => (load_config(dir).value, load_state(dir).value),
            None => (Config::default(), State::default()),
        };
        Self {
            config,
            state,
            saver: Saver::start(dir, Debounce::default()),
        }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn update_config(&mut self, f: impl FnOnce(&mut Config)) {
        let before = self.config.clone();
        f(&mut self.config);
        if self.config != before {
            self.saver.save_config(self.config.clone());
        }
    }

    pub fn update_state(&mut self, f: impl FnOnce(&mut State)) {
        let before = self.state.clone();
        f(&mut self.state);
        if self.state != before {
            self.saver.save_state(self.state.clone());
        }
    }

    /// Resolves once every change is on disk.
    pub fn flush(&self) -> async_channel::Receiver<()> {
        self.saver.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use file::tests::temp_dir;

    #[test]
    fn local_loads_saves_and_reloads() {
        let dir = temp_dir("local");
        let mut local = Local::load(Some(dir.clone()));
        assert_eq!(local.config(), &Config::default());
        local.update_config(|c| c.url = Some("https://tempo.example.com".into()));
        local.update_state(|s| s.sort = SortMode::Created);
        local.flush().recv_blocking().unwrap();
        let again = Local::load(Some(dir));
        assert_eq!(
            again.config().url.as_deref(),
            Some("https://tempo.example.com")
        );
        assert_eq!(again.state().sort, SortMode::Created);
    }

    #[test]
    fn local_recovers_from_bad_files() {
        let dir = temp_dir("local-bad");
        std::fs::write(dir.join(CONFIG_FILE), "url = [").unwrap();
        std::fs::write(dir.join(STATE_FILE), "{").unwrap();
        let local = Local::load(Some(dir.clone()));
        assert_eq!(local.config(), &Config::default());
        assert_eq!(local.state(), &State::default());
        assert!(dir.join("config.toml.bad").exists());
        assert!(dir.join("state.json.bad").exists());
    }

    #[test]
    fn unchanged_updates_write_nothing() {
        let dir = temp_dir("local-same");
        let mut local = Local::load(Some(dir.clone()));
        local.update_config(|_| {});
        local.update_state(|s| s.sort = SortMode::Activity);
        local.flush().recv_blocking().unwrap();
        assert!(!dir.join(CONFIG_FILE).exists());
        assert!(!dir.join(STATE_FILE).exists());
    }

    #[test]
    fn support_dir_ends_with_the_bundle_id() {
        if let Some(dir) = support_dir() {
            assert!(dir.ends_with(crate::BUNDLE_ID));
        }
    }
}
