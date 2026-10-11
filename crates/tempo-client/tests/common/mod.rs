//! In-process fake Tempo servers: a minimal HTTP/1.1 responder and a WebSocket acceptor that
//! records the upgrade request. Both run on the test's tokio runtime, so tokio's paused clock
//! drives every timer.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::Instant;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;

pub const APP_VERSION: &str = "0.2.0";
pub const TOKEN: &str = "test-session-token";

#[derive(Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub at: Instant,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("request body is JSON")
    }
}

pub type Handler = dyn Fn(&HttpRequest, usize) -> (u16, String) + Send + Sync;

pub struct FakeHttp {
    pub base: String,
    pub requests: Arc<Mutex<Vec<HttpRequest>>>,
}

impl FakeHttp {
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().expect("lock").clone()
    }
}

/// Answers every request with `handler(request, index)`: a status and a JSON body.
pub async fn fake_http(
    handler: impl Fn(&HttpRequest, usize) -> (u16, String) + Send + Sync + 'static,
) -> FakeHttp {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    let handler: Arc<Handler> = Arc::new(handler);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let log = log.clone();
            let handler = handler.clone();
            tokio::spawn(async move {
                let _ = serve_one(stream, log, handler).await;
            });
        }
    });
    FakeHttp { base, requests }
}

async fn serve_one(
    mut stream: TcpStream,
    log: Arc<Mutex<Vec<HttpRequest>>>,
    handler: Arc<Handler>,
) -> std::io::Result<()> {
    {
        let mut buf = Vec::new();
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            let mut chunk = [0u8; 4096];
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let mut lines = head.split("\r\n");
        let mut first = lines.next().unwrap_or_default().split(' ');
        let method = first.next().unwrap_or_default().to_owned();
        let path = first.next().unwrap_or_default().to_owned();
        let headers: Vec<(String, String)> = lines
            .filter(|l| !l.is_empty())
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
            .collect();
        let length: usize = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse().ok())
            .unwrap_or(0);
        let mut body = buf[head_end..].to_vec();
        while body.len() < length {
            let mut chunk = vec![0u8; 64 * 1024];
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                return Ok(());
            }
            body.extend_from_slice(&chunk[..n]);
        }
        let request = HttpRequest {
            method,
            path,
            headers,
            body,
            at: Instant::now(),
        };
        let index = {
            let mut log = log.lock().expect("lock");
            log.push(request.clone());
            log.len() - 1
        };
        let (status, body) = handler(&request, index);
        let response = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await?;
        stream.shutdown().await
    }
}

pub struct Upgrade {
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub at: Instant,
}

impl Upgrade {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}
pub type BoxedIo = Box<dyn Io>;

pub struct Conn {
    pub upgrade: Upgrade,
    pub ws: WebSocketStream<BoxedIo>,
}

pub struct FakeWs {
    /// For real TCP connections.
    pub base: String,
    conns: async_channel::Receiver<Conn>,
    incoming: async_channel::Sender<BoxedIo>,
    pub attempts: Arc<Mutex<Vec<Upgrade>>>,
}

impl FakeWs {
    /// The next accepted connection.
    pub async fn next(&self) -> Conn {
        self.conns.recv().await.expect("server runs")
    }

    pub fn attempts(&self) -> usize {
        self.attempts.lock().expect("lock").len()
    }

    pub fn attempt_times(&self) -> Vec<Instant> {
        self.attempts
            .lock()
            .expect("lock")
            .iter()
            .map(|u| u.at)
            .collect()
    }

    /// A dialer for `Server::with_dialer`: in-memory pipes to this server. Data moves between
    /// tasks without the OS, so tokio's paused clock only advances when every task waits on a
    /// timer.
    pub fn dialer(
        &self,
    ) -> impl Fn(String, u16) -> std::future::Ready<std::io::Result<DuplexStream>> + Send + Sync + 'static
    {
        let incoming = self.incoming.clone();
        move |_, _| {
            let (client, server) = tokio::io::duplex(64 * 1024);
            let _ = incoming.try_send(Box::new(server));
            std::future::ready(Ok(client))
        }
    }
}

/// Accepts WebSocket upgrades over TCP (`base`) and over [`FakeWs::dialer`]. `reject(index)`
/// returns an HTTP status to refuse attempt `index`.
pub async fn fake_ws(reject: impl Fn(usize) -> Option<u16> + Send + Sync + 'static) -> FakeWs {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let (incoming, streams) = async_channel::unbounded::<BoxedIo>();
    let from_tcp = incoming.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let _ = from_tcp.send(Box::new(stream)).await;
        }
    });
    let (tx, conns) = async_channel::unbounded();
    let attempts: Arc<Mutex<Vec<Upgrade>>> = Arc::new(Mutex::new(Vec::new()));
    let log = attempts.clone();
    tokio::spawn(async move {
        while let Ok(stream) = streams.recv().await {
            let mut seen: Option<Upgrade> = None;
            let index = log.lock().expect("lock").len();
            let refuse = reject(index);
            #[allow(clippy::result_large_err, reason = "the signature is tungstenite's")]
            let callback = |req: &Request, resp: Response| {
                seen = Some(Upgrade {
                    path: req.uri().to_string(),
                    headers: req
                        .headers()
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_owned()))
                        .collect(),
                    at: Instant::now(),
                });
                match refuse {
                    Some(status) => {
                        let mut r = ErrorResponse::new(None);
                        *r.status_mut() = StatusCode::from_u16(status).expect("status");
                        Err(r)
                    }
                    None => Ok(resp),
                }
            };
            let accepted = tokio_tungstenite::accept_hdr_async(stream, callback).await;
            let Some(upgrade) = seen else { continue };
            log.lock().expect("lock").push(Upgrade {
                path: upgrade.path.clone(),
                headers: upgrade.headers.clone(),
                at: upgrade.at,
            });
            if let Ok(ws) = accepted {
                let _ = tx.send(Conn { upgrade, ws }).await;
            }
        }
    });
    FakeWs {
        base,
        conns,
        incoming,
        attempts,
    }
}
