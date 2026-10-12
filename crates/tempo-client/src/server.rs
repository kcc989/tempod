use std::cmp::Ordering;
use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{RequestBuilder, Response, Url};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tempo_protocol::{ApiMeta, AppSetupStatus, ErrorBody, ErrorCode, Function, PROTOCOL_VERSION};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::channel::CloseReason;
use crate::error::{ApiError, SignInError, decode_error, network_error};
use crate::prng::Prng;
use crate::runtime::{RuntimeHandle, Signal};
use crate::tls;
use crate::token::Token;
use crate::version::compare_versions;

/// The Better Auth device client id of the Mac app (05, 07).
pub const CLIENT_ID: &str = "tempo-mac";
pub const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// 04, 07: each attachment is at most 10 MiB.
pub const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
/// RFC 8628 3.5: `slow_down` adds 5 s to the polling interval.
pub const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);
/// RFC 8628 3.2: the interval when the server sends none.
const DEFAULT_POLL_INTERVAL: u64 = 5;

pub(crate) const CLIENT_HEADER: HeaderName = HeaderName::from_static("x-tempo-client");

pub(crate) trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}
pub(crate) type IoStream = Box<dyn Io>;
type DialFuture = Pin<Box<dyn Future<Output = io::Result<IoStream>> + Send>>;
/// Opens the byte stream a channel upgrade runs on: TCP, or an in-memory pipe in tests.
type Dialer = Arc<dyn Fn(String, u16) -> DialFuture + Send + Sync>;

fn tcp_dialer() -> Dialer {
    Arc::new(|host, port| {
        Box::pin(async move {
            let stream = TcpStream::connect((host.trim_matches(['[', ']']), port)).await?;
            stream.set_nodelay(true)?;
            Ok(Box::new(stream) as IoStream)
        })
    })
}

/// One Tempo deployment, before or after sign-in: its URL, the app version and the HTTP client.
#[derive(Clone)]
pub struct Server {
    inner: Arc<ServerInner>,
}

struct ServerInner {
    rt: RuntimeHandle,
    origin: Url,
    app_version: String,
    client_header: HeaderValue,
    http: reqwest::Client,
    ws_tls: Arc<rustls::ClientConfig>,
    dialer: Dialer,
}

impl fmt::Debug for Server {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Server")
            .field("origin", &self.inner.origin.as_str())
            .field("app_version", &self.inner.app_version)
            .finish_non_exhaustive()
    }
}

/// `device/code` (RFC 8628 3.2) as Better Auth returns it.
#[derive(Clone, Deserialize)]
pub struct DeviceAuthorization {
    device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

impl fmt::Debug for DeviceAuthorization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceAuthorization")
            .field("device_code", &"<redacted>")
            .field("user_code", &self.user_code)
            .field("verification_uri", &self.verification_uri)
            .field("verification_uri_complete", &self.verification_uri_complete)
            .field("expires_in", &self.expires_in)
            .field("interval", &self.interval)
            .finish()
    }
}

/// `GET /api/auth/get-session` on a later launch (07): `null` means the token was revoked or expired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenStatus {
    Valid,
    Revoked,
}

/// An attachment as the attachment route serves it (02, Attachments).
#[derive(Clone, PartialEq, Eq)]
pub struct AttachmentFile {
    /// The `Content-Type` without parameters, lowercase.
    pub mime: String,
    pub bytes: Vec<u8>,
}

impl fmt::Debug for AttachmentFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AttachmentFile")
            .field("mime", &self.mime)
            .field("len", &self.bytes.len())
            .finish()
    }
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

impl Server {
    /// `url` is the Tempo URL the owner typed, for example `https://tempo.example.com`. Only its
    /// origin is kept. A URL that is not `http` or `https` is [`SignInError::NotTempo`].
    pub fn new(rt: &RuntimeHandle, url: &str, app_version: &str) -> Result<Self, SignInError> {
        let parsed = Url::parse(url.trim()).map_err(|_| SignInError::NotTempo)?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(SignInError::NotTempo);
        }
        let origin = Url::parse(&parsed.origin().ascii_serialization())
            .map_err(|_| SignInError::NotTempo)?;
        let client_header = HeaderValue::from_str(&format!("mac/{app_version}"))
            .map_err(|_| SignInError::Decode("app version is not a header value".into()))?;
        let tls_error = |e: rustls::Error| SignInError::Network(format!("TLS setup: {e}"));
        let mut headers = HeaderMap::new();
        headers.insert(CLIENT_HEADER, client_header.clone());
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls::client_config(&[b"http/1.1"]).map_err(tls_error)?)
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| SignInError::Network(network_error(e)))?;
        let ws_tls = Arc::new(tls::client_config(&[]).map_err(tls_error)?);
        Ok(Self {
            inner: Arc::new(ServerInner {
                rt: rt.clone(),
                origin,
                app_version: app_version.to_owned(),
                client_header,
                http,
                ws_tls,
                dialer: tcp_dialer(),
            }),
        })
    }

    /// Channels open their byte stream with `dial(host, port)` instead of TCP. For tests that need
    /// a deterministic transport under tokio's paused clock.
    #[doc(hidden)]
    pub fn with_dialer<F, Fut, S>(self, dial: F) -> Self
    where
        F: Fn(String, u16) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = io::Result<S>> + Send + 'static,
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let dial = Arc::new(dial);
        let dialer: Dialer = Arc::new(move |host, port| {
            let fut = dial(host, port);
            Box::pin(async move { Ok(Box::new(fut.await?) as IoStream) })
        });
        let inner = &self.inner;
        Self {
            inner: Arc::new(ServerInner {
                rt: inner.rt.clone(),
                origin: inner.origin.clone(),
                app_version: inner.app_version.clone(),
                client_header: inner.client_header.clone(),
                http: inner.http.clone(),
                ws_tls: inner.ws_tls.clone(),
                dialer,
            }),
        }
    }

    /// `scheme://host[:port]`, with no trailing slash.
    pub fn origin(&self) -> String {
        self.inner.origin.origin().ascii_serialization()
    }

    /// The Keychain account (07, Local storage).
    pub fn host(&self) -> &str {
        self.inner.origin.host_str().unwrap_or_default()
    }

    pub fn app_version(&self) -> &str {
        &self.inner.app_version
    }

    pub fn runtime(&self) -> &RuntimeHandle {
        &self.inner.rt
    }

    pub(crate) fn url(&self, path_segments: &[&str]) -> Url {
        let mut url = self.inner.origin.clone();
        url.path_segments_mut()
            .expect("http origin has a path")
            .clear()
            .extend(path_segments);
        url
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.inner.http
    }

    pub(crate) fn client_header(&self) -> &HeaderValue {
        &self.inner.client_header
    }

    pub(crate) fn ws_tls(&self) -> Arc<rustls::ClientConfig> {
        self.inner.ws_tls.clone()
    }

    pub(crate) async fn dial(&self, host: String, port: u16) -> io::Result<IoStream> {
        (self.inner.dialer)(host, port).await
    }

    /// A signed-in client for this server.
    pub fn client(&self, token: Token) -> Client {
        Client {
            server: self.clone(),
            token,
            shared: Arc::new(ClientShared {
                stop: watch::Sender::new(None),
            }),
        }
    }

    /// `GET /api/v1/meta`, no auth.
    pub fn meta(&self) -> impl Future<Output = Result<ApiMeta, ApiError>> + Send + 'static {
        let request = self.http().get(self.url(&["api", "v1", "meta"]));
        let run = self.inner.rt.run(async move {
            let response = request
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            read_api::<ApiMeta>(response).await
        });
        async move { run.await.unwrap_or(Err(ApiError::Cancelled)) }
    }

    /// `GET /api/setup/status`, no auth: whether the GitHub App exists, and its install page.
    pub fn setup_status(
        &self,
    ) -> impl Future<Output = Result<AppSetupStatus, ApiError>> + Send + 'static {
        let request = self.http().get(self.url(&["api", "setup", "status"]));
        let run = self.inner.rt.run(async move {
            let response = request
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            read_api::<AppSetupStatus>(response).await
        });
        async move { run.await.unwrap_or(Err(ApiError::Cancelled)) }
    }

    /// Sign-in step 2: `meta` must answer with `protocol` 1, and the app must not be older than
    /// `minMacClient`.
    pub fn check_server(
        &self,
    ) -> impl Future<Output = Result<ApiMeta, SignInError>> + Send + 'static {
        let meta = self.meta();
        let app_version = self.inner.app_version.clone();
        async move {
            let meta = match meta.await {
                Ok(meta) => meta,
                Err(ApiError::Cancelled) => return Err(SignInError::Cancelled),
                Err(_) => return Err(SignInError::NotTempo),
            };
            if *meta.protocol != f64::from(PROTOCOL_VERSION) {
                return Err(SignInError::NotTempo);
            }
            match compare_versions(&app_version, &meta.min_mac_client) {
                None => Err(SignInError::NotTempo),
                Some(Ordering::Less) => Err(SignInError::UpdateRequired {
                    min_mac_client: meta.min_mac_client.clone(),
                    latest_mac_client: meta.latest_mac_client.clone(),
                }),
                Some(_) => Ok(meta),
            }
        }
    }

    /// Sign-in step 3: `POST /api/auth/device/code` with `{client_id: "tempo-mac"}`.
    pub fn start_device_flow(
        &self,
    ) -> impl Future<Output = Result<DeviceAuthorization, SignInError>> + Send + 'static {
        let request = self
            .http()
            .post(self.url(&["api", "auth", "device", "code"]))
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::json!({ "client_id": CLIENT_ID }).to_string());
        let run = self.inner.rt.run(async move {
            let response = request.send().await.map_err(sign_in_network)?;
            read_auth::<DeviceAuthorization>(response).await
        });
        async move { run.await.unwrap_or(Err(SignInError::Cancelled)) }
    }

    /// Sign-in step 6: polls `POST /api/auth/device/token` every `interval` seconds until the owner
    /// approves or denies, or the code expires. Dropping the future stops polling.
    pub fn poll_token(
        &self,
        authorization: &DeviceAuthorization,
    ) -> impl Future<Output = Result<Token, SignInError>> + Send + 'static {
        let http = self.http().clone();
        let url = self.url(&["api", "auth", "device", "token"]);
        let body = serde_json::json!({
            "grant_type": DEVICE_GRANT_TYPE,
            "device_code": authorization.device_code,
            "client_id": CLIENT_ID,
        })
        .to_string();
        let seconds = match authorization.interval {
            0 => DEFAULT_POLL_INTERVAL,
            n => n,
        };
        let run = self.inner.rt.run(async move {
            poll_device_token(seconds, || {
                let request = http
                    .post(url.clone())
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.clone());
                async move {
                    let response = request.send().await.map_err(sign_in_network)?;
                    read_auth::<TokenResponse>(response).await
                }
            })
            .await
        });
        async move { run.await.unwrap_or(Err(SignInError::Cancelled)) }
    }

    /// Later launches (07): `GET /api/auth/get-session` with the stored token.
    pub fn get_session(
        &self,
        token: &Token,
    ) -> impl Future<Output = Result<TokenStatus, SignInError>> + Send + 'static {
        let request = with_bearer(
            self.http().get(self.url(&["api", "auth", "get-session"])),
            token,
        )
        .timeout(Duration::from_secs(10));
        let run = self.inner.rt.run(async move {
            let response = request.send().await.map_err(sign_in_network)?;
            if response.status().as_u16() == 401 {
                return Ok(TokenStatus::Revoked);
            }
            let session = read_auth::<serde_json::Value>(response).await?;
            Ok(if session.is_null() {
                TokenStatus::Revoked
            } else {
                TokenStatus::Valid
            })
        });
        async move { run.await.unwrap_or(Err(SignInError::Cancelled)) }
    }

    /// Sign out (07): `POST /api/auth/sign-out` with the token. The app deletes the token even if
    /// this fails.
    pub fn sign_out(
        &self,
        token: &Token,
    ) -> impl Future<Output = Result<(), SignInError>> + Send + 'static {
        let request = with_bearer(
            self.http().post(self.url(&["api", "auth", "sign-out"])),
            token,
        )
        .header(CONTENT_TYPE, "application/json")
        .body("{}");
        let run = self.inner.rt.run(async move {
            let response = request.send().await.map_err(sign_in_network)?;
            read_auth::<serde_json::Value>(response).await.map(|_| ())
        });
        async move { run.await.unwrap_or(Err(SignInError::Cancelled)) }
    }
}

/// A signed-in client: RPC, attachments and the three channels. Clones share one auth state: the
/// first 401 closes every channel opened through any clone and raises [`Signal::Unauthorized`].
#[derive(Clone)]
pub struct Client {
    server: Server,
    token: Token,
    shared: Arc<ClientShared>,
}

pub(crate) struct ClientShared {
    pub(crate) stop: watch::Sender<Option<CloseReason>>,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("server", &self.server)
            .field("token", &self.token)
            .finish_non_exhaustive()
    }
}

impl Client {
    pub fn server(&self) -> &Server {
        &self.server
    }

    pub(crate) fn token(&self) -> &Token {
        &self.token
    }

    pub(crate) fn stop_receiver(&self) -> watch::Receiver<Option<CloseReason>> {
        self.shared.stop.subscribe()
    }

    /// True after a 401: the token no longer works.
    pub fn is_unauthorized(&self) -> bool {
        *self.shared.stop.borrow() == Some(CloseReason::Unauthorized)
    }

    /// Closes every channel of this client (sign out). Their receivers get `Closed(Stopped)`.
    pub fn invalidate_session(&self) {
        self.unauthorized();
    }
    pub fn close_channels(&self) {
        self.shared.stop.send_if_modified(|s| {
            let first = s.is_none();
            if first {
                *s = Some(CloseReason::Stopped);
            }
            first
        });
    }

    pub(crate) fn unauthorized(&self) {
        let first = self.shared.stop.send_if_modified(|s| {
            let first = *s != Some(CloseReason::Unauthorized);
            *s = Some(CloseReason::Unauthorized);
            first
        });
        if first {
            self.server.inner.rt.signal(Signal::Unauthorized);
        }
    }

    /// `POST /api/v1/rpc/<F::NAME>` with `input` as the body (07, C3). Runs on tokio; the future
    /// works on any executor, and dropping it cancels the request.
    pub fn call<F: Function>(
        &self,
        input: F::Input,
    ) -> impl Future<Output = Result<F::Output, ApiError>> + Send + 'static {
        let body = serde_json::to_vec(&input);
        let request = with_bearer(
            self.server
                .http()
                .post(self.server.url(&["api", "v1", "rpc", F::NAME])),
            &self.token,
        )
        .header(CONTENT_TYPE, "application/json");
        let request = if matches!(F::NAME, "commitAndPush" | "revertToCheckpoint") {
            request.timeout(Duration::from_secs(360))
        } else {
            request
        };
        self.send(async move {
            let body = body.map_err(|e| ApiError::Decode(decode_error(&e)))?;
            let response = request
                .body(body)
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            read_api::<F::Output>(response).await
        })
    }

    /// `POST /api/workspaces/<workspaceId>/attachments`: multipart, one file, at most 10 MiB (02).
    /// The answer is `{attachmentId, name, mime, size}`; packages/protocol has no type for it yet.
    pub fn upload_attachment(
        &self,
        workspace_id: &str,
        file_name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<serde_json::Value, ApiError>> + Send + 'static {
        let size = bytes.len() as u64;
        let mut prng = Prng::seeded();
        let boundary = format!("tempo-{:016x}{:016x}", prng.next_u64(), prng.next_u64());
        let body = multipart_body(&boundary, file_name, mime, &bytes);
        let request = with_bearer(
            self.server.http().post(self.server.url(&[
                "api",
                "workspaces",
                workspace_id,
                "attachments",
            ])),
            &self.token,
        )
        .header(
            CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        );
        self.send(async move {
            if size > MAX_ATTACHMENT_BYTES {
                return Err(ApiError::TooLarge { size });
            }
            let response = request
                .body(body)
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            read_api::<serde_json::Value>(response).await
        })
    }

    /// `GET /api/workspaces/<workspaceId>/attachments/<attachmentId>` (02, Attachments): the original
    /// bytes and their served type, at most 10 MiB. A 404 is `NOT_FOUND`.
    pub fn get_attachment(
        &self,
        workspace_id: &str,
        attachment_id: &str,
    ) -> impl Future<Output = Result<AttachmentFile, ApiError>> + Send + 'static {
        let request = with_bearer(
            self.server.http().get(self.server.url(&[
                "api",
                "workspaces",
                workspace_id,
                "attachments",
                attachment_id,
            ])),
            &self.token,
        )
        .timeout(Duration::from_secs(120));
        self.send(async move {
            let mut response = request
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            let status = response.status().as_u16();
            if status != 200 {
                return Err(read_error(response, status).await);
            }
            if let Some(size) = response
                .content_length()
                .filter(|size| *size > MAX_ATTACHMENT_BYTES)
            {
                return Err(ApiError::TooLarge { size });
            }
            let mime = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(';').next())
                .map(|v| v.trim().to_ascii_lowercase())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "application/octet-stream".into());
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?
            {
                let size = bytes.len() as u64 + chunk.len() as u64;
                if size > MAX_ATTACHMENT_BYTES {
                    return Err(ApiError::TooLarge { size });
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(AttachmentFile { mime, bytes })
        })
    }

    pub fn download_mac(
        &self,
        version: &str,
        expected_size: u64,
    ) -> impl Future<Output = Result<Vec<u8>, ApiError>> + Send + 'static {
        self.download_mac_inner(version, expected_size, Some(expected_size))
    }

    pub fn download_mac_bounded(
        &self,
        version: &str,
        maximum_size: u64,
    ) -> impl Future<Output = Result<Vec<u8>, ApiError>> + Send + 'static {
        self.download_mac_inner(version, maximum_size, None)
    }

    fn download_mac_inner(
        &self,
        version: &str,
        maximum_size: u64,
        exact_size: Option<u64>,
    ) -> impl Future<Output = Result<Vec<u8>, ApiError>> + Send + 'static {
        let valid = crate::parse_version(version).is_some() && maximum_size > 0;
        let request = with_bearer(
            self.server
                .http()
                .get(self.server.url(&["downloads", "mac", version])),
            &self.token,
        )
        .timeout(Duration::from_secs(600));
        self.send(async move {
            if !valid {
                return Err(ApiError::Decode("Invalid release information".into()));
            }
            let mut response = request
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            if response.status().as_u16() != 200 {
                return Err(ApiError::Http {
                    status: response.status().as_u16(),
                });
            }
            let declared_size = response.content_length();
            if declared_size.is_some_and(|size| {
                size > maximum_size || exact_size.is_some_and(|expected| size != expected)
            }) {
                return Err(ApiError::Decode(
                    "The download size does not match the release".into(),
                ));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?
            {
                if bytes.len() as u64 + chunk.len() as u64 > maximum_size {
                    return Err(ApiError::Decode(
                        "The download is larger than the release".into(),
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            if bytes.is_empty()
                || exact_size
                    .or(declared_size)
                    .is_some_and(|size| bytes.len() as u64 != size)
            {
                return Err(ApiError::Decode("The download is incomplete".into()));
            }
            Ok(bytes)
        })
    }

    fn send<T: Send + 'static>(
        &self,
        fut: impl Future<Output = Result<T, ApiError>> + Send + 'static,
    ) -> impl Future<Output = Result<T, ApiError>> + Send + 'static {
        let this = self.clone();
        let run = self.server.inner.rt.run(async move {
            if this.is_unauthorized() {
                return Err(ApiError::Http { status: 401 });
            }
            let result = fut.await;
            if matches!(&result, Err(e) if e.is_unauthorized()) {
                this.unauthorized();
            }
            result
        });
        async move { run.await.unwrap_or(Err(ApiError::Cancelled)) }
    }
}

async fn poll_device_token<F, Fut>(seconds: u64, mut exchange: F) -> Result<Token, SignInError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<TokenResponse, SignInError>>,
{
    let mut interval = Duration::from_secs(seconds);
    loop {
        tokio::time::sleep(interval).await;
        match exchange().await {
            Ok(token) => return Ok(Token::new(token.access_token)),
            Err(SignInError::Rejected {
                error: Some(code), ..
            }) if code == "authorization_pending" => {}
            Err(SignInError::Rejected {
                error: Some(code), ..
            }) if code == "slow_down" => interval += SLOW_DOWN_STEP,
            Err(SignInError::Rejected {
                error: Some(code), ..
            }) if code == "access_denied" || code == "expired_token" => {
                return Err(SignInError::Denied);
            }
            Err(error) => return Err(error),
        }
    }
}

fn with_bearer(request: RequestBuilder, token: &Token) -> RequestBuilder {
    match HeaderValue::from_str(&token.bearer()) {
        Ok(mut value) => {
            value.set_sensitive(true);
            request.header(AUTHORIZATION, value)
        }
        Err(_) => request,
    }
}

fn sign_in_network(e: reqwest::Error) -> SignInError {
    SignInError::Network(network_error(e))
}

async fn read_api<T: DeserializeOwned>(response: Response) -> Result<T, ApiError> {
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| ApiError::Network(network_error(e)))?;
    if status == 200 {
        return serde_json::from_slice(&bytes).map_err(|e| ApiError::Decode(decode_error(&e)));
    }
    match serde_json::from_slice::<ErrorBody>(&bytes) {
        Ok(error) => Err(ApiError::Server { status, error }),
        Err(_) => Err(ApiError::Http { status }),
    }
}

/// The error of a non-200 answer whose body is not JSON output. Reads at most 64 KiB of it.
async fn read_error(mut response: Response, status: u16) -> ApiError {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if body.len() + chunk.len() > 64 * 1024 {
            break;
        }
        body.extend_from_slice(&chunk);
    }
    match serde_json::from_slice::<ErrorBody>(&body) {
        Ok(error) => ApiError::Server { status, error },
        Err(_) if status == 404 => ApiError::Server {
            status,
            error: ErrorBody {
                code: ErrorCode::NotFound,
                message: "Not found.".into(),
                detail: None,
            },
        },
        Err(_) => ApiError::Http { status },
    }
}

async fn read_auth<T: DeserializeOwned>(response: Response) -> Result<T, SignInError> {
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(sign_in_network)?;
    if status == 200 {
        return serde_json::from_slice(&bytes).map_err(|e| SignInError::Decode(decode_error(&e)));
    }
    let error = serde_json::from_slice::<OAuthError>(&bytes)
        .ok()
        .map(|e| e.error);
    Err(SignInError::Rejected { status, error })
}

/// One `multipart/form-data` part named `file` (RFC 7578), with the file name escaped as browsers do.
fn multipart_body(boundary: &str, file_name: &str, mime: &str, bytes: &[u8]) -> Vec<u8> {
    let name: String = file_name
        .chars()
        .map(|c| match c {
            '"' => "%22".to_owned(),
            '\r' => "%0D".to_owned(),
            '\n' => "%0A".to_owned(),
            c => c.to_string(),
        })
        .collect();
    let mime = if mime.is_empty() || mime.contains(['\r', '\n']) {
        "application/octet-stream"
    } else {
        mime
    };
    let mut body = Vec::with_capacity(bytes.len() + 256);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_escapes_the_file_name() {
        let body = multipart_body("b", "a\"b\r\n.txt", "text/plain", b"hi");
        let text = String::from_utf8(body).expect("utf8");
        assert_eq!(
            text,
            "--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a%22b%0D%0A.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b--\r\n"
        );
    }

    #[test]
    fn device_code_is_redacted() {
        let auth: DeviceAuthorization = serde_json::from_value(serde_json::json!({
            "device_code": "secret-device-code",
            "user_code": "ABCD1234",
            "verification_uri": "https://t.example/device",
            "verification_uri_complete": "https://t.example/device?user_code=ABCD1234",
            "expires_in": 900,
            "interval": 5
        }))
        .expect("decodes");
        let debug = format!("{auth:?}");
        assert!(!debug.contains("secret-device-code"));
        assert!(debug.contains("ABCD1234"));
    }
}

#[cfg(test)]
mod polling_tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn polling_clock_excludes_transport_latency_and_slow_down_adds_five_seconds() {
        let start = tokio::time::Instant::now();
        let mut calls = vec![];
        let token = poll_device_token(5, || {
            calls.push(tokio::time::Instant::now());
            let result = match calls.len() {
                1 | 3 => Err(SignInError::Rejected {
                    status: 400,
                    error: Some("authorization_pending".into()),
                }),
                2 => Err(SignInError::Rejected {
                    status: 400,
                    error: Some("slow_down".into()),
                }),
                _ => Ok(TokenResponse {
                    access_token: "test-token".into(),
                }),
            };
            std::future::ready(result)
        })
        .await
        .unwrap();
        assert_eq!(token.expose(), "test-token");
        let gaps: Vec<_> = std::iter::once(start)
            .chain(calls)
            .collect::<Vec<_>>()
            .windows(2)
            .map(|w| w[1] - w[0])
            .collect();
        assert_eq!(gaps, [5, 5, 10, 10].map(Duration::from_secs));
    }
}
