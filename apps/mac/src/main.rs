//! Tempo for Mac (07, Architecture): start logging and load local storage, start the client
//! runtime, then GPUI: init, menus, key bindings, main window.
use serde_json::json;
use tempo_mac::{
    app, client::ClientRuntime, image_policy, keymap, logging, menus, platform, storage, views,
};

fn main() {
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

    let application = gpui_kit::application().with_http_client(image_policy::blocked_http_client());
    application.on_open_urls(move |urls| {
        let _ = url_tx.try_send(urls);
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
        if let Err(err) = views::main_window::open(Default::default(), cx) {
            logging::error("app", "main window did not open", json!({}));
            eprintln!("Tempo could not open its window: {err}");
            cx.quit();
            return;
        }
        cx.activate(true);
    });
}
