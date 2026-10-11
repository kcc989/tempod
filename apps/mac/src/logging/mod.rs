//! Logs (07, Local storage; 05, Observability): JSON lines in `~/Library/Logs/Tempo/tempo.log`,
//! 5 files of 5 MB. Every record passes through [`redact`]. Records are written on a background
//! thread; a call only queues the record and never blocks.
//!
//! The message is a `&'static str`, so no prompt or transcript text can be formatted into it.
//! Fields carry ids, codes and counts only: MUST NOT pass tokens, secrets, prompts or transcript
//! text (07, AT-37).
mod file;
mod redact;

pub use file::RotatingFile;
pub use redact::{REDACTED, TRUNCATED, is_secret_field, redact};

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE_NAME: &str = "tempo.log";
pub const MAX_FILE_BYTES: u64 = 5_000_000;
pub const FILES: usize = 5;
/// Records queued beyond this are dropped and counted, so a stuck disk never blocks a caller.
pub const QUEUE: usize = 4096;
/// As the Worker and tempod: `info` and up.
pub const MIN_LEVEL: Level = Level::Info;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// `~/Library/Logs/Tempo` on macOS. On other systems `$XDG_STATE_HOME/dev.tempo.mac/logs`, else
/// `~/.local/state/dev.tempo.mac/logs`.
pub fn default_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(
            crate::storage::home()?
                .join("Library/Logs")
                .join(crate::APP_NAME),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let base = std::env::var_os("XDG_STATE_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(|| Some(crate::storage::home()?.join(".local/state")))?;
        Some(base.join(crate::BUNDLE_ID).join("logs"))
    }
}

/// One line, shaped as 05's `{ts, level, msg, ...}` with `target` added. `fields` is redacted
/// first, as `redact(fields)` in the Worker's `log`; a field cannot replace `ts`, `level`, `msg`
/// or `target`.
pub fn format_record(ts_ms: u64, level: Level, target: &str, msg: &str, fields: Value) -> String {
    let text = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut line = format!(
        r#"{{"ts":{ts_ms},"level":"{}","msg":{},"target":{}"#,
        level.as_str(),
        text(msg),
        text(target)
    );
    let extra = match redact(fields) {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => Map::from_iter([("fields".to_string(), other)]),
    };
    for (k, v) in extra {
        if matches!(k.as_str(), "ts" | "level" | "msg" | "target") {
            continue;
        }
        line.push(',');
        line.push_str(&serde_json::to_string(&k).unwrap_or_default());
        line.push(':');
        line.push_str(&serde_json::to_string(&v).unwrap_or_default());
    }
    line.push('}');
    line
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct Record {
    ts_ms: u64,
    level: Level,
    target: &'static str,
    msg: &'static str,
    fields: Value,
}

enum Msg {
    Record(Box<Record>),
    Flush(async_channel::Sender<()>),
}

pub struct Logger {
    tx: mpsc::SyncSender<Msg>,
    dropped: Arc<AtomicU64>,
}

impl Logger {
    /// Opens `<dir>/tempo.log` and starts the writer thread.
    pub fn start(dir: &Path, max_bytes: u64, files: usize) -> std::io::Result<Self> {
        let mut out = RotatingFile::open(dir, FILE_NAME, max_bytes, files)?;
        let (tx, rx) = mpsc::sync_channel::<Msg>(QUEUE);
        let dropped = Arc::new(AtomicU64::new(0));
        let lost = dropped.clone();
        std::thread::Builder::new()
            .name("tempo-log".into())
            .spawn(move || {
                while let Ok(msg) = rx.recv() {
                    match msg {
                        Msg::Record(r) => {
                            let line = format_record(r.ts_ms, r.level, r.target, r.msg, r.fields);
                            let _ = out.write_line(&line);
                        }
                        Msg::Flush(ack) => {
                            let _ = out.sync();
                            let _ = ack.try_send(());
                        }
                    }
                    let n = lost.swap(0, Ordering::Relaxed);
                    if n > 0 {
                        let line = format_record(
                            now_ms(),
                            Level::Warn,
                            "logging",
                            "log records dropped",
                            serde_json::json!({ "count": n }),
                        );
                        let _ = out.write_line(&line);
                    }
                }
            })?;
        Ok(Self { tx, dropped })
    }

    pub fn log(&self, level: Level, target: &'static str, msg: &'static str, fields: Value) {
        if level < MIN_LEVEL {
            return;
        }
        let record = Record {
            ts_ms: now_ms(),
            level,
            target,
            msg,
            fields,
        };
        if let Err(mpsc::TrySendError::Full(_)) = self.tx.try_send(Msg::Record(Box::new(record))) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Resolves once every record queued before it is written and synced (at once if the queue
    /// is full, so it never blocks).
    pub fn flush(&self) -> async_channel::Receiver<()> {
        let (ack, done) = async_channel::bounded(1);
        if self.tx.try_send(Msg::Flush(ack.clone())).is_err() {
            let _ = ack.try_send(());
        }
        done
    }
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// Starts the app's logger once. Records logged before this, or after a failed start, are dropped.
pub fn init(dir: &Path) -> std::io::Result<()> {
    if LOGGER.get().is_some() {
        return Ok(());
    }
    let logger = Logger::start(dir, MAX_FILE_BYTES, FILES)?;
    let _ = LOGGER.set(logger);
    Ok(())
}

pub fn log(level: Level, target: &'static str, msg: &'static str, fields: Value) {
    if let Some(logger) = LOGGER.get() {
        logger.log(level, target, msg, fields);
    }
}

pub fn debug(target: &'static str, msg: &'static str, fields: Value) {
    log(Level::Debug, target, msg, fields);
}

pub fn info(target: &'static str, msg: &'static str, fields: Value) {
    log(Level::Info, target, msg, fields);
}

pub fn warn(target: &'static str, msg: &'static str, fields: Value) {
    log(Level::Warn, target, msg, fields);
}

pub fn error(target: &'static str, msg: &'static str, fields: Value) {
    log(Level::Error, target, msg, fields);
}

/// Resolves once the app's logger has written everything queued (or at once without one).
pub fn flush() -> async_channel::Receiver<()> {
    match LOGGER.get() {
        Some(logger) => logger.flush(),
        None => {
            let (ack, done) = async_channel::bounded(1);
            let _ = ack.try_send(());
            done
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tempo-mac-logger-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn record_has_the_05_shape_and_is_redacted() {
        let line = format_record(
            1_760_000_000_000,
            Level::Warn,
            "client",
            "reconnecting",
            json!({"workspaceId": "w1", "headers": {"authorization": "Bearer t"}, "attempt": 3}),
        );
        assert!(line.starts_with(
            r#"{"ts":1760000000000,"level":"warn","msg":"reconnecting","target":"client","#
        ));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            v,
            json!({
                "ts": 1_760_000_000_000u64,
                "level": "warn",
                "msg": "reconnecting",
                "target": "client",
                "workspaceId": "w1",
                "headers": {"authorization": REDACTED},
                "attempt": 3,
            })
        );
        assert!(!line.contains("Bearer"));
    }

    #[test]
    fn top_level_secret_fields_are_redacted_and_fixed_keys_win() {
        let line = format_record(
            1,
            Level::Info,
            "auth",
            "signed in",
            json!({"accessToken": "abc", "msg": "spoof", "level": "error"}),
        );
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["accessToken"], REDACTED);
        assert_eq!(v["msg"], "signed in");
        assert_eq!(v["level"], "info");
        assert!(!line.contains("abc"));
    }

    #[test]
    fn null_fields_add_nothing() {
        let line = format_record(5, Level::Error, "t", "m", Value::Null);
        assert_eq!(line, r#"{"ts":5,"level":"error","msg":"m","target":"t"}"#);
    }

    #[test]
    fn logger_writes_json_lines_off_thread_and_drops_debug() {
        let dir = temp_dir("lines");
        let logger = Logger::start(&dir, MAX_FILE_BYTES, FILES).unwrap();
        logger.log(Level::Debug, "t", "hidden", json!({}));
        logger.log(Level::Info, "t", "shown", json!({"cookie": "c", "n": 1}));
        logger.log(Level::Error, "t", "failed", json!({"code": "NOT_FOUND"}));
        logger.flush().recv_blocking().unwrap();
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["msg"], "shown");
        assert_eq!(lines[0]["cookie"], REDACTED);
        assert_eq!(lines[1]["level"], "error");
        assert!(!text.contains("\"c\""));
    }

    #[test]
    fn logger_rotates_at_its_limit() {
        let dir = temp_dir("rotate");
        let logger = Logger::start(&dir, 200, 3).unwrap();
        for i in 0..40 {
            logger.log(Level::Info, "t", "tick", json!({ "i": i }));
        }
        logger.flush().recv_blocking().unwrap();
        assert!(dir.join("tempo.log.1").exists());
        assert!(dir.join("tempo.log.2").exists());
        assert!(!dir.join("tempo.log.3").exists());
        for name in ["tempo.log", "tempo.log.1", "tempo.log.2"] {
            assert!(std::fs::metadata(dir.join(name)).unwrap().len() <= 200);
        }
    }

    #[test]
    fn default_dir_is_set_when_home_is() {
        if crate::storage::home().is_some() {
            assert!(default_dir().is_some());
        }
    }
}
