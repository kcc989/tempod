//! Tempo for Mac (07, Architecture): start the client runtime, then GPUI: init, menus, key
//! bindings, main window.
use tempo_mac::{app, client::ClientRuntime, image_policy, keymap, menus, views};

fn main() {
    let runtime = ClientRuntime::start();
    let (url_tx, url_rx) = async_channel::unbounded::<Vec<String>>();

    let application = gpui_kit::application().with_http_client(image_policy::blocked_http_client());
    application.on_open_urls(move |urls| {
        let _ = url_tx.try_send(urls);
    });
    application.run(move |cx| {
        gpui_kit::init(cx);
        app::init(runtime, url_rx, cx);
        keymap::bind(cx);
        menus::set(cx);
        if let Err(err) = views::main_window::open(Default::default(), cx) {
            eprintln!("Tempo could not open its window: {err}");
            cx.quit();
            return;
        }
        cx.activate(true);
    });
}
