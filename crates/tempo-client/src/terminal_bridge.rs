//! The user's terminal forwards bytes to the cloud PTY; it never runs workspace commands locally.
use std::fmt;
use std::future::Future;
use std::io;

use crate::{ChannelEvent, Client, CloseReason, Status, TerminalFrame};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub struct TerminalTarget {
    pub workspace_id: String,
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

pub struct TerminalBridgeIo<R, W> {
    pub input: R,
    pub output: W,
    pub resizes: async_channel::Receiver<(u16, u16)>,
}

#[derive(Debug)]
pub enum TerminalBridgeError {
    InvalidTerminal,
    InputBusy,
    Io(io::Error),
    Closed(CloseReason),
}

impl fmt::Display for TerminalBridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidTerminal => "Choose a terminal from t1 to t9.",
            Self::InputBusy => "The terminal input queue is full. Reconnect and try again.",
            Self::Io(_) => "Could not read or write the local terminal.",
            Self::Closed(CloseReason::Unauthorized) => "Sign in to Tempo for Mac again.",
            Self::Closed(CloseReason::NotFound) => "Workspace not found.",
            Self::Closed(CloseReason::UpdateRequired) => {
                "Update Tempo for Mac to use this terminal."
            }
            Self::Closed(CloseReason::Replaced) => "This terminal was opened somewhere else.",
            Self::Closed(_) => "The terminal connection closed.",
        })
    }
}
impl std::error::Error for TerminalBridgeError {}
impl From<io::Error> for TerminalBridgeError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl Client {
    pub async fn bridge_terminal<R, W, F>(
        &self,
        target: TerminalTarget,
        io: TerminalBridgeIo<R, W>,
        stop: F,
    ) -> Result<(), TerminalBridgeError>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
        F: Future<Output = ()>,
    {
        let (events, terminal) = self
            .open_terminal(
                &target.workspace_id,
                &target.terminal_id,
                target.cols,
                target.rows,
            )
            .map_err(|_| TerminalBridgeError::InvalidTerminal)?;
        let TerminalBridgeIo {
            mut input,
            mut output,
            resizes,
        } = io;
        tokio::pin!(stop);
        let mut ready = false;
        let mut connections = 0;
        let mut size = (target.cols, target.rows);
        let mut bytes = [0; 8192];
        loop {
            tokio::select! {
                () = &mut stop => return Ok(()),
                event = events.recv() => {
                    match event {
                        Ok(ChannelEvent::Message(TerminalFrame::Ready)) => {
                            if connections > 0 { output.write_all(b"\x1bc").await?; }
                            connections += 1;
                            ready = true;
                            terminal.resize(size.0, size.1);
                        }
                        Ok(ChannelEvent::Message(TerminalFrame::Output(bytes))) => {
                            output.write_all(&bytes).await?;
                            output.flush().await?;
                        }
                        Ok(ChannelEvent::Status(Status::Connecting | Status::Open)) | Ok(ChannelEvent::DecodeError(_)) => {}
                        Ok(ChannelEvent::Status(Status::Down { .. })) => {
                            ready = false;
                            output.write_all(b"\r\nReconnecting to Tempo...\r\n").await?;
                            output.flush().await?;
                        }
                        Ok(ChannelEvent::Status(Status::Closed(CloseReason::ShellExited | CloseReason::Stopped))) | Err(_) => return Ok(()),
                        Ok(ChannelEvent::Status(Status::Closed(reason))) => return Err(TerminalBridgeError::Closed(reason)),
                    }
                }
                Ok(next) = resizes.recv() => {
                    size = next;
                    terminal.resize(size.0, size.1);
                }
                count = input.read(&mut bytes) => {
                    let count = count?;
                    if count == 0 { return Ok(()); }
                    let escape = bytes[..count].iter().position(|b| *b == 0x1d);
                    let count = escape.unwrap_or(count);
                    if ready && count > 0 && !terminal.send_keys(bytes[..count].to_vec()) {
                        return Err(TerminalBridgeError::InputBusy);
                    }
                    if escape.is_some() { return Ok(()); }
                }
            }
        }
    }
}

/// Standard input/output with resize and termination signals handled before restoring the TTY.
#[cfg(unix)]
pub async fn local_terminal(
    client: &Client,
    target: TerminalTarget,
    measure: fn() -> io::Result<(u16, u16)>,
) -> Result<(), TerminalBridgeError> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut hangup = signal(SignalKind::hangup())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut window_changed = signal(SignalKind::window_change())?;
    let stop = async move {
        tokio::select! {
            _ = terminate.recv() => {},
            _ = hangup.recv() => {},
            _ = interrupt.recv() => {},
        }
    };
    let (resize_tx, resizes) = async_channel::bounded(16);
    let resize_loop = async move {
        while window_changed.recv().await.is_some() {
            let size = tokio::task::spawn_blocking(measure)
                .await
                .map_err(|_| io::Error::other("terminal measurement stopped"))??;
            if resize_tx.send(size).await.is_err() {
                break;
            }
        }
        Ok(())
    };
    tokio::select! {
        result = client.bridge_terminal(target, TerminalBridgeIo { input: tokio::io::stdin(), output: tokio::io::stdout(), resizes }, stop) => result,
        result = resize_loop => result,
    }
}
