//! Tempo for Mac (07, Architecture): start logging and load local storage, start the client
//! runtime, then GPUI: init, menus, key bindings, main window.
use serde_json::json;
use tempo_mac::{
    app, client::ClientRuntime, image_policy, keymap, logging, menus, platform, storage,
};

fn main() {
    if std::env::args().any(|arg| arg == "--check-workspace") {
        check_workspace();
        return;
    }
    if let Some(dir) = logging::default_dir()
        && let Err(err) = logging::init(&dir)
    {
        eprintln!("Tempo could not open its log: {}", err.kind());
    }
    logging::info("app", "starting", json!({"version": tempo_mac::VERSION}));
    let local = storage::Local::load(storage::support_dir());
    let runtime = match ClientRuntime::start() {
        Ok(runtime) => runtime,
        Err(err) => {
            logging::error(
                "app",
                "I/O runtime did not start",
                json!({"kind": format!("{:?}", err.kind())}),
            );
            eprintln!("Tempo could not start its network runtime: {}", err.kind());
            return;
        }
    };
    let (url_tx, url_rx) = async_channel::unbounded::<Vec<String>>();

    let clicks = url_tx.clone();
    platform::on_notification_click(move |workspace_id| {
        let _ = clicks.try_send(vec![format!("tempo://workspace/{workspace_id}")]);
    });
    let handle = runtime.handle();
    platform::observe_wake(move || {
        handle.reconnect_all();
        logging::info("app", "woke from sleep", json!({}));
    });

    let application = gpui_kit::application()
        .with_assets(gpui_kit::assets::AllAssets)
        .with_http_client(image_policy::blocked_http_client());
    application.on_open_urls(move |urls| {
        let _ = url_tx.try_send(urls);
    });
    application.on_reopen(|cx| {
        let _ = app::ensure_main_window(cx);
    });
    application.run(move |cx| {
        gpui_kit::init(cx);
        cx.set_global(local);
        cx.on_app_quit(|cx| {
            let state = cx.global::<storage::Local>().flush();
            let logs = logging::flush();
            async move {
                let _ = state.recv().await;
                let _ = logs.recv().await;
            }
        })
        .detach();
        app::init(runtime, url_rx, cx);
        keymap::bind(cx);
        menus::set(cx);
        if let Err(err) = app::ensure_main_window(cx) {
            logging::error("app", "main window did not open", json!({}));
            eprintln!("Tempo could not open its window: {err}");
            cx.quit();
            return;
        }
        cx.activate(true);
    });
}

fn check_workspace() {
    let local = storage::Local::load(storage::support_dir());
    let (Some(url), Some(id)) = (
        local.config().url.clone(),
        local.state().last_workspace.clone(),
    ) else {
        println!("No saved workspace connection.");
        return;
    };
    let runtime = ClientRuntime::start().unwrap();
    let server = tempo_client::Server::new(&runtime.handle(), &url, tempo_mac::VERSION).unwrap();
    let Some(token) = platform::token_store().get(server.host()) else {
        println!("No saved session accessible.");
        return;
    };
    let client = server.client(tempo_client::Token::new(token));
    let (events, _channel) = client.open_workspace(&id, 0);
    let (send, receive) = std::sync::mpsc::channel();
    runtime.handle().tokio().spawn(async move {
        while let Ok(event) = events.recv().await {
            let result = match event {
                tempo_client::ChannelEvent::Message(
                    tempo_protocol::WorkspaceServerMessage::Hello(_),
                ) => Some("Workspace hello decoded.".to_string()),
                tempo_client::ChannelEvent::DecodeError(issue) => Some(issue),
                tempo_client::ChannelEvent::Status(tempo_client::Status::Closed(reason)) => {
                    Some(format!("Workspace channel closed: {reason:?}"))
                }
                _ => None,
            };
            if let Some(result) = result {
                let _ = send.send(result);
                break;
            }
        }
    });
    match receive.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(result) => println!("{result}"),
        Err(_) => println!("No workspace hello within 15 seconds."),
    }
}
