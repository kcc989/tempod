//! Wire types of Tempo protocol 1 (07, C5): serde types generated from `packages/protocol`, the few
//! types typify does not produce well (spikes/S16.md), and a typed table of the server functions.

#[allow(
    clippy::all,
    clippy::pedantic,
    unused_imports,
    irrefutable_let_patterns,
    reason = "typify output"
)]
mod generated;
mod item;

use std::fmt::Debug;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub use generated::*;
pub use item::{Item, ItemContent};

/// The `protocol` value of `GET /api/v1/meta` and `v` of every channel `hello` this crate speaks.
pub const PROTOCOL_VERSION: u32 = 1;

/// WebSocket close codes the server uses (02, Channels).
pub mod close_code {
    /// Another connection replaced this one: do not reconnect.
    pub const REPLACED: u16 = 4001;
    /// The client fell too far behind: reconnect with `sinceRev`.
    pub const TOO_MUCH_BUFFERED: u16 = 4008;
    /// The server speaks a different protocol version: show the update screen.
    pub const BAD_PROTOCOL_VERSION: u16 = 4400;
    /// The workspace does not exist.
    pub const WORKSPACE_NOT_FOUND: u16 = 4404;
}

/// `{}`: the input and output of functions that take or return nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Empty {}

/// The HTTP method of a server function's web wrapper. `/api/v1/rpc` takes POST for every function.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

/// A server function (02): `POST /api/v1/rpc/<NAME>` with `Input` as the body returns `Output`, or an
/// [`ErrorBody`]. Implemented by the marker types in [`api`].
pub trait Function {
    const NAME: &'static str;
    const METHOD: Method;
    type Input: Serialize + DeserializeOwned + Debug + Send + 'static;
    type Output: Serialize + DeserializeOwned + Debug + Send + 'static;
}

#[doc(hidden)]
pub fn roundtrip<T>(text: &str) -> Result<serde_json::Value, String>
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let first: T = serde_json::from_str(text).map_err(|e| format!("decode: {e}"))?;
    let encoded = serde_json::to_string(&first).map_err(|e| format!("encode: {e}"))?;
    let second: T = serde_json::from_str(&encoded).map_err(|e| format!("decode of the encoding: {e}"))?;
    if first != second {
        return Err(format!("decode(encode(x)) != x:\n{first:?}\n{second:?}"));
    }
    serde_json::from_str(&encoded).map_err(|e| format!("encode: {e}"))
}
