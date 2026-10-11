//! Bridges alacritty's events to the view.
use alacritty_terminal::event::{Event, EventListener};
use std::sync::mpsc::Sender;

/// Events the view emits (`cx.subscribe` on the `TerminalView` entity).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    /// OSC 0 or 2. An empty title means the title was reset.
    Title(String),
    Bell,
    /// OSC 52 copy. The view does not write the clipboard itself; the app decides.
    ClipboardStore(String),
    /// The output channel closed.
    Exited,
}

/// Queues alacritty's events; the view drains them after each parse.
pub struct EventProxy {
    tx: Sender<Event>,
}

impl EventProxy {
    pub fn new(tx: Sender<Event>) -> Self {
        Self { tx }
    }
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        let _ = self.tx.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn forwards_events() {
        let (tx, rx) = channel();
        let proxy = EventProxy::new(tx);
        proxy.send_event(Event::Bell);
        proxy.send_event(Event::PtyWrite("\x1b[0n".into()));
        assert!(matches!(rx.try_recv(), Ok(Event::Bell)));
        assert!(matches!(rx.try_recv(), Ok(Event::PtyWrite(s)) if s == "\x1b[0n"));
    }

    #[test]
    fn a_dropped_receiver_is_ignored() {
        let (tx, rx) = channel();
        let proxy = EventProxy::new(tx);
        drop(rx);
        proxy.send_event(Event::Wakeup);
    }
}
