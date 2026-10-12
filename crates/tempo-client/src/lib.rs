//! tempo-client (07): the tokio runtime, RPC client, channel clients with reconnect, device sign-in,
//! and the store logic shared with the app. It has no GPUI dependency.

mod channel;
mod error;
mod prng;
mod runtime;
mod server;
pub mod state;
mod tls;
mod token;
mod version;

pub use channel::{
    CHANNEL_CAPACITY, CONNECT_TIMEOUT, ChannelEvent, ChannelHandle, CloseReason, DOWN_BAR_AFTER,
    HubChannelEvent, InvalidTerminalId, PING_EVERY, PONG_TIMEOUT, Status, TERMINAL_IDS,
    TerminalChannelEvent, TerminalFrame, TerminalHandle, TerminalInput, WorkspaceChannelEvent,
    WorkspaceHandle, reconnect_delay,
};
pub use error::{ApiError, DENIED_MESSAGE, NOT_TEMPO_MESSAGE, SignInError};
pub use runtime::{Runtime, RuntimeHandle, Signal};
pub use server::{
    AttachmentFile, CLIENT_ID, Client, DEVICE_GRANT_TYPE, DeviceAuthorization,
    MAX_ATTACHMENT_BYTES, SLOW_DOWN_STEP, Server, TokenStatus,
};
pub use token::Token;
pub use version::{compare_versions, newer_version_available, parse_version};
