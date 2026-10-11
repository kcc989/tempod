use std::future::Future;
use std::io;
use std::sync::Arc;

use tokio::sync::{oneshot, watch};

/// App-wide signals the runtime raises for the UI (07, Sign-in and Live state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    /// A 401 from `/api/v1` or a channel upgrade: every channel of that client is closed. Delete
    /// the token and show **Connect to Tempo**.
    Unauthorized,
    /// Close code 4400: show the update screen and stop.
    UpdateRequired,
}

const SIGNAL_CAPACITY: usize = 64;

/// The tokio runtime that does all HTTP and WebSocket I/O (07, Threads): 2 worker threads, started
/// before GPUI, alive until dropped. It never touches GPUI.
pub struct Runtime {
    tokio: Option<tokio::runtime::Runtime>,
    handle: RuntimeHandle,
}

impl Runtime {
    pub const WORKER_THREADS: usize = 2;

    pub fn start() -> io::Result<Self> {
        let tokio = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(Self::WORKER_THREADS)
            .thread_name("tempo-io")
            .enable_io()
            .enable_time()
            .build()?;
        let handle = RuntimeHandle::from_tokio(tokio.handle().clone());
        Ok(Self {
            tokio: Some(tokio),
            handle,
        })
    }

    pub fn handle(&self) -> RuntimeHandle {
        self.handle.clone()
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(rt) = self.tokio.take() {
            rt.shutdown_background();
        }
    }
}

/// A cheap, cloneable handle to the runtime. Futures it returns resolve through
/// `tokio::sync::oneshot`, so any executor can await them.
#[derive(Clone)]
pub struct RuntimeHandle {
    shared: Arc<Shared>,
}

struct Shared {
    tokio: tokio::runtime::Handle,
    signals_tx: async_channel::Sender<Signal>,
    signals_rx: async_channel::Receiver<Signal>,
    wake: watch::Sender<u64>,
}

impl RuntimeHandle {
    /// Wraps an existing tokio runtime (tests, or code already running on one).
    pub fn from_tokio(tokio: tokio::runtime::Handle) -> Self {
        let (signals_tx, signals_rx) = async_channel::bounded(SIGNAL_CAPACITY);
        Self {
            shared: Arc::new(Shared {
                tokio,
                signals_tx,
                signals_rx,
                wake: watch::Sender::new(0),
            }),
        }
    }

    /// The handle of the tokio runtime this is called from. Panics outside one.
    pub fn current() -> Self {
        Self::from_tokio(tokio::runtime::Handle::current())
    }

    pub fn tokio(&self) -> &tokio::runtime::Handle {
        &self.shared.tokio
    }

    /// The runtime's signals. One reader (the app) should hold it.
    pub fn signals(&self) -> async_channel::Receiver<Signal> {
        self.shared.signals_rx.clone()
    }

    /// Wake from sleep (`NSWorkspaceDidWakeNotification`): every channel reconnects at once.
    pub fn reconnect_all(&self) {
        self.shared.wake.send_modify(|n| *n = n.wrapping_add(1));
    }

    pub(crate) fn wake_receiver(&self) -> watch::Receiver<u64> {
        self.shared.wake.subscribe()
    }

    pub(crate) fn signal(&self, signal: Signal) {
        let _ = self.shared.signals_tx.try_send(signal);
    }

    /// Runs `fut` on tokio and returns a future of its output that works on any executor. Dropping
    /// the returned future cancels `fut`. `None` means the runtime shut down first.
    pub fn run<T: Send + 'static>(
        &self,
        fut: impl Future<Output = T> + Send + 'static,
    ) -> impl Future<Output = Option<T>> + Send + 'static {
        let (mut tx, rx) = oneshot::channel();
        self.shared.tokio.spawn(async move {
            tokio::select! {
                () = tx.closed() => {}
                value = fut => {
                    let _ = tx.send(value);
                }
            }
        });
        async move { rx.await.ok() }
    }
}

impl std::fmt::Debug for RuntimeHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeHandle").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_builds_two_workers_and_runs_futures_for_other_executors() {
        let rt = Runtime::start().expect("runtime starts");
        let handle = rt.handle();
        assert_eq!(handle.tokio().metrics().num_workers(), 2);
        let fut = handle.run(async { tokio::runtime::Handle::try_current().is_ok() });
        let out = std::thread::spawn(move || block_on(fut)).join().expect("joins");
        assert_eq!(out, Some(true));
    }

    #[test]
    fn dropping_the_runtime_cancels_pending_work() {
        let rt = Runtime::start().expect("runtime starts");
        let fut = rt.handle().run(std::future::pending::<()>());
        drop(rt);
        assert_eq!(block_on(fut), None);
    }

    fn block_on<F: Future>(fut: F) -> F::Output {
        let mut fut = std::pin::pin!(fut);
        let waker = std::task::Waker::from(Arc::new(ThreadWaker(std::thread::current())));
        let mut cx = std::task::Context::from_waker(&waker);
        loop {
            if let std::task::Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
                return v;
            }
            std::thread::park();
        }
    }

    struct ThreadWaker(std::thread::Thread);

    impl std::task::Wake for ThreadWaker {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
}
