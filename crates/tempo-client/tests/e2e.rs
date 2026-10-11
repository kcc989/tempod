//! 07 Testing, End to end: `cargo test -p tempo-client --features e2e` against a deployed Tempo with
//! a real token. Reads TEMPO_E2E_URL and TEMPO_E2E_TOKEN. Read-only: meta, `listProjects` and the
//! hub channel's hello. Built only with the `e2e` feature (Cargo.toml `required-features`).

use std::time::Duration;

use tempo_client::{ChannelEvent, RuntimeHandle, Server, Status, Token, TokenStatus};
use tempo_protocol::{Empty, HubServerMessage, api};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deployed_tempo_answers_meta_rpc_and_the_hub() {
    let rt = RuntimeHandle::current();
    let server =
        Server::new(&rt, &env("TEMPO_E2E_URL"), env!("CARGO_PKG_VERSION")).expect("a Tempo URL");
    let meta = server.check_server().await.expect("a Tempo server");
    assert_eq!(*meta.protocol, 1.0);

    let token = Token::new(env("TEMPO_E2E_TOKEN"));
    assert_eq!(
        server.get_session(&token).await.expect("get-session"),
        TokenStatus::Valid
    );
    let client = server.client(token);
    client
        .call::<api::ListProjects>(Empty {})
        .await
        .expect("listProjects");

    let (rx, hub) = client.open_hub();
    let hello = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match rx.recv().await.expect("hub open") {
                ChannelEvent::Message(HubServerMessage::HubHello(h)) => return h,
                ChannelEvent::Status(Status::Closed(reason)) => panic!("hub closed: {reason:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("hello within 30 s");
    assert_eq!(*hello.v, 1.0);
    hub.close();
}
