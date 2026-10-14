mod common;
use common::{APP_VERSION, TOKEN, fake_ws};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tempo_client::terminal_bridge::{TerminalBridgeError, TerminalBridgeIo, TerminalTarget};
use tempo_client::{Client, CloseReason, RuntimeHandle, Server, Token};
use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{
    Message,
    protocol::{CloseFrame, frame::coding::CloseCode},
};

fn client(server: &common::FakeWs) -> Client {
    Server::new(&RuntimeHandle::current(), "http://tempo.test", APP_VERSION)
        .unwrap()
        .with_dialer(server.dialer())
        .client(Token::new(TOKEN))
}
fn target() -> TerminalTarget {
    TerminalTarget {
        workspace_id: "workspace1".into(),
        terminal_id: "t1".into(),
        cols: 80,
        rows: 24,
    }
}
async fn next_resize(conn: &mut common::Conn) -> serde_json::Value {
    match timeout(Duration::from_secs(10), conn.ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        message => panic!("unexpected frame: {message:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn bridges_commands_control_keys_output_and_resizes_then_stops_on_shell_exit() {
    let server = fake_ws(|_| None).await;
    let client = client(&server);
    let (mut keys, input) = duplex(1024);
    let (output, mut screen) = duplex(1024);
    let (resize, resizes) = async_channel::bounded(16);
    let bridge = tokio::spawn(async move {
        client
            .bridge_terminal(
                target(),
                TerminalBridgeIo {
                    input,
                    output,
                    resizes,
                },
                std::future::pending(),
            )
            .await
    });
    let mut conn = server.next().await;
    assert_eq!(
        conn.upgrade.header("authorization"),
        Some(format!("Bearer {TOKEN}").as_str())
    );
    assert_eq!(conn.upgrade.header("origin"), None);
    conn.ws
        .send(Message::text("{\"type\":\"ready\"}"))
        .await
        .unwrap();
    assert_eq!(
        next_resize(&mut conn).await,
        serde_json::json!({"type":"resize","cols":80,"rows":24})
    );
    conn.ws.send(Message::binary(b"$ ".to_vec())).await.unwrap();
    let mut prompt = [0; 2];
    screen.read_exact(&mut prompt).await.unwrap();
    assert_eq!(&prompt, b"$ ");
    for bytes in [b"ls\r".as_slice(), b"\x03", b"\x1b[A"] {
        keys.write_all(bytes).await.unwrap();
        match conn.ws.next().await.unwrap().unwrap() {
            Message::Binary(frame) => assert_eq!(frame.as_ref(), bytes),
            frame => panic!("unexpected input: {frame:?}"),
        }
    }
    resize.send((140, 50)).await.unwrap();
    assert_eq!(
        next_resize(&mut conn).await,
        serde_json::json!({"type":"resize","cols":140,"rows":50})
    );
    resize.send((u16::MAX, 1)).await.unwrap();
    assert_eq!(
        next_resize(&mut conn).await,
        serde_json::json!({"type":"resize","cols":500,"rows":5})
    );
    conn.ws
        .send(Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "shell exited".into(),
        })))
        .await
        .unwrap();
    bridge.await.unwrap().unwrap();
    assert_eq!(server.attempts(), 1);
}

#[tokio::test(start_paused = true)]
async fn drops_keys_before_ready_and_ctrl_bracket_detaches_locally() {
    let server = fake_ws(|_| None).await;
    let client = client(&server);
    let (mut keys, input) = duplex(1024);
    let (output, mut screen) = duplex(1024);
    let (_resize, resizes) = async_channel::bounded(1);
    let bridge = tokio::spawn(async move {
        client
            .bridge_terminal(
                target(),
                TerminalBridgeIo {
                    input,
                    output,
                    resizes,
                },
                std::future::pending(),
            )
            .await
    });
    let mut conn = server.next().await;
    keys.write_all(b"should-not-run\r").await.unwrap();
    assert!(
        timeout(Duration::from_millis(100), conn.ws.next())
            .await
            .is_err()
    );
    conn.ws
        .send(Message::text("{\"type\":\"ready\"}"))
        .await
        .unwrap();
    next_resize(&mut conn).await;
    conn.ws.send(Message::binary(b"$ ".to_vec())).await.unwrap();
    screen.read_exact(&mut [0; 2]).await.unwrap();
    keys.write_all(b"\x1d").await.unwrap();
    bridge.await.unwrap().unwrap();
    assert!(matches!(conn.ws.next().await, Some(Ok(Message::Close(_)))));
}

#[tokio::test(start_paused = true)]
async fn reconnects_with_the_latest_size_and_resets_the_local_screen() {
    let server = fake_ws(|_| None).await;
    let client = client(&server);
    let (mut keys, input) = duplex(1024);
    let (output, mut screen) = duplex(4096);
    let (resize, resizes) = async_channel::bounded(1);
    let bridge = tokio::spawn(async move {
        client
            .bridge_terminal(
                target(),
                TerminalBridgeIo {
                    input,
                    output,
                    resizes,
                },
                std::future::pending(),
            )
            .await
    });
    let mut conn = server.next().await;
    conn.ws
        .send(Message::text("{\"type\":\"ready\"}"))
        .await
        .unwrap();
    next_resize(&mut conn).await;
    resize.send((132, 40)).await.unwrap();
    next_resize(&mut conn).await;
    drop(conn);
    let mut again = server.next().await;
    assert!(again.upgrade.path.ends_with("cols=132&rows=40"));
    again
        .ws
        .send(Message::text("{\"type\":\"ready\"}"))
        .await
        .unwrap();
    next_resize(&mut again).await;
    again
        .ws
        .send(Message::binary(b"RESTORED".to_vec()))
        .await
        .unwrap();
    let mut output = Vec::new();
    while !output.ends_with(b"RESTORED") {
        let mut bytes = [0; 1024];
        let n = screen.read(&mut bytes).await.unwrap();
        assert!(n > 0);
        output.extend_from_slice(&bytes[..n]);
    }
    assert!(output.windows(2).any(|bytes| bytes == b"\x1bc"));
    keys.write_all(b"ls\r").await.unwrap();
    assert!(
        matches!(again.ws.next().await, Some(Ok(Message::Binary(bytes))) if bytes.as_ref() == b"ls\r")
    );
    keys.write_all(b"\x1d").await.unwrap();
    bridge.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn unauthorized_upgrade_is_actionable_and_does_not_expose_credentials() {
    let server = fake_ws(|_| Some(401)).await;
    let client = client(&server);
    let (_keys, input) = duplex(1024);
    let (output, _screen) = duplex(1024);
    let (_resize, resizes) = async_channel::bounded(1);
    let error = client
        .bridge_terminal(
            target(),
            TerminalBridgeIo {
                input,
                output,
                resizes,
            },
            std::future::pending(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        TerminalBridgeError::Closed(CloseReason::Unauthorized)
    ));
    assert!(!error.to_string().contains(TOKEN));
    assert_eq!(server.attempts(), 1);
}

#[tokio::test(start_paused = true)]
async fn local_eof_and_external_stop_close_the_connection() {
    for stop_instead_of_eof in [false, true] {
        let server = fake_ws(|_| None).await;
        let client = client(&server);
        let (mut keys, input) = duplex(1024);
        let (output, _screen) = duplex(1024);
        let (_resize, resizes) = async_channel::bounded(1);
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let bridge = tokio::spawn(async move {
            client
                .bridge_terminal(
                    target(),
                    TerminalBridgeIo {
                        input,
                        output,
                        resizes,
                    },
                    async {
                        let _ = stopped.await;
                    },
                )
                .await
        });
        let mut conn = server.next().await;
        conn.ws
            .send(Message::text("{\"type\":\"ready\"}"))
            .await
            .unwrap();
        next_resize(&mut conn).await;
        if stop_instead_of_eof {
            stop.send(()).unwrap();
        } else {
            keys.shutdown().await.unwrap();
        }
        bridge.await.unwrap().unwrap();
        assert!(matches!(conn.ws.next().await, Some(Ok(Message::Close(_)))));
    }
}
