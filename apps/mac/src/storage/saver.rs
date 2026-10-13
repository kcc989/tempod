use super::{Config, State, file::write_atomic};
use crate::logging;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

/// `state.json` is written this long after the last change…
pub const STATE_SAVE_DELAY: Duration = Duration::from_millis(500);
/// …or this long after the first unsaved change, whichever comes first.
pub const STATE_SAVE_MAX_WAIT: Duration = Duration::from_secs(5);

/// When a debounced save is due. Pure: the caller passes the clock.
#[derive(Clone, Copy, Debug)]
pub struct Debounce {
    delay: Duration,
    max_wait: Duration,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Default for Debounce {
    fn default() -> Self {
        Self::new(STATE_SAVE_DELAY, STATE_SAVE_MAX_WAIT)
    }
}

impl Debounce {
    pub fn new(delay: Duration, max_wait: Duration) -> Self {
        Self {
            delay,
            max_wait,
            first: None,
            last: None,
        }
    }

    pub fn changed(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    pub fn is_pending(&self) -> bool {
        self.last.is_some()
    }

    pub fn deadline(&self) -> Option<Instant> {
        Some((self.last? + self.delay).min(self.first? + self.max_wait))
    }

    /// True once the deadline has passed; the pending change then counts as saved.
    pub fn take_due(&mut self, now: Instant) -> bool {
        let due = self.deadline().is_some_and(|d| now >= d);
        if due {
            self.reset();
        }
        due
    }

    /// For a flush: true if a change was pending, which then counts as saved.
    pub fn take_pending(&mut self) -> bool {
        let pending = self.is_pending();
        self.reset();
        pending
    }

    fn reset(&mut self) {
        self.first = None;
        self.last = None;
    }
}

enum Job {
    Config(Box<Config>),
    State(Box<State>),
    Flush(async_channel::Sender<()>),
}

/// Writes `config.yaml` and `state.json` on its own thread, so the GPUI main thread does no file
/// I/O (07, Threads). Config writes go out at once; state writes are debounced.
pub struct Saver {
    tx: Option<mpsc::Sender<Job>>,
}

impl Saver {
    /// Writes into `dir`. With no folder (no home directory) nothing is written.
    pub fn start(dir: Option<PathBuf>, debounce: Debounce) -> Self {
        let Some(dir) = dir else {
            return Self { tx: None };
        };
        let (tx, rx) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("tempo-storage".into())
            .spawn(move || run(&dir, debounce, rx));
        Self {
            tx: spawned.ok().map(|_| tx),
        }
    }

    pub fn save_config(&self, config: Config) {
        self.send(Job::Config(Box::new(config)));
    }

    pub fn save_state(&self, state: State) {
        self.send(Job::State(Box::new(state)));
    }

    /// Resolves once everything sent before it is on disk (await it in `on_app_quit`).
    pub fn flush(&self) -> async_channel::Receiver<()> {
        let (ack, done) = async_channel::bounded(1);
        match &self.tx {
            Some(tx) => {
                let _ = tx.send(Job::Flush(ack));
            }
            None => {
                let _ = ack.try_send(());
            }
        }
        done
    }

    fn send(&self, job: Job) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(job);
        }
    }
}

fn run(dir: &Path, mut debounce: Debounce, rx: mpsc::Receiver<Job>) {
    let mut pending: Option<Box<State>> = None;
    loop {
        let job = match debounce.deadline() {
            Some(deadline) => {
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(job) => Some(job),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            None => match rx.recv() {
                Ok(job) => Some(job),
                Err(_) => break,
            },
        };
        match job {
            Some(Job::Config(config)) => write(dir, super::CONFIG_FILE, &config.to_yaml()),
            Some(Job::State(state)) => {
                pending = Some(state);
                debounce.changed(Instant::now());
            }
            Some(Job::Flush(ack)) => {
                if debounce.take_pending() {
                    write_state(dir, pending.take());
                }
                let _ = ack.try_send(());
            }
            None => {}
        }
        if debounce.take_due(Instant::now()) {
            write_state(dir, pending.take());
        }
    }
    write_state(dir, pending.take());
}

fn write_state(dir: &Path, state: Option<Box<State>>) {
    if let Some(state) = state {
        write(dir, super::STATE_FILE, &state.to_json());
    }
}

fn write(dir: &Path, name: &str, text: &str) {
    if let Err(e) = write_atomic(&dir.join(name), text.as_bytes()) {
        logging::warn(
            "storage",
            "write failed",
            json!({"file": name, "error": e.kind().to_string()}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::file::tests::temp_dir;

    const D: Duration = Duration::from_millis(500);
    const MAX: Duration = Duration::from_secs(5);

    #[test]
    fn nothing_is_due_without_a_change() {
        let mut d = Debounce::new(D, MAX);
        assert_eq!(d.deadline(), None);
        assert!(!d.take_due(Instant::now()));
        assert!(!d.take_pending());
    }

    #[test]
    fn a_save_is_due_after_the_delay_from_the_last_change() {
        let t0 = Instant::now();
        let mut d = Debounce::new(D, MAX);
        d.changed(t0);
        d.changed(t0 + Duration::from_millis(300));
        assert_eq!(d.deadline(), Some(t0 + Duration::from_millis(800)));
        assert!(!d.take_due(t0 + Duration::from_millis(799)));
        assert!(d.take_due(t0 + Duration::from_millis(800)));
        assert!(!d.is_pending());
        assert!(!d.take_due(t0 + Duration::from_secs(60)));
    }

    #[test]
    fn steady_changes_still_save_after_the_max_wait() {
        let t0 = Instant::now();
        let mut d = Debounce::new(D, MAX);
        let mut t = t0;
        while t < t0 + Duration::from_millis(4900) {
            d.changed(t);
            assert!(!d.take_due(t));
            t += Duration::from_millis(100);
        }
        d.changed(t);
        assert_eq!(d.deadline(), Some(t0 + MAX));
        assert!(d.take_due(t0 + MAX));
    }

    #[test]
    fn flush_takes_a_pending_change() {
        let mut d = Debounce::new(D, MAX);
        d.changed(Instant::now());
        assert!(d.take_pending());
        assert!(!d.is_pending());
    }

    #[test]
    fn saver_writes_config_at_once_and_the_latest_state_on_flush() {
        let dir = temp_dir("saver");
        let saver = Saver::start(
            Some(dir.clone()),
            Debounce::new(Duration::from_secs(3600), Duration::from_secs(3600)),
        );
        let config = Config {
            sound: false,
            ..Config::default()
        };
        saver.save_config(config.clone());
        let mut state = State::default();
        state.set_draft("w1", "s1", "first");
        saver.save_state(state.clone());
        state.set_draft("w1", "s1", "second");
        saver.save_state(state.clone());
        saver.flush().recv_blocking().unwrap();
        let read = |name| std::fs::read_to_string(dir.join(name)).unwrap();
        assert_eq!(Config::parse(&read("config.yaml")).unwrap(), config);
        assert_eq!(State::parse(&read("state.json")).unwrap(), state);
    }

    #[test]
    fn saver_writes_state_after_the_debounce() {
        let dir = temp_dir("saver-debounce");
        let saver = Saver::start(
            Some(dir.clone()),
            Debounce::new(Duration::from_millis(20), Duration::from_millis(50)),
        );
        let state = State {
            last_workspace: Some("w9".into()),
            ..State::default()
        };
        saver.save_state(state.clone());
        let path = dir.join("state.json");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            State::parse(&std::fs::read_to_string(path).unwrap()).unwrap(),
            state
        );
    }

    #[test]
    fn saver_without_a_folder_writes_nothing_and_flushes_at_once() {
        let saver = Saver::start(None, Debounce::default());
        saver.save_state(State::default());
        assert!(saver.flush().recv_blocking().is_ok());
    }
}
