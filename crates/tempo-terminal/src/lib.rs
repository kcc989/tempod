//! Remote terminal grid and input, ported from gpui-terminal 0.1.0. See NOTICE.
pub mod colors;
mod event;
pub mod input;
pub mod io;
pub mod mouse;
mod terminal;
mod view;
pub use event::{EventProxy, TerminalEvent};
pub use io::{TerminalInput, TerminalIo, TerminalRemote};
pub use terminal::{MIN_COLS, MIN_ROWS, SCROLLBACK_LINES, TerminalState};
pub use view::TerminalView;

#[cfg(test)]
extern crate gpui_kit as gpui;
