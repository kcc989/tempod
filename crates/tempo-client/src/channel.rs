//! The hub, workspace and terminal channels (02; 07, Live state and reconnects).

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tempo_protocol::{
    ClientPing, ClientPingType, HubServerMessage, TerminalReady, TerminalResize,
    TerminalResizeType, WorkspaceServerMessage, close_code,
};
use tokio::sync::watch;
use tokio::time::{Instant, sleep, sleep_until, timeout};
use tokio_tungstenite::tungstenite::handshake::client::{Request, generate_key};
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message, Utf8Bytes};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

use crate::prng::Prng;
use crate::runtime::Signal;
use crate::server::{CLIENT_HEADER, Client, IoStream};

/// Every channel receiver holds at most this many events; when it is full the socket is not read.
pub const CHANNEL_CAPACITY: usize = 1024;
/// `{"type":"ping"}` every 30 s (02).
pub const PING_EVERY: Duration = Duration::from_secs(30);
/// No `pong` within 10 s of a ping: close and reconnect (07).
pub const PONG_TIMEOUT: Duration = Duration::from_secs(10);
/// A connect and upgrade that takes longer than this is abandoned and retried.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 04: the `Reconnecting…` bar shows once a socket has been down this long.
pub const DOWN_BAR_AFTER: Duration = Duration::from_secs(2);
/// Terminal tabs `t1` to `t9` (02).
pub const TERMINAL_IDS: [&str; 9] = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"];

const RECONNECT_INITIAL_MS: f64 = 500.0;
const RECONNECT_MAX_MS: f64 = 10_000.0;
const RECONNECT_JITTER: f64 = 0.2;
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// The reconnect delay before attempt `attempt` (0-based): 0.5 s doubling to 10 s, ±20% jitter.
/// `random` is uniform in [0, 1). Same as `reconnectDelay` in packages/protocol.
pub fn reconnect_delay(attempt: u32, random: f64) -> Duration {
    let base = (RECONNECT_INITIAL_MS * 2f64.powi(attempt.min(31) as i32)).min(RECONNECT_MAX_MS);
    let jitter = base * RECONNECT_JITTER * (random * 2.0 - 1.0);
    Duration::from_millis((base + jitter).round() as u64)
}

/// Why a channel stopped for good.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    /// Terminal close code 1000: the cloud shell exited.
    ShellExited,
    /// 4001: another connection replaced this one. Do not reconnect.
    Replaced,
    /// 4400: the server speaks another protocol version. Show the update screen.
    UpdateRequired,
    /// 4404: the workspace does not exist. Close it and show `Not found.`
    NotFound,
    /// A 401 on an upgrade or an `/api/v1` call of the same client.
    Unauthorized,
    /// [`Client::close_channels`] (sign out).
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// The first connect is in progress.
    Connecting,
    Open,
    /// Not connected since `since`; reconnecting. Show `Reconnecting…` once this is over 2 s old.
    Down {
        since: std::time::Instant,
    },
    /// No more events follow.
    Closed(CloseReason),
}

/// What a channel receiver yields, in arrival order.
#[derive(Clone, Debug, PartialEq)]
pub enum ChannelEvent<M> {
    Status(Status),
    Message(M),
    DecodeError(String),
}

pub type HubChannelEvent = ChannelEvent<HubServerMessage>;
pub type WorkspaceChannelEvent = ChannelEvent<WorkspaceServerMessage>;
pub type TerminalChannelEvent = ChannelEvent<TerminalFrame>;

/// Server-to-client terminal frames (01, Terminal).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalFrame {
    /// A binary frame: PTY output.
    Output(Vec<u8>),
    /// `{"type":"ready"}`, once the process started.
    Ready,
}

/// Client-to-server terminal frames (01, Terminal).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalInput {
    /// Keystrokes, sent as a binary frame.
    Keys(Vec<u8>),
    /// `{"type":"resize","cols":<n>,"rows":<n>}`; also used for the next reconnect's URL.
    Resize { cols: u16, rows: u16 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidTerminalId;

impl fmt::Display for InvalidTerminalId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("terminal id must match ^t[1-9]$")
    }
}

impl std::error::Error for InvalidTerminalId {}

/// Keeps a channel open. Dropping it (or [`ChannelHandle::close`]) closes the socket.
pub struct ChannelHandle {
    _stop: watch::Sender<()>,
}

impl ChannelHandle {
    pub fn close(self) {}
}

impl fmt::Debug for ChannelHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ChannelHandle")
    }
}

/// A workspace channel. The store reports its highest `itemsRev`; every reconnect sends it as
/// `sinceRev`.
#[derive(Debug)]
pub struct WorkspaceHandle {
    channel: ChannelHandle,
    since_rev: Arc<AtomicU64>,
}

impl WorkspaceHandle {
    pub fn set_since_rev(&self, rev: u64) {
        self.since_rev.store(rev, Ordering::Relaxed);
    }

    pub fn since_rev(&self) -> u64 {
        self.since_rev.load(Ordering::Relaxed)
    }

    pub fn close(self) {
        self.channel.close();
    }
}

/// A terminal channel: keystrokes and resizes go out on the same socket.
#[derive(Debug)]
pub struct TerminalHandle {
    channel: ChannelHandle,
    input: async_channel::Sender<TerminalInput>,
    size: Arc<AtomicU32>,
}

impl TerminalHandle {
    /// Queues keystrokes. False when the input queue is full or the channel is gone.
    pub fn send_keys(&self, bytes: impl Into<Vec<u8>>) -> bool {
        self.input
            .try_send(TerminalInput::Keys(bytes.into()))
            .is_ok()
    }

    /// Queues a resize; a reconnect also opens with this size.
    pub fn resize(&self, cols: u16, rows: u16) -> bool {
        let (cols, rows) = (cols.clamp(10, 500), rows.clamp(5, 200));
        self.size.store(pack(cols, rows), Ordering::Relaxed);
        self.input
            .try_send(TerminalInput::Resize { cols, rows })
            .is_ok()
    }

    /// The input queue, for senders that want to await room.
    pub fn input(&self) -> async_channel::Sender<TerminalInput> {
        self.input.clone()
    }

    pub fn close(self) {
        self.channel.close();
    }
}

fn pack(cols: u16, rows: u16) -> u32 {
    (u32::from(cols) << 16) | u32::from(rows)
}

fn unpack(size: u32) -> (u16, u16) {
    ((size >> 16) as u16, size as u16)
}

impl Client {
    /// `/api/ws/hub`: the sidebar, for as long as the app runs.
    pub fn open_hub(&self) -> (async_channel::Receiver<HubChannelEvent>, ChannelHandle) {
        let url = self.server().url(&["api", "ws", "hub"]);
        self.open(Spec {
            url: Box::new(move || url.to_string()),
            decode_text: decode_hub,
            decode_issue: |_| None,
            decode_binary: |_| None,
            ping: true,
            input: None,
        })
    }

    /// `/api/ws/workspace/<id>?sinceRev=<n>`. A new store sends 0; a reopen sends its highest
    /// `itemsRev`.
    pub fn open_workspace(
        &self,
        workspace_id: &str,
        since_rev: u64,
    ) -> (
        async_channel::Receiver<WorkspaceChannelEvent>,
        WorkspaceHandle,
    ) {
        let since = Arc::new(AtomicU64::new(since_rev));
        let base = self.server().url(&["api", "ws", "workspace", workspace_id]);
        let rev = since.clone();
        let (rx, channel) = self.open(Spec {
            url: Box::new(move || {
                let mut url = base.clone();
                url.query_pairs_mut()
                    .append_pair("sinceRev", &rev.load(Ordering::Relaxed).to_string());
                url.to_string()
            }),
            decode_text: decode_workspace,
            decode_issue: workspace_decode_issue,
            decode_binary: |_| None,
            ping: true,
            input: None,
        });
        (
            rx,
            WorkspaceHandle {
                channel,
                since_rev: since,
            },
        )
    }

    /// `/api/ws/terminal/<id>/<t1..t9>?cols=<n>&rows=<n>` (01, Terminal).
    pub fn open_terminal(
        &self,
        workspace_id: &str,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<
        (
            async_channel::Receiver<TerminalChannelEvent>,
            TerminalHandle,
        ),
        InvalidTerminalId,
    > {
        if !TERMINAL_IDS.contains(&terminal_id) {
            return Err(InvalidTerminalId);
        }
        let (cols, rows) = (cols.clamp(10, 500), rows.clamp(5, 200));
        let size = Arc::new(AtomicU32::new(pack(cols, rows)));
        let base = self
            .server()
            .url(&["api", "ws", "terminal", workspace_id, terminal_id]);
        let current = size.clone();
        let (input_tx, input_rx) = async_channel::bounded(CHANNEL_CAPACITY);
        let (rx, channel) = self.open(Spec {
            url: Box::new(move || {
                let (cols, rows) = unpack(current.load(Ordering::Relaxed));
                let mut url = base.clone();
                url.query_pairs_mut()
                    .append_pair("cols", &cols.to_string())
                    .append_pair("rows", &rows.to_string());
                url.to_string()
            }),
            decode_text: decode_terminal_text,
            decode_issue: |_| None,
            decode_binary: |bytes| Some(TerminalFrame::Output(bytes)),
            ping: false,
            input: Some((input_rx, size.clone())),
        });
        Ok((
            rx,
            TerminalHandle {
                channel,
                input: input_tx,
                size,
            },
        ))
    }

    fn open<M: Send + 'static>(
        &self,
        spec: Spec<M>,
    ) -> (async_channel::Receiver<ChannelEvent<M>>, ChannelHandle) {
        let (tx, rx) = async_channel::bounded(CHANNEL_CAPACITY);
        let (stop_tx, stop_rx) = watch::channel(());
        let engine = Engine {
            client: self.clone(),
            spec,
            tx,
            stop: stop_rx,
            client_stop: self.stop_receiver(),
            wake: self.server().runtime().wake_receiver(),
            rng: Prng::seeded(),
        };
        self.server().runtime().tokio().spawn(engine.run());
        (rx, ChannelHandle { _stop: stop_tx })
    }
}

fn decode_hub(text: &str) -> Option<(HubServerMessage, bool)> {
    let msg: HubServerMessage = serde_json::from_str(text).ok()?;
    let pong = matches!(msg, HubServerMessage::WsPong(_));
    Some((msg, pong))
}

fn decode_workspace(text: &str) -> Option<(WorkspaceServerMessage, bool)> {
    let msg: WorkspaceServerMessage = serde_json::from_str(text).ok()?;
    let pong = matches!(msg, WorkspaceServerMessage::Pong(_));
    Some((msg, pong))
}

fn workspace_decode_issue(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value["type"] != "hello" {
        return None;
    }
    fn issue<T: serde::de::DeserializeOwned>(
        component: &str,
        value: serde_json::Value,
    ) -> Option<String> {
        let error = serde_json::from_value::<T>(value).err()?;
        let text = error.to_string();
        let field = text
            .strip_prefix("missing field `")
            .and_then(|s| s.strip_suffix('`'))
            .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        Some(match field {
            Some(field) => format!("{component}: missing field {field}"),
            None => format!("{component}: invalid data ({:?})", error.classify()),
        })
    }
    if let Some(error) =
        issue::<tempo_protocol::WorkspaceDetail>("workspace", value["workspace"].clone())
    {
        return Some(error);
    }
    if let Some(sessions) = value["sessions"].as_array() {
        for session in sessions {
            if let Some(error) = issue::<tempo_protocol::Session>("session", session.clone()) {
                return Some(error);
            }
        }
    }
    if let Some(turns) = value["turns"].as_array() {
        for turn in turns {
            if let Some(error) = issue::<tempo_protocol::Turn>("turn", turn.clone()) {
                return Some(error);
            }
        }
    }
    issue::<tempo_protocol::WsHello>("hello", value)
}

fn decode_terminal_text(text: &str) -> Option<(TerminalFrame, bool)> {
    serde_json::from_str::<TerminalReady>(text)
        .ok()
        .map(|_| (TerminalFrame::Ready, false))
}

struct Spec<M> {
    url: Box<dyn Fn() -> String + Send>,
    /// The message and whether it is a `pong`.
    decode_text: fn(&str) -> Option<(M, bool)>,
    decode_issue: fn(&str) -> Option<String>,
    decode_binary: fn(Vec<u8>) -> Option<M>,
    ping: bool,
    input: Option<(async_channel::Receiver<TerminalInput>, Arc<AtomicU32>)>,
}

type Socket = WebSocketStream<MaybeTlsStream<IoStream>>;

enum ConnectError {
    Unauthorized,
    Failed,
}

enum Outcome {
    Reconnect,
    ReconnectNow,
    Closed(CloseReason),
    Exit,
}

struct Engine<M> {
    client: Client,
    spec: Spec<M>,
    tx: async_channel::Sender<ChannelEvent<M>>,
    stop: watch::Receiver<()>,
    client_stop: watch::Receiver<Option<CloseReason>>,
    wake: watch::Receiver<u64>,
    rng: Prng,
}

impl<M: Send + 'static> Engine<M> {
    async fn run(mut self) {
        let mut attempt: u32 = 0;
        let mut outage_since = now();
        let mut down_reported = false;
        if !self.emit(Status::Connecting).await {
            return;
        }
        loop {
            let stopped = *self.client_stop.borrow_and_update();
            if let Some(reason) = stopped {
                self.emit(Status::Closed(reason)).await;
                return;
            }
            let url = (self.spec.url)();
            let connected = tokio::select! {
                biased;
                _ = self.stop.changed() => return,
                _ = self.client_stop.changed() => continue,
                Ok(()) = self.wake.changed() => continue,
                r = timeout(CONNECT_TIMEOUT, connect(&self.client, &url)) => r,
            };
            match connected {
                Ok(Ok(socket)) => {
                    if !self.emit(Status::Open).await {
                        return;
                    }
                    let outcome = self.run_open(socket, &mut attempt).await;
                    let reconnect_now = match outcome {
                        Outcome::Exit => return,
                        Outcome::Closed(reason) => {
                            if reason == CloseReason::UpdateRequired {
                                self.client
                                    .server()
                                    .runtime()
                                    .signal(Signal::UpdateRequired);
                            }
                            self.emit(Status::Closed(reason)).await;
                            return;
                        }
                        Outcome::ReconnectNow => true,
                        Outcome::Reconnect => false,
                    };
                    outage_since = now();
                    down_reported = true;
                    if !self
                        .emit(Status::Down {
                            since: outage_since,
                        })
                        .await
                    {
                        return;
                    }
                    if reconnect_now {
                        continue;
                    }
                }
                Ok(Err(ConnectError::Unauthorized)) => {
                    self.client.unauthorized();
                    continue;
                }
                Ok(Err(ConnectError::Failed)) | Err(_) => {
                    if !down_reported {
                        down_reported = true;
                        if !self
                            .emit(Status::Down {
                                since: outage_since,
                            })
                            .await
                        {
                            return;
                        }
                    }
                }
            }
            let delay = reconnect_delay(attempt, self.rng.next_f64());
            attempt = attempt.saturating_add(1);
            tokio::select! {
                biased;
                _ = self.stop.changed() => return,
                _ = self.client_stop.changed() => {}
                Ok(()) = self.wake.changed() => {}
                () = sleep(delay) => {}
            }
        }
    }

    async fn run_open(&mut self, socket: Socket, attempt: &mut u32) -> Outcome {
        let (mut sink, mut stream) = socket.split();
        let mut got_message = false;
        let mut next_ping = Instant::now() + PING_EVERY;
        let mut pong_deadline: Option<Instant> = None;
        let input_rx = self.spec.input.as_ref().map(|(rx, _)| rx.clone());
        let mut terminal_ready = input_rx.is_none();
        loop {
            let input = async {
                match &input_rx {
                    Some(rx) => rx.recv().await.ok(),
                    None => std::future::pending().await,
                }
            };
            let far = Instant::now() + Duration::from_secs(86_400);
            tokio::select! {
                biased;
                _ = self.stop.changed() => {
                    close(&mut sink).await;
                    return Outcome::Exit;
                }
                changed = self.client_stop.changed() => {
                    close(&mut sink).await;
                    let reason = *self.client_stop.borrow_and_update();
                    return match (changed, reason) {
                        (Ok(()), Some(reason)) => Outcome::Closed(reason),
                        _ => Outcome::Exit,
                    };
                }
                Ok(()) = self.wake.changed() => {
                    close(&mut sink).await;
                    return Outcome::ReconnectNow;
                }
                Some(input) = input => {
                    let frame = match input {
                        TerminalInput::Keys(bytes) => {
                            if !terminal_ready { continue; }
                            Message::Binary(bytes.into())
                        },
                        TerminalInput::Resize { cols, rows } => {
                            let (cols, rows) = (cols.clamp(10, 500), rows.clamp(5, 200));
                            if let Some((_, size)) = &self.spec.input {
                                size.store(pack(cols, rows), Ordering::Relaxed);
                            }
                            if !terminal_ready { continue; }
                            let resize = TerminalResize {
                                cols: i64::from(cols),
                                rows: i64::from(rows),
                                type_: TerminalResizeType::Resize,
                            };
                            match serde_json::to_string(&resize) {
                                Ok(text) => Message::text(text),
                                Err(_) => continue,
                            }
                        }
                    };
                    if sink.send(frame).await.is_err() {
                        return Outcome::Reconnect;
                    }
                }
                frame = stream.next() => {
                    let decoded = match frame {
                        None | Some(Err(_)) => return Outcome::Reconnect,
                        Some(Ok(Message::Close(frame))) => {
                            return match frame.map(|f| u16::from(f.code)) {
                                Some(1000) if input_rx.is_some() => Outcome::Closed(CloseReason::ShellExited),
                                Some(close_code::REPLACED) => Outcome::Closed(CloseReason::Replaced),
                                Some(close_code::BAD_PROTOCOL_VERSION) => {
                                    Outcome::Closed(CloseReason::UpdateRequired)
                                }
                                Some(close_code::WORKSPACE_NOT_FOUND) => {
                                    Outcome::Closed(CloseReason::NotFound)
                                }
                                _ => Outcome::Reconnect,
                            };
                        }
                        Some(Ok(Message::Text(text))) => {
                            let decoded = (self.spec.decode_text)(text.as_str());
                            if input_rx.is_some() && decoded.is_some() { terminal_ready = true; }
                            if decoded.is_none()
                                && let Some(issue) = (self.spec.decode_issue)(text.as_str())
                                && !self.deliver(ChannelEvent::DecodeError(issue)).await
                            {
                                return Outcome::Exit;
                            }
                            decoded
                        },
                        Some(Ok(Message::Binary(bytes))) => {
                            (self.spec.decode_binary)(bytes.to_vec()).map(|m| (m, false))
                        }
                        Some(Ok(_)) => continue,
                    };
                    if !got_message {
                        got_message = true;
                        *attempt = 0;
                    }
                    let Some((msg, is_pong)) = decoded else { continue };
                    if is_pong {
                        pong_deadline = None;
                    }
                    let started = Instant::now();
                    if !self.emit_message(msg).await {
                        close(&mut sink).await;
                        return Outcome::Exit;
                    }
                    let blocked = started.elapsed();
                    next_ping += blocked;
                    pong_deadline = pong_deadline.map(|d| d + blocked);
                }
                () = sleep_until(next_ping), if self.spec.ping => {
                    next_ping += PING_EVERY;
                    let ping = ClientPing { type_: ClientPingType::Ping };
                    let Ok(text) = serde_json::to_string(&ping) else { continue };
                    if sink.send(Message::text(text)).await.is_err() {
                        return Outcome::Reconnect;
                    }
                    if pong_deadline.is_none() {
                        pong_deadline = Some(Instant::now() + PONG_TIMEOUT);
                    }
                }
                () = sleep_until(pong_deadline.unwrap_or(far)), if pong_deadline.is_some() => {
                    close(&mut sink).await;
                    return Outcome::Reconnect;
                }
            }
        }
    }

    /// Sends an event, waiting for room (backpressure). False when the channel is gone.
    async fn emit(&mut self, status: Status) -> bool {
        self.deliver(ChannelEvent::Status(status)).await
    }

    async fn emit_message(&mut self, msg: M) -> bool {
        self.deliver(ChannelEvent::Message(msg)).await
    }

    async fn deliver(&mut self, event: ChannelEvent<M>) -> bool {
        tokio::select! {
            biased;
            _ = self.stop.changed() => false,
            sent = self.tx.send(event) => sent.is_ok(),
        }
    }
}

fn now() -> std::time::Instant {
    Instant::now().into_std()
}

async fn close<S>(sink: &mut S)
where
    S: futures_util::Sink<Message> + Unpin,
{
    let frame = CloseFrame {
        code: CloseCode::Normal,
        reason: Utf8Bytes::from_static(""),
    };
    let _ = timeout(CLOSE_GRACE, sink.send(Message::Close(Some(frame)))).await;
}

async fn connect(client: &Client, url: &str) -> Result<Socket, ConnectError> {
    let (request, host, port, tls) = upgrade_request(client, url).ok_or(ConnectError::Failed)?;
    let stream = client
        .server()
        .dial(host, port)
        .await
        .map_err(|_| ConnectError::Failed)?;
    let connector = if tls {
        Connector::Rustls(client.server().ws_tls())
    } else {
        Connector::Plain
    };
    match tokio_tungstenite::client_async_tls_with_config(request, stream, None, Some(connector))
        .await
    {
        Ok((socket, _)) => Ok(socket),
        Err(WsError::Http(response)) if response.status().as_u16() == 401 => {
            Err(ConnectError::Unauthorized)
        }
        Err(_) => Err(ConnectError::Failed),
    }
}

/// The upgrade request, built by hand: bearer token and `X-Tempo-Client`, and no `Origin` (07).
/// Also the host, port and whether it is TLS.
fn upgrade_request(client: &Client, http_url: &str) -> Option<(Request, String, u16, bool)> {
    let mut url = reqwest::Url::parse(http_url).ok()?;
    let tls = url.scheme() == "https";
    url.set_scheme(if tls { "wss" } else { "ws" }).ok()?;
    let host = url.host_str()?.to_owned();
    let port = url.port_or_known_default()?;
    let host_header = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.clone(),
    };
    let mut bearer = HeaderValue::from_str(&client.token().bearer()).ok()?;
    bearer.set_sensitive(true);
    let request = Request::builder()
        .method("GET")
        .uri(url.as_str())
        .header("Host", host_header)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header(AUTHORIZATION, bearer)
        .header(CLIENT_HEADER, client.server().client_header().clone())
        .body(())
        .ok()?;
    Some((request, host, port, tls))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_decode_diagnostics_never_include_payload_values() {
        let hello =
            include_str!("../../../packages/protocol/fixtures/channel/workspace-first-load.jsonl")
                .lines()
                .next()
                .unwrap();
        let mut value: serde_json::Value = serde_json::from_str(hello).unwrap();
        value["sessions"][0]["title"] = serde_json::json!("private prompt and secret token");
        value["sessions"][0]
            .as_object_mut()
            .unwrap()
            .remove("modes");
        let text = value.to_string();
        assert!(decode_workspace(&text).is_none());
        assert_eq!(
            workspace_decode_issue(&text).as_deref(),
            Some("session: missing field modes")
        );
        value["sessions"][0]["modes"] = serde_json::json!("private prompt and secret token");
        assert_eq!(
            workspace_decode_issue(&value.to_string()).as_deref(),
            Some("session: invalid data (Data)")
        );
        assert!(workspace_decode_issue("not JSON").is_none());
        assert!(workspace_decode_issue(r#"{"type":"unknown","secret":"private"}"#).is_none());
    }

    #[test]
    fn backoff_doubles_to_ten_seconds_with_twenty_percent_jitter() {
        let mid: Vec<u64> = (0..8)
            .map(|a| reconnect_delay(a, 0.5).as_millis() as u64)
            .collect();
        assert_eq!(mid, [500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
        assert_eq!(reconnect_delay(0, 0.0), Duration::from_millis(400));
        assert_eq!(reconnect_delay(0, 0.999_999), Duration::from_millis(600));
        assert_eq!(reconnect_delay(9, 0.0), Duration::from_millis(8000));
        assert_eq!(
            reconnect_delay(u32::MAX, 0.999_999),
            Duration::from_millis(12_000)
        );
        let mut rng = Prng::seeded();
        for attempt in 0..12 {
            let base = (500u64 << attempt.min(5)).min(10_000) as f64;
            for _ in 0..200 {
                let d = reconnect_delay(attempt, rng.next_f64()).as_millis() as f64;
                assert!(d >= base * 0.8 && d <= base * 1.2, "{attempt}: {d}");
            }
        }
    }

    #[test]
    fn terminal_sizes_pack_both_dimensions() {
        assert_eq!(unpack(pack(500, 200)), (500, 200));
        assert_eq!(unpack(pack(u16::MAX, 0)), (u16::MAX, 0));
    }
}
