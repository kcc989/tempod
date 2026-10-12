use std::fmt;

use tempo_protocol::{ErrorBody, ErrorCode};

/// The error of an `/api/v1` call or an attachment upload or download. No variant carries a
/// token, a request body or response text.
#[derive(Clone, Debug, PartialEq)]
pub enum ApiError {
    /// A non-200 answer with a Tempo error body `{code, message, detail?}` (02, Error codes).
    Server { status: u16, error: ErrorBody },
    /// A non-200 answer whose body is not a Tempo error (a proxy page, for example).
    Http { status: u16 },
    /// The request did not complete (DNS, TLS, connection reset).
    Network(String),
    /// A 200 whose body does not match the function's output schema, or an input that does not
    /// encode.
    Decode(String),
    /// An attachment over 10 MiB; it was not sent, or its download stopped.
    TooLarge { size: u64 },
    /// The runtime shut down before the call finished.
    Cancelled,
}

impl ApiError {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Server { status, .. } | Self::Http { status } => Some(*status),
            _ => None,
        }
    }

    pub fn code(&self) -> Option<ErrorCode> {
        match self {
            Self::Server { error, .. } => Some(error.code),
            _ => None,
        }
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(401)
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Server { error, .. } => f.write_str(&error.message),
            Self::Http { status } => write!(f, "HTTP {status}"),
            Self::Network(e) => write!(f, "network error: {e}"),
            Self::Decode(e) => write!(f, "unexpected response: {e}"),
            Self::TooLarge { size } => write!(f, "file of {size} bytes is over 10 MiB"),
            Self::Cancelled => f.write_str("cancelled"),
        }
    }
}

impl std::error::Error for ApiError {}

/// The errors of sign-in, session check and sign-out (07, Sign-in and first run).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignInError {
    /// `GET /api/v1/meta` failed or `protocol` is not 1.
    NotTempo,
    /// The app is older than `minMacClient`: show the update screen and stop.
    UpdateRequired {
        min_mac_client: String,
        latest_mac_client: Option<String>,
    },
    /// `access_denied` or `expired_token` while polling.
    Denied,
    /// Any other OAuth or HTTP error, with the OAuth `error` code when there is one.
    Rejected {
        status: u16,
        error: Option<String>,
    },
    Network(String),
    Decode(String),
    Cancelled,
}

pub const NOT_TEMPO_MESSAGE: &str = "This is not a Tempo server, or it runs a different version.";
pub const DENIED_MESSAGE: &str = "Sign-in was denied or timed out.";

impl fmt::Display for SignInError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotTempo => f.write_str(NOT_TEMPO_MESSAGE),
            Self::Denied => f.write_str(DENIED_MESSAGE),
            Self::UpdateRequired { min_mac_client, .. } => {
                write!(f, "update required (minMacClient {min_mac_client})")
            }
            Self::Rejected {
                status,
                error: Some(e),
            } => write!(f, "HTTP {status}: {e}"),
            Self::Rejected {
                status,
                error: None,
            } => write!(f, "HTTP {status}"),
            Self::Network(e) => write!(f, "network error: {e}"),
            Self::Decode(e) => write!(f, "unexpected response: {e}"),
            Self::Cancelled => f.write_str("cancelled"),
        }
    }
}

impl std::error::Error for SignInError {}

/// A serde_json error without the payload text it may quote.
pub(crate) fn decode_error(e: &serde_json::Error) -> String {
    format!(
        "{:?} at line {} column {}",
        e.classify(),
        e.line(),
        e.column()
    )
}

/// A reqwest error without its URL.
pub(crate) fn network_error(e: reqwest::Error) -> String {
    e.without_url().to_string()
}
