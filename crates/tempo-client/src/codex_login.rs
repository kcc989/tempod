use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::{ApiError, Client, tls};
use tempo_protocol::{ErrorBody, ErrorCode, SetCodexAuthIn, api};

const ISSUER: &str = "https://auth.openai.com";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const TTL: Duration = Duration::from_secs(900);

#[cfg(test)]
#[path = "../tests/common/mod.rs"]
mod common;

#[derive(Clone)]
pub struct CodexLogin {
    pub user_code: String,
    pub verification_url: String,
    pub interval: Duration,
    device_auth_id: String,
    expires: std::time::Instant,
    connected: std::sync::Arc<tokio::sync::Mutex<bool>>,
}

impl CodexLogin {
    pub fn poll_delay(&self) -> Duration {
        self.interval.min(
            self.expires
                .saturating_duration_since(std::time::Instant::now()),
        )
    }
}

impl fmt::Debug for CodexLogin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CodexLogin").finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexLoginStatus {
    Pending,
    Connected,
    Expired,
}

#[derive(Clone)]
pub struct CodexAuth {
    http: reqwest::Client,
    issuer: String,
}

fn failed(message: impl Into<String>) -> ApiError {
    ApiError::Server {
        status: 502,
        error: ErrorBody {
            code: ErrorCode::CredentialInvalid,
            message: message.into(),
            detail: None,
        },
    }
}

impl CodexAuth {
    pub fn new() -> Result<Self, ApiError> {
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(
                tls::client_config(&[b"http/1.1"])
                    .map_err(|_| failed("Could not prepare the secure Codex connection."))?,
            )
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| failed("Could not prepare the secure Codex connection."))?;
        Ok(Self {
            http,
            issuer: ISSUER.into(),
        })
    }

    async fn post(
        &self,
        path: &str,
        body: String,
        form: bool,
    ) -> Result<reqwest::Response, ApiError> {
        self.http.post(format!("{}{path}", self.issuer))
            .header("Content-Type", if form { "application/x-www-form-urlencoded" } else { "application/json" })
            .body(body).send().await
            .map_err(|_| failed("Could not reach OpenAI for Codex sign-in. Check your connection and try again."))
    }

    async fn json(response: reqwest::Response, step: &str) -> Result<Value, ApiError> {
        if !response.status().is_success() {
            return Err(failed(format!(
                "OpenAI rejected the Codex {step} request (HTTP {}). Try again. Device-code login must be enabled in ChatGPT security settings or by your workspace admin.",
                response.status().as_u16()
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| failed("Could not read the Codex sign-in response. Try again."))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| failed("OpenAI returned an unexpected Codex sign-in response. Try again."))
    }

    pub async fn start(&self) -> Result<CodexLogin, ApiError> {
        let response = self
            .post(
                "/api/accounts/deviceauth/usercode",
                json!({"client_id": CLIENT_ID}).to_string(),
                false,
            )
            .await?;
        let data = Self::json(response, "device-code").await?;
        let interval = match &data["interval"] {
            Value::Null => 5,
            Value::String(s) => s.trim().parse::<u64>().map_err(|_| malformed())?,
            Value::Number(n) => n.as_u64().ok_or_else(malformed)?,
            _ => return Err(malformed()),
        };
        Ok(CodexLogin {
            user_code: text(
                data.get("user_code")
                    .or_else(|| data.get("usercode"))
                    .unwrap_or(&Value::Null),
            )?
            .into(),
            verification_url: format!("{}/codex/device", self.issuer),
            interval: Duration::from_secs(interval.max(1)),
            device_auth_id: text(&data["device_auth_id"])?.into(),
            expires: std::time::Instant::now() + TTL,
            connected: std::sync::Arc::new(tokio::sync::Mutex::new(false)),
        })
    }

    pub async fn poll(
        &self,
        login: &CodexLogin,
        client: &Client,
    ) -> Result<CodexLoginStatus, ApiError> {
        let mut connected = login.connected.lock().await;
        if *connected {
            return Ok(CodexLoginStatus::Connected);
        }
        if std::time::Instant::now() >= login.expires {
            return Ok(CodexLoginStatus::Expired);
        }
        let response = self
            .post(
                "/api/accounts/deviceauth/token",
                json!({"device_auth_id": login.device_auth_id, "user_code": login.user_code})
                    .to_string(),
                false,
            )
            .await?;
        if matches!(response.status().as_u16(), 403 | 404) {
            return Ok(CodexLoginStatus::Pending);
        }
        let data = Self::json(response, "approval").await?;
        let mut body = reqwest::Url::parse("https://auth.openai.com").unwrap();
        body.query_pairs_mut().extend_pairs([
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", text(&data["authorization_code"])?),
            ("code_verifier", text(&data["code_verifier"])?),
            (
                "redirect_uri",
                &format!("{}/deviceauth/callback", self.issuer),
            ),
        ]);
        let response = self
            .post("/oauth/token", body.query().unwrap().into(), true)
            .await?;
        let tokens = Self::json(response, "token exchange").await?;
        let auth_json = auth_json(&tokens)?.try_into().map_err(|_| malformed())?;
        if std::time::Instant::now() >= login.expires {
            return Ok(CodexLoginStatus::Expired);
        }
        client
            .call::<api::SetCodexAuth>(SetCodexAuthIn { auth_json })
            .await?;
        *connected = true;
        Ok(CodexLoginStatus::Connected)
    }
}

fn malformed() -> ApiError {
    failed("OpenAI returned an unexpected Codex sign-in response. Try again.")
}

fn text(value: &Value) -> Result<&str, ApiError> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(malformed)
}

fn auth_json(tokens: &Value) -> Result<String, ApiError> {
    let id_token = text(&tokens["id_token"])?;
    let payload = id_token.split('.').nth(1).ok_or_else(malformed)?;
    let mut bytes = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for c in payload.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err(malformed()),
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    let claims: Value = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
    let account_id = text(&claims["https://api.openai.com/auth"]["chatgpt_account_id"])?;
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| malformed())?
        .as_secs();
    Ok(
        json!({"auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": {
        "id_token": id_token, "access_token": text(&tokens["access_token"])?,
        "refresh_token": text(&tokens["refresh_token"])?, "account_id": account_id,
    }, "last_refresh": iso_time(seconds)})
        .to_string(),
    )
}

fn iso_time(seconds: u64) -> String {
    let mut days = seconds / 86400;
    let mut year = 1970;
    let leap = |y: u64| y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
    loop {
        let length = if leap(year) { 366 } else { 365 };
        if days < length {
            break;
        }
        days -= length;
        year += 1;
    }
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for length in months {
        if days < length {
            break;
        }
        days -= length;
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        days + 1,
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RuntimeHandle, Server, Token};
    use common::{APP_VERSION, TOKEN, fake_http};

    fn tokens() -> Value {
        json!({
            "id_token": "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjb3VudC0xIn19.signature",
            "access_token": "private-access", "refresh_token": "private-refresh",
        })
    }

    async fn tempo() -> (common::FakeHttp, Client) {
        let server = fake_http(|request, _| {
            assert_eq!(request.path, "/api/v1/rpc/setCodexAuth");
            let input: Value = serde_json::from_slice(&request.body).unwrap();
            let auth: Value = serde_json::from_str(input["authJson"].as_str().unwrap()).unwrap();
            assert_eq!(auth["tokens"]["account_id"], "account-1");
            assert_eq!(auth["tokens"]["access_token"], "private-access");
            assert!(auth["last_refresh"].as_str().unwrap().ends_with(".000Z"));
            (200, "{}".into())
        })
        .await;
        let client = Server::new(&RuntimeHandle::current(), &server.base, APP_VERSION)
            .unwrap()
            .client(Token::new(TOKEN));
        (server, client)
    }

    #[tokio::test]
    async fn device_sign_in_saves_only_after_approval_and_never_sends_tempo_auth_to_openai() {
        let upstream = fake_http(|request, index| {
            assert!(!request.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization") || k.eq_ignore_ascii_case("x-tempo-client")));
            match index {
                0 => {
                    assert_eq!(request.path, "/api/accounts/deviceauth/usercode");
                    assert_eq!(serde_json::from_slice::<Value>(&request.body).unwrap(), json!({"client_id": CLIENT_ID}));
                    (200, json!({"device_auth_id": "private-id", "usercode": "ABCD-EFGH", "interval": "0"}).to_string())
                }
                1 | 2 => {
                    assert_eq!(request.path, "/api/accounts/deviceauth/token");
                    assert_eq!(serde_json::from_slice::<Value>(&request.body).unwrap(), json!({"device_auth_id": "private-id", "user_code": "ABCD-EFGH"}));
                    (if index == 1 {403} else {404}, "{}".into())
                }
                3 => (200, json!({"authorization_code": "private-code", "code_verifier": "private-verifier"}).to_string()),
                4 => {
                    assert_eq!(request.path, "/oauth/token");
                    let form = reqwest::Url::parse(&format!("http://local/?{}", String::from_utf8_lossy(&request.body))).unwrap();
                    let fields: std::collections::HashMap<_, _> = form.query_pairs().into_owned().collect();
                    assert_eq!(fields["code_verifier"], "private-verifier");
                    assert_eq!(fields["code"], "private-code");
                    assert!(fields["redirect_uri"].ends_with("/deviceauth/callback"));
                    (200, tokens().to_string())
                }
                _ => panic!("extra request"),
            }
        }).await;
        let mut auth = CodexAuth::new().unwrap();
        auth.issuer = upstream.base.clone();
        let (tempo, client) = tempo().await;
        let login = auth.start().await.unwrap();
        assert_eq!(login.interval, Duration::from_secs(1));
        assert!(!format!("{login:?}").contains("private-id"));
        for _ in 0..2 {
            assert_eq!(
                auth.poll(&login, &client).await.unwrap(),
                CodexLoginStatus::Pending
            );
            assert!(tempo.requests().is_empty());
        }
        assert_eq!(
            auth.poll(&login, &client).await.unwrap(),
            CodexLoginStatus::Connected
        );
        assert_eq!(
            auth.poll(&login, &client).await.unwrap(),
            CodexLoginStatus::Connected
        );
        assert_eq!(tempo.requests().len(), 1);
        assert_eq!(upstream.requests().len(), 5);
    }

    #[tokio::test]
    async fn cancelling_an_in_flight_exchange_closes_it_without_saving() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let upstream = fake_http(|_, _| {
            (
                200,
                json!({"device_auth_id": "private-id", "user_code": "ABCD-EFGH"}).to_string(),
            )
        })
        .await;
        let mut auth = CodexAuth::new().unwrap();
        auth.issuer = upstream.base;
        let login = auth.start().await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        auth.issuer = format!("http://{}", listener.local_addr().unwrap());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            async fn request(stream: &mut tokio::net::TcpStream) {
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0u8; 1024];
                    let n = stream.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]);
                        let length: usize = header
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse().ok())
                            })
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            return;
                        }
                    }
                }
            }
            let (mut stream, _) = listener.accept().await.unwrap();
            request(&mut stream).await;
            let body =
                json!({"authorization_code": "private-code", "code_verifier": "private-verifier"})
                    .to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            drop(stream);
            let (mut stream, _) = listener.accept().await.unwrap();
            request(&mut stream).await;
            ready_tx.send(()).unwrap();
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
        });
        let (tempo, client) = tempo().await;
        let running = RuntimeHandle::current().run(async move { auth.poll(&login, &client).await });
        ready_rx.await.unwrap();
        drop(running);
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert!(tempo.requests().is_empty());
    }

    #[tokio::test]
    async fn expired_and_rejected_sign_ins_do_not_upload_credentials() {
        let upstream = fake_http(|_, index| match index {
            0 => (
                200,
                json!({"device_auth_id": "private-id", "user_code": "ABCD-EFGH", "interval": 5})
                    .to_string(),
            ),
            _ => (500, "private-access private-verifier".into()),
        })
        .await;
        let mut auth = CodexAuth::new().unwrap();
        auth.issuer = upstream.base.clone();
        let (tempo, client) = tempo().await;
        let mut login = auth.start().await.unwrap();
        let error = auth.poll(&login, &client).await.unwrap_err();
        assert!(error.to_string().contains("HTTP 500"));
        assert!(!format!("{error:?}").contains("private-access"));
        login.expires = std::time::Instant::now();
        assert_eq!(
            auth.poll(&login, &client).await.unwrap(),
            CodexLoginStatus::Expired
        );
        assert_eq!(upstream.requests().len(), 2);
        assert!(tempo.requests().is_empty());
    }

    #[tokio::test]
    async fn malformed_responses_and_redirects_never_become_credentials() {
        for body in [
            "not JSON",
            "{}",
            r#"{"device_auth_id":"private-id","user_code":"code","interval":"bad"}"#,
        ] {
            let upstream = fake_http(move |_, _| (200, body.into())).await;
            let mut auth = CodexAuth::new().unwrap();
            auth.issuer = upstream.base;
            assert!(auth.start().await.is_err());
        }
        let upstream = fake_http(|_, _| (302, "private-token".into())).await;
        let mut auth = CodexAuth::new().unwrap();
        auth.issuer = upstream.base;
        assert!(
            auth.start()
                .await
                .unwrap_err()
                .to_string()
                .contains("HTTP 302")
        );
    }
    #[test]
    fn dates_cover_epoch_leap_day_and_century() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(951782400), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_time(4107542400), "2100-03-01T00:00:00.000Z");
    }
    #[test]
    fn malformed_credentials_never_enter_errors() {
        let error = auth_json(&json!({"id_token": "private-token"})).unwrap_err();
        assert!(!format!("{error:?}").contains("private-token"));
    }
}
