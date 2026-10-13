use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Writes `bytes` to `path` through a temp file in the same folder: write, fsync, rename. A reader
/// sees the old file or the new one, never a partial write.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = write_new(&tmp, bytes).and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// What happened when a file was loaded. Parse errors are not kept: their text can quote the file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadOutcome {
    Missing,
    Loaded,
    /// The file did not parse. It was renamed to `<name>.bad` (when `renamed`) and defaults are used.
    Bad {
        renamed: bool,
    },
    /// The file could not be read; defaults are used and the file is left alone.
    Unreadable(io::ErrorKind),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Loaded<T> {
    pub value: T,
    pub outcome: LoadOutcome,
}

/// `<name>.bad` next to `path`.
pub fn bad_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bad");
    path.with_file_name(name)
}

/// Reads and parses `path`. A file that does not parse is renamed to `<name>.bad` and the
/// default is used (07, Local storage).
pub fn load_or_recover<T: Default, E>(
    path: &Path,
    parse: impl FnOnce(&str) -> Result<T, E>,
) -> Loaded<T> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Loaded {
                value: T::default(),
                outcome: LoadOutcome::Missing,
            };
        }
        Err(e) => {
            return Loaded {
                value: T::default(),
                outcome: LoadOutcome::Unreadable(e.kind()),
            };
        }
    };
    let parsed = std::str::from_utf8(&bytes).ok().and_then(|t| parse(t).ok());
    match parsed {
        Some(value) => Loaded {
            value,
            outcome: LoadOutcome::Loaded,
        },
        None => Loaded {
            value: T::default(),
            outcome: LoadOutcome::Bad {
                renamed: fs::rename(path, bad_path(path)).is_ok(),
            },
        },
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fresh, empty folder under the system temp dir.
    pub fn temp_dir(tag: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tempo-mac-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn parse_number(text: &str) -> Result<u32, std::num::ParseIntError> {
        text.trim().parse()
    }

    #[test]
    fn atomic_write_replaces_the_file_and_leaves_no_temp_files() {
        let dir = temp_dir("atomic");
        let path = dir.join("nested").join("state.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["state.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_is_private_to_the_owner() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = temp_dir("mode");
        let path = dir.join("config.yaml");
        write_atomic(&path, b"x").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn atomic_write_fails_without_touching_the_target_when_the_folder_is_a_file() {
        let dir = temp_dir("atomic-fail");
        let blocker = dir.join("blocker");
        fs::write(&blocker, "x").unwrap();
        assert!(write_atomic(&blocker.join("state.json"), b"y").is_err());
        assert_eq!(fs::read_to_string(&blocker).unwrap(), "x");
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = temp_dir("missing");
        let loaded = load_or_recover(&dir.join("state.json"), parse_number);
        assert_eq!(loaded.value, 0);
        assert_eq!(loaded.outcome, LoadOutcome::Missing);
    }

    #[test]
    fn good_file_loads() {
        let dir = temp_dir("good");
        let path = dir.join("n.txt");
        fs::write(&path, "42\n").unwrap();
        let loaded = load_or_recover(&path, parse_number);
        assert_eq!(loaded.value, 42);
        assert_eq!(loaded.outcome, LoadOutcome::Loaded);
    }

    #[test]
    fn bad_file_is_renamed_to_dot_bad_and_defaults_are_used() {
        let dir = temp_dir("bad");
        let path = dir.join("state.json");
        fs::write(dir.join("state.json.bad"), "older").unwrap();
        fs::write(&path, "not a number").unwrap();
        let loaded = load_or_recover(&path, parse_number);
        assert_eq!(loaded.value, 0);
        assert_eq!(loaded.outcome, LoadOutcome::Bad { renamed: true });
        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(dir.join("state.json.bad")).unwrap(),
            "not a number"
        );
    }

    #[test]
    fn invalid_utf8_counts_as_not_parsing() {
        let dir = temp_dir("utf8");
        let path = dir.join("config.yaml");
        fs::write(&path, [0xff, 0xfe, b'1']).unwrap();
        let loaded = load_or_recover(&path, parse_number);
        assert_eq!(loaded.outcome, LoadOutcome::Bad { renamed: true });
        assert!(bad_path(&path).exists());
    }

    #[test]
    fn bad_path_appends_the_suffix() {
        assert_eq!(
            bad_path(Path::new("/a/config.yaml")),
            Path::new("/a/config.yaml.bad")
        );
    }
}
