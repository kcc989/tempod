//! 07 Testing, Client row: RPC calls, error decoding, 401, meta and attachments against a fake
//! server.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use common::{APP_VERSION, RawReply, TOKEN, fake_http, fake_http_raw};
use serde_json::json;
use tempo_client::{
    ApiError, AttachmentFile, ChannelEvent, CloseReason, MAX_ARTIFACT_BYTES, MAX_ATTACHMENT_BYTES,
    Runtime, RuntimeHandle, Server, Signal, Status, Token,
};
use tempo_protocol::{ErrorCode, SendPromptIn, Turn, api};

fn fixture(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/types")
        .join(format!("{name}.jsonl"));
    std::fs::read_to_string(path)
        .expect("fixture")
        .lines()
        .next()
        .expect("one sample")
        .to_owned()
}

fn client(rt: &RuntimeHandle, base: &str) -> tempo_client::Client {
    Server::new(rt, base, APP_VERSION)
        .expect("server")
        .client(Token::new(TOKEN))
}

#[tokio::test(start_paused = true)]
async fn call_posts_the_input_with_bearer_and_client_header_and_decodes_the_output() {
    let turn = fixture("Turn");
    let reply = turn.clone();
    let server = fake_http(move |_, _| (200, reply.clone())).await;
    let rt = RuntimeHandle::current();
    let input: SendPromptIn = serde_json::from_str(&fixture("SendPromptIn")).expect("input");
    let out = client(&rt, &server.base)
        .call::<api::SendPrompt>(input.clone())
        .await
        .expect("call succeeds");
    let want: Turn = serde_json::from_str(&turn).expect("turn");
    assert_eq!(out, want);

    let reqs = server.requests();
    assert_eq!(reqs.len(), 1);
    let r = &reqs[0];
    assert_eq!(r.method, "POST");
    assert_eq!(r.path, "/api/v1/rpc/sendPrompt");
    assert_eq!(r.header("authorization"), Some("Bearer test-session-token"));
    assert_eq!(r.header("x-tempo-client"), Some("mac/0.2.0"));
    assert_eq!(r.header("content-type"), Some("application/json"));
    assert_eq!(r.header("origin"), None);
    assert_eq!(r.header("cookie"), None);
    assert_eq!(r.json(), serde_json::to_value(&input).expect("encodes"));
}

#[tokio::test(start_paused = true)]
async fn an_error_answer_decodes_into_api_error_with_its_status() {
    let server = fake_http(|req, _| match req.path.as_str() {
        "/api/v1/rpc/cancelTurn" => (
            409,
            json!({"code":"TURN_NOT_ACTIVE","message":"Nothing to stop.","detail":"turn t1"})
                .to_string(),
        ),
        _ => (502, "<html>bad gateway</html>".into()),
    })
    .await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server.base);
    let input = serde_json::from_str(&fixture("CancelTurnIn")).expect("input");
    let err = c
        .call::<api::CancelTurn>(input)
        .await
        .expect_err("409 is an error");
    assert_eq!(err.status(), Some(409));
    assert_eq!(err.code(), Some(ErrorCode::TurnNotActive));
    let ApiError::Server { error, .. } = &err else {
        panic!("{err:?}");
    };
    assert_eq!(error.message, "Nothing to stop.");
    assert_eq!(error.detail.as_deref(), Some("turn t1"));
    assert_eq!(err.to_string(), "Nothing to stop.");

    let input = serde_json::from_str(&fixture("SleepWorkspaceIn")).expect("input");
    let err = c.call::<api::SleepWorkspace>(input).await.expect_err("502");
    assert_eq!(err, ApiError::Http { status: 502 });
    assert!(!c.is_unauthorized());
}

#[tokio::test(start_paused = true)]
async fn a_401_raises_unauthorized_once_and_closes_every_channel() {
    let server = fake_http(|_, _| {
        (
            401,
            json!({"code":"UNAUTHENTICATED","message":"Sign in to continue."}).to_string(),
        )
    })
    .await;
    let rt = RuntimeHandle::current();
    let signals = rt.signals();
    let c = client(&rt, &server.base);
    let input: SendPromptIn = serde_json::from_str(&fixture("SendPromptIn")).expect("input");
    let err = c
        .call::<api::SendPrompt>(input.clone())
        .await
        .expect_err("401");
    assert!(err.is_unauthorized());
    assert_eq!(err.code(), Some(ErrorCode::Unauthenticated));
    assert!(c.is_unauthorized());
    assert_eq!(signals.try_recv(), Ok(Signal::Unauthorized));

    let _ = c.call::<api::SendPrompt>(input).await;
    assert!(signals.try_recv().is_err(), "one signal per client");

    let (rx, _hub) = c.open_hub();
    assert_eq!(
        rx.recv().await,
        Ok(ChannelEvent::Status(Status::Connecting))
    );
    assert_eq!(
        rx.recv().await,
        Ok(ChannelEvent::Status(Status::Closed(
            CloseReason::Unauthorized
        )))
    );
    assert!(rx.recv().await.is_err(), "nothing follows Closed");
}

#[tokio::test(start_paused = true)]
async fn meta_sends_no_token() {
    let server = fake_http(|_, _| (200, fixture("ApiMeta"))).await;
    let rt = RuntimeHandle::current();
    let meta = Server::new(&rt, &format!("{}/some/path?x=1", server.base), APP_VERSION)
        .expect("server")
        .meta()
        .await
        .expect("meta");
    assert_eq!(meta.min_mac_client, "0.1.0");
    let r = &server.requests()[0];
    assert_eq!(
        (r.method.as_str(), r.path.as_str()),
        ("GET", "/api/v1/meta")
    );
    assert_eq!(r.header("authorization"), None);
    assert_eq!(r.header("origin"), None);
}

#[tokio::test(start_paused = true)]
async fn setup_status_sends_no_token_and_reads_the_install_link() {
    let server = fake_http(|_, _| {
        (
            200,
            json!({"configured": true, "installUrl": "https://github.com/apps/t/installations/new"})
                .to_string(),
        )
    })
    .await;
    let rt = RuntimeHandle::current();
    let status = Server::new(&rt, &server.base, APP_VERSION)
        .expect("server")
        .setup_status()
        .await
        .expect("setup status");
    assert!(status.configured);
    assert_eq!(
        status.install_url.as_deref(),
        Some("https://github.com/apps/t/installations/new")
    );
    let r = &server.requests()[0];
    assert_eq!(
        (r.method.as_str(), r.path.as_str()),
        ("GET", "/api/setup/status")
    );
    assert_eq!(r.header("authorization"), None);
}

#[tokio::test(start_paused = true)]
async fn upload_attachment_sends_one_multipart_file_with_the_bearer_token() {
    let server = fake_http(|_, _| {
        (
            200,
            json!({"attachmentId":"01k700000000000000000000ch","name":"a.png","mime":"image/png","size":3})
                .to_string(),
        )
    })
    .await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server.base);
    let out = c
        .upload_attachment(
            "01k7000000000000000000000b",
            "a.png",
            "image/png",
            vec![1, 2, 3],
        )
        .await
        .expect("uploads");
    assert_eq!(out["attachmentId"], "01k700000000000000000000ch");
    let r = &server.requests()[0];
    assert_eq!(
        r.path,
        "/api/workspaces/01k7000000000000000000000b/attachments"
    );
    assert_eq!(r.header("authorization"), Some("Bearer test-session-token"));
    assert_eq!(r.header("origin"), None);
    let content_type = r.header("content-type").expect("content type");
    let boundary = content_type
        .strip_prefix("multipart/form-data; boundary=")
        .expect("multipart");
    let mut want = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n"
    )
    .into_bytes();
    want.extend_from_slice(&[1, 2, 3]);
    want.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    assert_eq!(r.body, want);

    let big = vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1];
    let err = c
        .upload_attachment("01k7000000000000000000000b", "big.bin", "", big)
        .await
        .expect_err("too large");
    assert_eq!(
        err,
        ApiError::TooLarge {
            size: MAX_ATTACHMENT_BYTES + 1
        }
    );
    assert_eq!(server.requests().len(), 1, "an oversized file is not sent");
}

#[tokio::test(start_paused = true)]
async fn get_attachment_reads_the_bytes_with_the_bearer_token_up_to_10_mib() {
    let server = fake_http_raw(|req, _| {
        let reply = |status, content_type, body: Vec<u8>, content_length| RawReply {
            status,
            content_type,
            body,
            content_length,
        };
        let big = vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1];
        match req.path.rsplit('/').next().unwrap_or_default() {
            "png" => reply(200, "image/png", vec![137, 80, 78, 71], true),
            "gone" => reply(
                404,
                "application/json",
                json!({"code":"NOT_FOUND","message":"Not found."})
                    .to_string()
                    .into_bytes(),
                true,
            ),
            "plain404" => reply(404, "text/plain", b"missing".to_vec(), true),
            "big" => reply(200, "image/png", big, true),
            "stream" => reply(200, "image/png; charset=binary", big, false),
            _ => reply(500, "text/plain", vec![], true),
        }
    })
    .await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server.base);
    let file = c
        .get_attachment("01k7000000000000000000000b", "png")
        .await
        .expect("reads");
    assert_eq!(
        file,
        AttachmentFile {
            mime: "image/png".into(),
            bytes: vec![137, 80, 78, 71]
        }
    );
    let r = &server.requests()[0];
    assert_eq!(
        (r.method.as_str(), r.path.as_str()),
        (
            "GET",
            "/api/workspaces/01k7000000000000000000000b/attachments/png"
        )
    );
    assert_eq!(r.header("authorization"), Some("Bearer test-session-token"));
    assert_eq!(r.header("x-tempo-client"), Some("mac/0.2.0"));
    assert_eq!(r.header("origin"), None);

    for id in ["gone", "plain404"] {
        let err = c.get_attachment("w", id).await.expect_err("404");
        assert_eq!(err.status(), Some(404));
        assert_eq!(err.code(), Some(ErrorCode::NotFound), "{id}");
    }
    for id in ["big", "stream"] {
        let err = c.get_attachment("w", id).await.expect_err("too large");
        assert!(
            matches!(err, ApiError::TooLarge { size } if size > MAX_ATTACHMENT_BYTES),
            "{id}: {err:?}"
        );
    }
    assert!(!c.is_unauthorized());
}

#[tokio::test(start_paused = true)]
async fn get_artifact_reads_one_version_up_to_25_mib_and_keeps_artifact_not_ready() {
    let server = fake_http_raw(|req, _| {
        let reply = |status, content_type, body: Vec<u8>| RawReply {
            status,
            content_type,
            body,
            content_length: true,
        };
        match req.path.rsplit('/').next().unwrap_or_default() {
            "1" => reply(200, "text/markdown", b"# Plan".to_vec()),
            "2" => reply(
                409,
                "application/json",
                json!({"code":"ARTIFACT_NOT_READY","message":"This artifact is still being saved. Try again in a moment."})
                    .to_string()
                    .into_bytes(),
            ),
            _ => reply(200, "image/png", vec![0u8; MAX_ARTIFACT_BYTES as usize + 1]),
        }
    })
    .await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server.base);
    let file = c
        .get_artifact(
            "01k7000000000000000000000b",
            "01jart00000000000000000001",
            1,
        )
        .await
        .expect("reads");
    assert_eq!(file.mime, "text/markdown");
    assert_eq!(file.bytes, b"# Plan");
    assert_eq!(
        server.requests()[0].path,
        "/api/workspaces/01k7000000000000000000000b/artifacts/01jart00000000000000000001/1"
    );
    let err = c.get_artifact("w", "a", 2).await.expect_err("not ready");
    assert_eq!(err.code(), Some(ErrorCode::ArtifactNotReady));
    let err = c.get_artifact("w", "a", 3).await.expect_err("too large");
    assert!(matches!(err, ApiError::TooLarge { size } if size > MAX_ARTIFACT_BYTES));
}

#[test]
fn a_call_runs_on_the_runtime_and_resolves_on_another_executor() {
    let runtime = Runtime::start().expect("runtime");
    let rt = runtime.handle();
    let server = rt.tokio().block_on(fake_http(|_, _| (200, "{}".into())));
    let c = client(&rt, &server.base);
    let input = serde_json::from_str(&fixture("SleepWorkspaceIn")).expect("input");
    let fut = c.call::<api::SleepWorkspace>(input);
    let out = std::thread::spawn(move || block_on(fut))
        .join()
        .expect("joins");
    assert_eq!(out, Ok(tempo_protocol::Empty {}));
    drop(runtime);
}

#[tokio::test(start_paused = true)]
async fn a_server_url_must_be_http_or_https() {
    let rt = RuntimeHandle::current();
    for bad in [
        "",
        "tempo.example.com",
        "ftp://tempo.example.com",
        "file:///tmp",
    ] {
        assert!(Server::new(&rt, bad, APP_VERSION).is_err(), "{bad}");
    }
    let s = Server::new(&rt, " https://Tempo.Example.com/app/ ", APP_VERSION).expect("ok");
    assert_eq!(s.origin(), "https://tempo.example.com");
    assert_eq!(s.host(), "tempo.example.com");
    assert!(!format!("{:?}", s.client(Token::new("secret-value"))).contains("secret-value"));
}

fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    struct ThreadWaker(std::thread::Thread);
    impl Wake for ThreadWaker {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let mut fut = std::pin::pin!(fut);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::park();
    }
}

#[tokio::test(start_paused = true)]
async fn release_download_is_authenticated_size_bound_and_revocation_closes_the_client() {
    let server = fake_http(|_, _| (200, "dmg bytes".into())).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server.base);
    assert_eq!(c.download_mac("0.2.0", 9).await.unwrap(), b"dmg bytes");
    assert!(matches!(
        c.download_mac("0.2.0", 8).await,
        Err(ApiError::Decode(_))
    ));
    let reqs = server.requests();
    assert_eq!(reqs[0].path, "/downloads/mac/0.2.0");
    assert_eq!(
        reqs[0].header("authorization"),
        Some("Bearer test-session-token")
    );
    assert_eq!(reqs[0].header("origin"), None);
    let denied = fake_http(|_, _| (401, "Denied".into())).await;
    let c = client(&rt, &denied.base);
    assert!(
        c.download_mac("0.2.0", 9)
            .await
            .unwrap_err()
            .is_unauthorized()
    );
    assert!(c.is_unauthorized());
}

#[tokio::test(start_paused = true)]
async fn hash_metadata_download_honors_a_hard_size_bound_without_an_exact_manifest_size() {
    let server = fake_http(|_, _| (200, "dmg bytes".into())).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server.base);
    assert_eq!(
        c.download_mac_bounded("0.2.0", 1024).await.unwrap(),
        b"dmg bytes"
    );
    assert!(matches!(
        c.download_mac_bounded("0.2.0", 8).await,
        Err(ApiError::Decode(_))
    ));
    assert!(matches!(
        c.download_mac_bounded("0.2.0", 0).await,
        Err(ApiError::Decode(_))
    ));
    assert_eq!(server.requests().len(), 2);
    assert_eq!(
        server.requests()[0].header("authorization"),
        Some("Bearer test-session-token")
    );
}
