//! Settings → Cloudflare (12, Owner settings and Clients): the deploy account ID and a write-only
//! master token.

use super::deploy_model as model;
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    Subscription, Window, div,
};
use tempo_client::{ApiError, Client};
use tempo_protocol::{self as p, api};

pub struct CloudflareSettings {
    client: Option<Client>,
    settings: Option<p::DeploySettings>,
    account: Entity<InputState>,
    token: Entity<InputState>,
    pending: bool,
    problem: Option<String>,
    _subscriptions: [Subscription; 2],
}

impl CloudflareSettings {
    pub fn with_client(
        client: Option<Client>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let account = cx.new(|cx| InputState::new(window, cx).placeholder("Account ID"));
        let token = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder("Paste an API token")
        });
        let subscriptions = [
            cx.observe(&account, |_, _, cx| cx.notify()),
            cx.observe(&token, |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            client,
            settings: None,
            account,
            token,
            pending: false,
            problem: None,
            _subscriptions: subscriptions,
        };
        if let Some(client) = &this.client {
            let request = client.call::<api::GetDeploySettings>(p::Empty {});
            this.send(request, window, cx);
        }
        this
    }

    fn send(
        &mut self,
        request: impl std::future::Future<Output = Result<p::DeploySettings, ApiError>> + Send + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending = true;
        self.problem = None;
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(settings) => {
                        let account = settings.account_id.clone().unwrap_or_default();
                        this.account
                            .update(cx, |input, cx| input.set_value(account, window, cx));
                        this.token
                            .update(cx, |input, cx| input.set_value("", window, cx));
                        this.settings = Some(settings);
                    }
                    Err(error) => this.problem = Some(super::toast::error_text(&error, None)),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn input(&self, cx: &Context<Self>) -> Option<p::UpdateDeploySettingsIn> {
        model::settings_input(&self.account.read(cx).value(), &self.token.read(cx).value())
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(client), Some(input)) = (self.client.clone(), self.input(cx)) else {
            return;
        };
        if self.pending {
            return;
        }
        let request = client.call::<api::UpdateDeploySettings>(input);
        self.send(request, window, cx);
    }

    fn remove(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.pending {
            return;
        }
        let request = client.call::<api::DeleteDeploySettings>(p::Empty {});
        self.send(request, window, cx);
    }
}

impl Render for CloudflareSettings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        let set = self.settings.as_ref().is_some_and(|s| s.token_set);
        let updated = self.settings.as_ref().and_then(|s| s.updated_at);
        let ready = self.input(cx).is_some();
        v_flex()
            .p_3()
            .gap_2()
            .border_1()
            .border_color(color(Token::Border, cx))
            .rounded_md()
            .bg(color(Token::Panel, cx))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child("Cloudflare"),
                    )
                    .child(div().text_xs().text_color(muted).child(if set {
                        "Token set"
                    } else {
                        "Token not set"
                    })),
            )
            .children(updated.filter(|at| at.is_finite() && *at >= 0.).map(|at| {
                div().text_sm().text_color(muted).child(format!(
                    "Last updated {}",
                    super::indicators::format_relative(at, super::indicators::now_ms())
                ))
            }))
            .child(div().text_sm().text_color(muted).child(
                "App deploys use this account. The token must be able to create account API tokens and hold every permission your deploy configurations declare. It never enters a container.",
            ))
            .child(Input::new(&self.account).aria_label("Cloudflare account ID"))
            .child(Input::new(&self.token).aria_label("Cloudflare API token"))
            .children(
                self.problem
                    .clone()
                    .map(|text| div().text_color(color(Token::Destructive, cx)).child(text)),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("save-cloudflare")
                            .primary()
                            .label(if set { "Replace" } else { "Save" })
                            .disabled(self.pending || !ready)
                            .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
                    )
                    .child(
                        Button::new("delete-cloudflare")
                            .label("Remove")
                            .disabled(self.pending || !set)
                            .on_click(cx.listener(|this, _, window, cx| this.remove(window, cx))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AnyWindowHandle, TestAppContext};
    use serde_json::{Value, json};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};

    const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

    struct Server {
        url: String,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl Server {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let log = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let worker = std::thread::spawn(move || {
                let mut saves = 0;
                while !stopping.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::yield_now();
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut bytes = vec![];
                    let head_end = loop {
                        let mut chunk = [0; 4096];
                        let count = stream.read(&mut chunk).unwrap();
                        assert!(count > 0, "RPC closed without request headers");
                        bytes.extend_from_slice(&chunk[..count]);
                        if let Some(i) = bytes.windows(4).position(|c| c == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let header = String::from_utf8_lossy(&bytes[..head_end]);
                    let path = header.split_whitespace().nth(1).unwrap().to_string();
                    let length = header
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                        .unwrap();
                    while bytes.len() < head_end + length {
                        let mut chunk = [0; 4096];
                        let count = stream.read(&mut chunk).unwrap();
                        assert!(count > 0, "RPC closed without request body");
                        bytes.extend_from_slice(&chunk[..count]);
                    }
                    let input: Value =
                        serde_json::from_slice(&bytes[head_end..head_end + length]).unwrap();
                    let name = path.rsplit('/').next().unwrap().to_string();
                    log.lock().unwrap().push((name.clone(), input.clone()));
                    let (status, result) = match name.as_str() {
                        "getDeploySettings" => (
                            200,
                            json!({"accountId":ACCOUNT,"tokenSet":false,"updatedAt":null}),
                        ),
                        "updateDeploySettings" => {
                            saves += 1;
                            if saves == 1 {
                                (
                                    400,
                                    json!({"code":"DEPLOY_TOKEN_INVALID","message":"Cloudflare did not accept the deploy token."}),
                                )
                            } else {
                                (
                                    200,
                                    json!({"accountId":input["accountId"],"tokenSet":true,"updatedAt":5}),
                                )
                            }
                        }
                        "deleteDeploySettings" => (
                            200,
                            json!({"accountId":null,"tokenSet":false,"updatedAt":6}),
                        ),
                        _ => panic!("unexpected Cloudflare settings RPC: {name}"),
                    };
                    let body = serde_json::to_vec(&result).unwrap();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(&body);
                }
            });
            Self {
                url,
                requests,
                stop,
                worker: Some(worker),
            }
        }

        fn calls(&self, name: &str) -> Vec<Value> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(call, _)| call == name)
                .map(|(_, input)| input.clone())
                .collect()
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    fn wait(
        cx: &mut TestAppContext,
        view: &Entity<CloudflareSettings>,
        done: impl Fn(&CloudflareSettings, &gpui_kit::App) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if view.read_with(cx, |view, cx| done(view, cx)) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "Cloudflare settings RPC did not finish"
            );
            std::thread::yield_now();
        }
    }

    #[gpui_kit::test]
    fn token_is_write_only_rejection_shows_in_place_and_remove_clears(cx: &mut TestAppContext) {
        let server = Server::new();
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("native-test-token"));
        cx.background_executor.allow_parking();
        let (window, view): (AnyWindowHandle, Entity<CloudflareSettings>) = cx.update(|cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| CloudflareSettings::with_client(Some(client), window, cx))
            })
            .unwrap()
        });
        wait(cx, &view, |view, cx| {
            view.settings.is_some() && view.account.read(cx).value() == ACCOUNT
        });
        let save = |cx: &mut TestAppContext, token: &str| {
            cx.update_window(window, |_, window, cx| {
                view.update(cx, |view, cx| {
                    view.token
                        .update(cx, |input, cx| input.set_value(token, window, cx));
                    view.save(window, cx);
                })
            })
            .unwrap();
            wait(cx, &view, |view, _| !view.pending);
        };
        save(cx, "bad-token");
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.problem.as_deref(),
                Some("Cloudflare did not accept the deploy token.")
            );
            assert_eq!(view.token.read(cx).value(), "bad-token");
            assert!(!view.settings.as_ref().unwrap().token_set);
        });
        save(cx, " good-token ");
        view.read_with(cx, |view, cx| {
            assert!(view.problem.is_none());
            assert!(view.settings.as_ref().unwrap().token_set);
            assert_eq!(view.token.read(cx).value(), "");
        });
        assert_eq!(
            server.calls("updateDeploySettings")[1],
            json!({"accountId":ACCOUNT,"token":"good-token"})
        );
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.remove(window, cx))
        })
        .unwrap();
        wait(cx, &view, |view, _| !view.pending);
        view.read_with(cx, |view, cx| {
            assert!(!view.settings.as_ref().unwrap().token_set);
            assert_eq!(view.account.read(cx).value(), "");
        });
        assert_eq!(server.calls("deleteDeploySettings"), vec![json!({})]);
    }
}
