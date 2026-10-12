//! The terminal's two channels. The app bridges them to the terminal channel (02; 01, Terminal).
use async_channel::{Receiver, Sender};

/// What the terminal sends to the far end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalInput {
    /// Keystrokes, pasted text and replies to terminal queries.
    Bytes(Vec<u8>),
    /// The grid size changed.
    Resize { cols: u16, rows: u16 },
}

/// `output` carries PTY output into the parser; `input` takes keystrokes and resizes.
/// When `output` closes, the view emits [`crate::TerminalEvent::Exited`].
pub struct TerminalIo {
    pub output: Receiver<Vec<u8>>,
    pub input: Sender<TerminalInput>,
}

/// The far end of [`TerminalIo::pair`].
pub struct TerminalRemote {
    pub output: Sender<Vec<u8>>,
    pub input: Receiver<TerminalInput>,
}

impl TerminalIo {
    /// Output is bounded so the parser applies backpressure to the socket bridge.
    pub fn pair() -> (TerminalIo, TerminalRemote) {
        let (output_tx, output_rx) = async_channel::bounded(1024);
        let (input_tx, input_rx) = async_channel::unbounded();
        (
            TerminalIo {
                output: output_rx,
                input: input_tx,
            },
            TerminalRemote {
                output: output_tx,
                input: input_rx,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_connects_both_directions() {
        let (io, remote) = TerminalIo::pair();
        remote.output.try_send(b"hi".to_vec()).unwrap();
        assert_eq!(io.output.try_recv().unwrap(), b"hi");
        io.input
            .try_send(TerminalInput::Resize { cols: 80, rows: 24 })
            .unwrap();
        assert_eq!(
            remote.input.try_recv().unwrap(),
            TerminalInput::Resize { cols: 80, rows: 24 }
        );
    }
}
