//! 07 Testing, Client row: the hub, workspace and terminal channels against a fake server:
//! headers, backoff, ping and pong, close codes, sinceRev, 401, backpressure, wake.
//!
//! Timing tests run on tokio's paused clock over the fake server's in-memory dialer: with real
//! sockets the paused clock jumps to the next timer whenever the runtime waits on the OS. The
//! upgrade-header test runs over real TCP on the normal clock.

mod common;

use std::time::Duration;

use common::{APP_VERSION, Conn, FakeWs, TOKEN, fake_ws};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tempo_client::{
    CHANNEL_CAPACITY, ChannelEvent, Client, CloseReason, HubChannelEvent, PING_EVERY, PONG_TIMEOUT,
    RuntimeHandle, Server, Signal, Status, TerminalFrame, Token,
};
use tempo_protocol::{HubServerMessage, WorkspaceServerMessage};
use tokio::time::{Instant, sleep, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// A client whose channels reach `server` through in-memory pipes.
fn client(rt: &RuntimeHandle, server: &FakeWs) -> Client {
    Server::new(rt, "http://tempo.test", APP_VERSION)
        .expect("server")
        .with_dialer(server.dialer())
        .client(Token::new(TOKEN))
}

fn hub_hello() -> String {
    json!({"type": "hello", "v": 1, "workspaces": []}).to_string()
}

async fn recv<M: std::fmt::Debug>(
    rx: &async_channel::Receiver<ChannelEvent<M>>,
) -> ChannelEvent<M> {
    timeout(Duration::from_secs(3600), rx.recv())
        .await
        .expect("an event within an hour")
        .expect("channel open")
}

async fn expect_status<M: std::fmt::Debug>(
    rx: &async_channel::Receiver<ChannelEvent<M>>,
    want: fn(&Status) -> bool,
) -> Status {
    match recv(rx).await {
        ChannelEvent::Status(s) if want(&s) => s,
        other => panic!("unexpected {other:?}"),
    }
}

async fn send_text(conn: &mut Conn, text: String) {
    conn.ws
        .send(Message::text(text))
        .await
        .expect("server sends");
}

async fn close_with(conn: &mut Conn, code: u16) {
    let frame = CloseFrame {
        code: CloseCode::from(code),
        reason: "bye".into(),
    };
    let _ = conn.ws.close(Some(frame)).await;
}

/// Reads frames until a text frame arrives (answering nothing).
async fn next_text(conn: &mut Conn) -> Option<String> {
    while let Some(frame) = conn.ws.next().await {
        match frame {
            Ok(Message::Text(t)) => return Some(t.to_string()),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
    None
}

#[tokio::test]
async fn upgrades_carry_bearer_and_client_header_and_no_origin() {
    let server = fake_ws(|_| None).await;
    let rt = RuntimeHandle::current();
    let c = Server::new(&rt, &server.base, APP_VERSION)
        .expect("server")
        .client(Token::new(TOKEN));

    let (hub_rx, _hub) = c.open_hub();
    let mut conn = server.next().await;
    assert_eq!(conn.upgrade.path, "/api/ws/hub");
    assert_eq!(
        conn.upgrade.header("authorization"),
        Some("Bearer test-session-token")
    );
    assert_eq!(conn.upgrade.header("x-tempo-client"), Some("mac/0.2.0"));
    assert_eq!(conn.upgrade.header("origin"), None);
    assert_eq!(conn.upgrade.header("cookie"), None);
    expect_status(&hub_rx, |s| *s == Status::Connecting).await;
    expect_status(&hub_rx, |s| *s == Status::Open).await;
    send_text(&mut conn, "not json".into()).await;
    send_text(&mut conn, json!({"type": "nope"}).to_string()).await;
    send_text(&mut conn, hub_hello()).await;
    match recv(&hub_rx).await {
        ChannelEvent::Message(HubServerMessage::HubHello(h)) => assert!(h.workspaces.is_empty()),
        other => panic!("undecodable messages are dropped, got {other:?}"),
    }

    let (_ws_rx, _ws) = c.open_workspace("01k7000000000000000000000b", 41);
    let conn = server.next().await;
    assert_eq!(
        conn.upgrade.path,
        "/api/ws/workspace/01k7000000000000000000000b?sinceRev=41"
    );
    assert_eq!(
        conn.upgrade.header("authorization"),
        Some("Bearer test-session-token")
    );
    assert_eq!(conn.upgrade.header("origin"), None);

    let (_t_rx, _t) = c
        .open_terminal("01k7000000000000000000000b", "t3", 120, 40)
        .expect("valid id");
    let conn = server.next().await;
    assert_eq!(
        conn.upgrade.path,
        "/api/ws/terminal/01k7000000000000000000000b/t3?cols=120&rows=40"
    );
    assert_eq!(conn.upgrade.header("x-tempo-client"), Some("mac/0.2.0"));
    for bad in ["t0", "t10", "T1", "", "t"] {
        assert!(c.open_terminal("w", bad, 80, 24).is_err(), "{bad}");
    }
}

#[tokio::test(start_paused = true)]
async fn reconnects_after_half_a_second_doubling_to_ten_with_jitter() {
    let server = fake_ws(|i| (i < 8).then_some(503)).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, _hub) = c.open_hub();
    expect_status(&rx, |s| *s == Status::Connecting).await;
    let down = expect_status(&rx, |s| matches!(s, Status::Down { .. })).await;
    let mut conn = server.next().await;
    expect_status(&rx, |s| *s == Status::Open).await;

    let times = server.attempt_times();
    assert_eq!(times.len(), 9);
    let base_ms = [
        500.0, 1000.0, 2000.0, 4000.0, 8000.0, 10_000.0, 10_000.0, 10_000.0,
    ];
    for (i, w) in times.windows(2).enumerate() {
        let gap = (w[1] - w[0]).as_millis() as f64;
        let b = base_ms[i];
        assert!(
            gap >= b * 0.8 && gap <= b * 1.2,
            "gap {i}: {gap} ms, base {b}"
        );
    }
    let Status::Down { since } = down else {
        unreachable!()
    };
    assert!(since <= times[0].into_std(), "down since the first attempt");

    send_text(&mut conn, hub_hello()).await;
    recv(&rx).await;
    drop(conn);
    expect_status(&rx, |s| matches!(s, Status::Down { .. })).await;
    let again = server.next().await;
    let gap = (again.upgrade.at - *times.last().expect("times")).as_millis();
    assert!(gap > 0);
    let after_message = (again.upgrade.at - server.attempt_times()[8]).as_millis() as f64;
    assert!(
        (400.0..=600.0).contains(&after_message),
        "a message resets the backoff: {after_message} ms"
    );
}

#[tokio::test(start_paused = true)]
async fn pings_every_thirty_seconds_and_reconnects_without_a_pong() {
    let server = fake_ws(|_| None).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, _hub) = c.open_hub();
    let mut conn = server.next().await;
    let opened = Instant::now();
    send_text(&mut conn, hub_hello()).await;

    let ping = next_text(&mut conn).await.expect("ping");
    assert_eq!(ping, r#"{"type":"ping"}"#);
    assert_eq!(opened.elapsed(), PING_EVERY);
    send_text(&mut conn, json!({"type": "pong"}).to_string()).await;

    let ping = next_text(&mut conn).await.expect("second ping");
    assert_eq!(ping, r#"{"type":"ping"}"#);
    assert_eq!(opened.elapsed(), PING_EVERY * 2);
    let silent_since = Instant::now();

    let next = server.next().await;
    let waited = next.upgrade.at - silent_since;
    assert!(
        waited >= PONG_TIMEOUT + Duration::from_millis(400)
            && waited <= PONG_TIMEOUT + Duration::from_millis(600),
        "{waited:?}"
    );
    let mut saw_down = false;
    while let Ok(ev) = rx.try_recv() {
        saw_down |= matches!(ev, ChannelEvent::Status(Status::Down { .. }));
    }
    assert!(saw_down);
}

#[tokio::test(start_paused = true)]
async fn close_4001_4400_and_4404_stop_without_reconnecting() {
    let cases = [
        (4001, CloseReason::Replaced),
        (4400, CloseReason::UpdateRequired),
        (4404, CloseReason::NotFound),
    ];
    for (code, reason) in cases {
        let server = fake_ws(|_| None).await;
        let rt = RuntimeHandle::current();
        let signals = rt.signals();
        let c = client(&rt, &server);
        let (rx, _ws) = c.open_workspace("01k7000000000000000000000b", 0);
        let mut conn = server.next().await;
        close_with(&mut conn, code).await;
        let mut last = None;
        while let Ok(ev) = rx.recv().await {
            last = Some(ev);
        }
        assert_eq!(
            last,
            Some(ChannelEvent::Status(Status::Closed(reason))),
            "{code}"
        );
        sleep(Duration::from_secs(120)).await;
        assert_eq!(server.attempts(), 1, "{code}: no reconnect");
        let signal = signals.try_recv().ok();
        let want = (code == 4400).then_some(Signal::UpdateRequired);
        assert_eq!(signal, want, "{code}");
    }
}

#[tokio::test(start_paused = true)]
async fn close_4008_reconnects_with_the_latest_since_rev() {
    let server = fake_ws(|_| None).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, ws) = c.open_workspace("01k7000000000000000000000b", 12);
    let mut conn = server.next().await;
    assert!(conn.upgrade.path.ends_with("?sinceRev=12"));
    ws.set_since_rev(77);
    close_with(&mut conn, 4008).await;
    let again = server.next().await;
    assert!(
        again.upgrade.path.ends_with("?sinceRev=77"),
        "{}",
        again.upgrade.path
    );
    let statuses: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(statuses.contains(&ChannelEvent::Status(Status::Open)));
    assert!(
        statuses
            .iter()
            .any(|e| matches!(e, ChannelEvent::Status(Status::Down { .. })))
    );
}

#[tokio::test(start_paused = true)]
async fn a_401_upgrade_stops_every_channel_of_the_client() {
    let server = fake_ws(|i| (i >= 1).then_some(401)).await;
    let rt = RuntimeHandle::current();
    let signals = rt.signals();
    let c = client(&rt, &server);
    let (hub_rx, _hub) = c.open_hub();
    let mut conn = server.next().await;
    expect_status(&hub_rx, |s| *s == Status::Connecting).await;
    expect_status(&hub_rx, |s| *s == Status::Open).await;
    send_text(&mut conn, hub_hello()).await;
    recv(&hub_rx).await;

    let (ws_rx, _ws) = c.open_workspace("01k7000000000000000000000b", 0);
    expect_status(&ws_rx, |s| *s == Status::Connecting).await;
    expect_status(&ws_rx, |s| *s == Status::Closed(CloseReason::Unauthorized)).await;
    expect_status(&hub_rx, |s| *s == Status::Closed(CloseReason::Unauthorized)).await;
    assert!(c.is_unauthorized());
    assert_eq!(signals.try_recv(), Ok(Signal::Unauthorized));
    assert!(
        next_text(&mut conn).await.is_none(),
        "the hub socket was closed"
    );
    sleep(Duration::from_secs(60)).await;
    assert_eq!(server.attempts(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_full_receiver_pauses_reading_and_loses_nothing() {
    const SENT: usize = 20_000;
    let server = fake_ws(|_| None).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, _hub) = c.open_hub();
    let mut conn = server.next().await;
    let feeder = tokio::spawn(async move {
        for i in 0..SENT {
            let msg = json!({"type": "workspace.removed", "workspaceId": format!("w{i}")});
            conn.ws
                .send(Message::text(msg.to_string()))
                .await
                .expect("send");
        }
        conn
    });
    sleep(Duration::from_secs(90)).await;
    assert_eq!(rx.len(), CHANNEL_CAPACITY, "the receiver is full");
    assert!(
        !feeder.is_finished(),
        "the socket is not read while the receiver is full"
    );
    assert_eq!(
        server.attempts(),
        1,
        "no ping timeout while the store is behind"
    );

    let mut ids = Vec::with_capacity(SENT);
    while ids.len() < SENT {
        if let ChannelEvent::Message(HubServerMessage::HubWorkspaceRemoved(m)) = recv(&rx).await {
            ids.push(m.workspace_id);
        }
    }
    let want: Vec<String> = (0..SENT).map(|i| format!("w{i}")).collect();
    assert_eq!(ids, want, "every message, in order");
    let _conn = feeder.await.expect("feeder");
}

#[tokio::test(start_paused = true)]
async fn reconnect_all_skips_the_backoff_and_replaces_open_sockets() {
    let server = fake_ws(|i| (1..=5).contains(&i).then_some(503)).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, _hub) = c.open_hub();
    let mut conn = server.next().await;
    send_text(&mut conn, hub_hello()).await;
    drop(conn);
    while server.attempts() < 6 {
        tokio::task::yield_now().await;
        sleep(Duration::from_millis(1)).await;
    }
    let before = Instant::now();
    rt.reconnect_all();
    let mut conn = server.next().await;
    assert!(
        conn.upgrade.at - before < Duration::from_millis(5),
        "at once, not after 10 s"
    );

    rt.reconnect_all();
    assert!(
        next_text(&mut conn).await.is_none(),
        "the open socket is closed"
    );
    let again = server.next().await;
    assert!(again.upgrade.at - before < Duration::from_millis(5));
    drop(rx);
}

#[tokio::test(start_paused = true)]
async fn dropping_the_handle_closes_the_socket() {
    let server = fake_ws(|_| None).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, hub) = c.open_hub();
    let mut conn = server.next().await;
    drop(hub);
    match conn.ws.next().await {
        Some(Ok(Message::Close(Some(f)))) => assert_eq!(f.code, CloseCode::Normal),
        other => panic!("expected a close frame, got {other:?}"),
    }
    let rest: Vec<HubChannelEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(
        rest.iter()
            .all(|e| !matches!(e, ChannelEvent::Status(Status::Down { .. })))
    );
    sleep(Duration::from_secs(60)).await;
    assert_eq!(server.attempts(), 1);
}

#[tokio::test(start_paused = true)]
async fn close_channels_stops_them_with_stopped() {
    let server = fake_ws(|_| None).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, _ws) = c.open_workspace("01k7000000000000000000000b", 0);
    let _conn = server.next().await;
    expect_status(&rx, |s| *s == Status::Connecting).await;
    expect_status(&rx, |s| *s == Status::Open).await;
    c.close_channels();
    expect_status(&rx, |s| *s == Status::Closed(CloseReason::Stopped)).await;
    assert!(!c.is_unauthorized());
}

#[tokio::test(start_paused = true)]
async fn terminal_frames_follow_01() {
    let server = fake_ws(|_| None).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, term) = c
        .open_terminal("01k7000000000000000000000b", "t1", 80, 24)
        .expect("valid id");
    let mut conn = server.next().await;
    send_text(&mut conn, json!({"type": "ready"}).to_string()).await;
    conn.ws
        .send(Message::binary(b"\x1b[1mhi".to_vec()))
        .await
        .expect("send");
    let mut frames = Vec::new();
    while frames.len() < 2 {
        if let ChannelEvent::Message(f) = recv(&rx).await {
            frames.push(f);
        }
    }
    assert_eq!(
        frames,
        [
            TerminalFrame::Ready,
            TerminalFrame::Output(b"\x1b[1mhi".to_vec())
        ]
    );

    assert!(term.send_keys(b"ls\r".to_vec()));
    assert!(term.resize(132, 50));
    match conn.ws.next().await {
        Some(Ok(Message::Binary(b))) => assert_eq!(&b[..], b"ls\r"),
        other => panic!("{other:?}"),
    }
    let resize = next_text(&mut conn).await.expect("resize");
    let resize: serde_json::Value = serde_json::from_str(&resize).expect("json");
    assert_eq!(resize, json!({"type": "resize", "cols": 132, "rows": 50}));

    let quiet = timeout(PING_EVERY * 3, conn.ws.next()).await;
    assert!(quiet.is_err(), "the terminal channel sends no ping");
    drop(conn);
    let again = server.next().await;
    assert!(
        again.upgrade.path.ends_with("/t1?cols=132&rows=50"),
        "{}",
        again.upgrade.path
    );
}

#[tokio::test(start_paused = true)]
async fn workspace_messages_reach_the_store_in_order() {
    let server = fake_ws(|_| None).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server);
    let (rx, ws) = c.open_workspace("01k7000000000000000000000b", 0);
    let mut conn = server.next().await;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/channel/workspace-first-load.jsonl");
    let lines: Vec<String> = std::fs::read_to_string(path)
        .expect("fixture")
        .lines()
        .map(str::to_owned)
        .collect();
    for l in &lines {
        send_text(&mut conn, l.clone()).await;
    }
    let mut store = tempo_client::state::WorkspaceState::new();
    let mut n = 0;
    while n < lines.len() {
        if let ChannelEvent::Message(m) = recv(&rx).await {
            let _: &WorkspaceServerMessage = &m;
            store.apply(m);
            ws.set_since_rev(store.since_rev());
            n += 1;
        }
    }
    assert!(store.backlog_done);
    assert_eq!(ws.since_rev(), store.since_rev());
}
