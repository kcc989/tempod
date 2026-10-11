//! 07 Testing, Client row: the server check and device sign-in (07, Sign-in steps 2 to 7) against a
//! fake Better Auth, on tokio's paused clock.

mod common;

use std::time::Duration;

use common::{APP_VERSION, FakeHttp, TOKEN, fake_http};
use serde_json::json;
use tempo_client::{
    CLIENT_ID, DENIED_MESSAGE, DEVICE_GRANT_TYPE, NOT_TEMPO_MESSAGE, RuntimeHandle, Server,
    SignInError, Token, TokenStatus,
};

fn device_code() -> String {
    json!({
        "device_code": "dc-secret",
        "user_code": "WXYZ2345",
        "verification_uri": "https://tempo.example.com/device",
        "verification_uri_complete": "https://tempo.example.com/device?user_code=WXYZ2345",
        "expires_in": 900,
        "interval": 5
    })
    .to_string()
}

fn oauth_error(code: &str) -> (u16, String) {
    (
        400,
        json!({"error": code, "error_description": "x"}).to_string(),
    )
}

fn token_ok() -> (u16, String) {
    (
        200,
        json!({"access_token": "new-token", "token_type": "Bearer", "expires_in": 2_592_000, "scope": ""})
            .to_string(),
    )
}

/// `device/code` is request 0; `device/token` answers from `polls` in order.
async fn better_auth(polls: Vec<(u16, String)>) -> FakeHttp {
    fake_http(move |req, index| match req.path.as_str() {
        "/api/auth/device/code" => (200, device_code()),
        "/api/auth/device/token" => polls
            .get(index - 1)
            .cloned()
            .unwrap_or_else(|| oauth_error("expired_token")),
        _ => (404, "{}".into()),
    })
    .await
}

async fn sign_in(server: &FakeHttp) -> Result<Token, SignInError> {
    let rt = RuntimeHandle::current();
    let s = Server::new(&rt, &server.base, APP_VERSION).expect("server");
    let auth = s.start_device_flow().await.expect("device code");
    assert_eq!(auth.user_code, "WXYZ2345");
    assert_eq!(
        auth.verification_uri_complete,
        "https://tempo.example.com/device?user_code=WXYZ2345"
    );
    assert!(!format!("{auth:?}").contains("dc-secret"));
    s.poll_token(&auth).await
}

#[tokio::test(start_paused = true)]
async fn check_server_accepts_protocol_1_and_a_new_enough_app() {
    let server = fake_http(|_, _| {
        (
            200,
            json!({"protocol":1,"serverVersion":"0.3.0","minMacClient":"0.2.0","latestMacClient":"0.3.0"})
                .to_string(),
        )
    })
    .await;
    let rt = RuntimeHandle::current();
    let meta = Server::new(&rt, &server.base, APP_VERSION)
        .expect("server")
        .check_server()
        .await
        .expect("a Tempo server");
    assert_eq!(meta.server_version, "0.3.0");
    assert_eq!(
        tempo_client::newer_version_available(&meta, APP_VERSION),
        Some("0.3.0")
    );
}

#[tokio::test(start_paused = true)]
async fn check_server_refuses_another_protocol_or_a_failing_meta() {
    let rt = RuntimeHandle::current();
    let other = fake_http(|_, _| {
        (
            200,
            json!({"protocol":2,"serverVersion":"9.0.0","minMacClient":"0.1.0","latestMacClient":null})
                .to_string(),
        )
    })
    .await;
    let err = Server::new(&rt, &other.base, APP_VERSION)
        .expect("server")
        .check_server()
        .await
        .expect_err("protocol 2");
    assert_eq!(err, SignInError::NotTempo);
    assert_eq!(err.to_string(), NOT_TEMPO_MESSAGE);

    let html = fake_http(|_, _| (200, "<html></html>".into())).await;
    let err = Server::new(&rt, &html.base, APP_VERSION)
        .expect("server")
        .check_server()
        .await
        .expect_err("not JSON");
    assert_eq!(err, SignInError::NotTempo);

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let closed = format!("http://{}", listener.local_addr().expect("addr"));
    drop(listener);
    let err = Server::new(&rt, &closed, APP_VERSION)
        .expect("server")
        .check_server()
        .await
        .expect_err("nothing listens");
    assert_eq!(err, SignInError::NotTempo);
}

#[tokio::test(start_paused = true)]
async fn check_server_asks_for_an_update_below_min_mac_client() {
    let server = fake_http(|_, _| {
        (
            200,
            json!({"protocol":1,"serverVersion":"1.0.0","minMacClient":"0.10.0","latestMacClient":"0.10.1"})
                .to_string(),
        )
    })
    .await;
    let rt = RuntimeHandle::current();
    let err = Server::new(&rt, &server.base, APP_VERSION)
        .expect("server")
        .check_server()
        .await
        .expect_err("0.2.0 < 0.10.0");
    assert_eq!(
        err,
        SignInError::UpdateRequired {
            min_mac_client: "0.10.0".into(),
            latest_mac_client: Some("0.10.1".into()),
        }
    );
}

#[tokio::test(start_paused = true)]
async fn device_flow_polls_every_interval_and_slows_down_by_five_seconds() {
    let server = better_auth(vec![
        oauth_error("authorization_pending"),
        oauth_error("slow_down"),
        oauth_error("authorization_pending"),
        token_ok(),
    ])
    .await;
    let token = sign_in(&server).await.expect("signed in");
    assert_eq!(token.expose(), "new-token");

    let reqs = server.requests();
    assert_eq!(reqs[0].path, "/api/auth/device/code");
    assert_eq!(reqs[0].json(), json!({ "client_id": CLIENT_ID }));
    assert_eq!(reqs[0].header("origin"), None);
    let polls: Vec<_> = reqs.iter().skip(1).collect();
    assert_eq!(polls.len(), 4);
    for p in &polls {
        assert_eq!(p.method, "POST");
        assert_eq!(p.path, "/api/auth/device/token");
        assert_eq!(
            p.json(),
            json!({"grant_type": DEVICE_GRANT_TYPE, "device_code": "dc-secret", "client_id": "tempo-mac"})
        );
    }
    let gaps: Vec<Duration> = std::iter::once(reqs[0].at)
        .chain(polls.iter().map(|p| p.at))
        .collect::<Vec<_>>()
        .windows(2)
        .map(|w| w[1] - w[0])
        .collect();
    let s = Duration::from_secs;
    assert_eq!(gaps, [s(5), s(5), s(10), s(10)]);
}

#[tokio::test(start_paused = true)]
async fn access_denied_and_expired_token_end_sign_in() {
    for code in ["access_denied", "expired_token"] {
        let server = better_auth(vec![
            oauth_error("authorization_pending"),
            oauth_error(code),
        ])
        .await;
        let err = sign_in(&server).await.expect_err(code);
        assert_eq!(err, SignInError::Denied);
        assert_eq!(err.to_string(), DENIED_MESSAGE);
    }
    let server = better_auth(vec![oauth_error("invalid_grant")]).await;
    assert_eq!(
        sign_in(&server).await,
        Err(SignInError::Rejected {
            status: 400,
            error: Some("invalid_grant".into())
        })
    );
}

#[tokio::test(start_paused = true)]
async fn get_session_tells_a_valid_token_from_a_revoked_one() {
    let server = fake_http(|req, _| match req.header("authorization") {
        Some("Bearer test-session-token") => (
            200,
            json!({"session": {"id": "s"}, "user": {"id": "u"}}).to_string(),
        ),
        _ => (200, "null".into()),
    })
    .await;
    let rt = RuntimeHandle::current();
    let s = Server::new(&rt, &server.base, APP_VERSION).expect("server");
    assert_eq!(
        s.get_session(&Token::new(TOKEN)).await,
        Ok(TokenStatus::Valid)
    );
    assert_eq!(
        s.get_session(&Token::new("revoked")).await,
        Ok(TokenStatus::Revoked)
    );
    let r = &server.requests()[0];
    assert_eq!(
        (r.method.as_str(), r.path.as_str()),
        ("GET", "/api/auth/get-session")
    );
    assert_eq!(r.header("origin"), None);
}

#[tokio::test(start_paused = true)]
async fn sign_out_posts_with_the_token() {
    let server = fake_http(|_, _| (200, json!({"success": true}).to_string())).await;
    let rt = RuntimeHandle::current();
    let s = Server::new(&rt, &server.base, APP_VERSION).expect("server");
    assert_eq!(s.sign_out(&Token::new(TOKEN)).await, Ok(()));
    let r = &server.requests()[0];
    assert_eq!(
        (r.method.as_str(), r.path.as_str()),
        ("POST", "/api/auth/sign-out")
    );
    assert_eq!(r.header("authorization"), Some("Bearer test-session-token"));
    assert_eq!(r.header("origin"), None);

    let failing = fake_http(|_, _| (500, "{}".into())).await;
    let s = Server::new(&rt, &failing.base, APP_VERSION).expect("server");
    assert!(s.sign_out(&Token::new(TOKEN)).await.is_err());
}
