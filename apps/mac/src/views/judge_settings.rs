//! Settings → TypeSafe AI (13, L-ADR-9): the judge key. It is write-only.

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

const HELP: &str = "Jev judges each new task's risk and each Cloudflare call an agent makes. Without a key, you confirm every intent yourself. Tempo checks the key when you save and never shows it again.";

#[derive(Clone, Copy, Debug, PartialEq)]
struct JudgeSettings {
    key_set: bool,
    updated_at: Option<f64>,
}

impl From<p::GetJudgeSettingsOut> for JudgeSettings {
    fn from(s: p::GetJudgeSettingsOut) -> Self {
        Self {
            key_set: s.key_set,
            updated_at: s.updated_at,
        }
    }
}

impl From<p::SetJudgeKeyOut> for JudgeSettings {
    fn from(s: p::SetJudgeKeyOut) -> Self {
        Self {
            key_set: s.key_set,
            updated_at: s.updated_at,
        }
    }
}

impl From<p::DeleteJudgeKeyOut> for JudgeSettings {
    fn from(s: p::DeleteJudgeKeyOut) -> Self {
        Self {
            key_set: s.key_set,
            updated_at: s.updated_at,
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Action {
    Load,
    Save,
    Remove,
}

pub struct TypeSafeSettings {
    client: Option<Client>,
    settings: Option<JudgeSettings>,
    key: Entity<InputState>,
    pending: bool,
    problem: Option<String>,
    _subscription: Subscription,
}

/// A rejected key shows its detail in place; other errors go to a toast.
fn problem_text(error: &ApiError) -> Option<String> {
    match error {
        ApiError::Server { error: body, .. } if body.code == p::ErrorCode::ValidationFailed => {
            Some(
                body.detail
                    .clone()
                    .unwrap_or_else(|| super::toast::error_text(error, None)),
            )
        }
        _ => None,
    }
}

impl TypeSafeSettings {
    pub fn with_client(
        client: Option<Client>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let key = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder("Paste the key")
        });
        let subscription = cx.observe(&key, |_, _, cx| cx.notify());
        let mut this = Self {
            client,
            settings: None,
            key,
            pending: false,
            problem: None,
            _subscription: subscription,
        };
        if let Some(client) = &this.client {
            let request = client.call::<api::GetJudgeSettings>(p::Empty {});
            this.send(
                Action::Load,
                async move { request.await.map(Into::into) },
                window,
                cx,
            );
        }
        this
    }

    fn send(
        &mut self,
        action: Action,
        request: impl std::future::Future<Output = Result<JudgeSettings, ApiError>> + Send + 'static,
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
                        if action == Action::Save {
                            this.key
                                .update(cx, |input, cx| input.set_value("", window, cx));
                        }
                        let placeholder = if settings.key_set {
                            "Paste a new key to replace it"
                        } else {
                            "Paste the key"
                        };
                        this.key.update(cx, |input, cx| {
                            input.set_placeholder(placeholder, window, cx)
                        });
                        this.settings = Some(settings);
                        match action {
                            Action::Save => {
                                super::toast::success("TypeSafe AI key saved", window, cx)
                            }
                            Action::Remove => {
                                super::toast::success("TypeSafe AI key removed", window, cx)
                            }
                            Action::Load => {}
                        }
                    }
                    Err(error) => match (action, problem_text(&error)) {
                        (Action::Save, Some(text)) => this.problem = Some(text),
                        _ => super::toast::error(&error, None, window, cx),
                    },
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn input(&self, cx: &gpui_kit::App) -> Option<p::SetJudgeKeyIn> {
        let key = self.key.read(cx).value().trim().parse().ok()?;
        Some(p::SetJudgeKeyIn { key })
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(client), Some(input)) = (self.client.clone(), self.input(cx)) else {
            return;
        };
        if self.pending {
            return;
        }
        let request = client.call::<api::SetJudgeKey>(input);
        self.send(
            Action::Save,
            async move { request.await.map(Into::into) },
            window,
            cx,
        );
    }

    fn remove(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.pending {
            return;
        }
        let request = client.call::<api::DeleteJudgeKey>(p::Empty {});
        self.send(
            Action::Remove,
            async move { request.await.map(Into::into) },
            window,
            cx,
        );
    }
}

impl Render for TypeSafeSettings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        let Some(settings) = self.settings else {
            return v_flex();
        };
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
                            .child("TypeSafe AI"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(if settings.key_set {
                                "Key set"
                            } else {
                                "No key"
                            }),
                    ),
            )
            .children(
                settings
                    .updated_at
                    .filter(|at| at.is_finite() && *at >= 0.)
                    .map(|at| {
                        div().text_sm().text_color(muted).child(format!(
                            "Updated {}",
                            super::indicators::format_relative(at, super::indicators::now_ms())
                        ))
                    }),
            )
            .child(div().text_sm().text_color(muted).child(HELP))
            .child(Input::new(&self.key).aria_label("TypeSafe AI key"))
            .children(
                self.problem
                    .clone()
                    .map(|text| div().text_color(color(Token::Destructive, cx)).child(text)),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("save-typesafe")
                            .primary()
                            .label(if self.pending { "Saving…" } else { "Save" })
                            .disabled(self.pending || !ready)
                            .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
                    )
                    .children(settings.key_set.then(|| {
                        Button::new("delete-typesafe")
                            .label("Remove")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, window, cx| this.remove(window, cx)))
                    })),
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

    const DETAIL: &str = "TypeSafe AI did not accept the key.";

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
                        .unwrap_or(0);
                    while bytes.len() < head_end + length {
                        let mut chunk = [0; 4096];
                        let count = stream.read(&mut chunk).unwrap();
                        assert!(count > 0, "RPC closed without request body");
                        bytes.extend_from_slice(&chunk[..count]);
                    }
                    let input: Value = serde_json::from_slice(&bytes[head_end..head_end + length])
                        .unwrap_or(Value::Null);
                    let name = path
                        .split('?')
                        .next()
                        .unwrap()
                        .rsplit('/')
                        .next()
                        .unwrap()
                        .to_string();
                    log.lock().unwrap().push((name.clone(), input.clone()));
                    let (status, result) = match name.as_str() {
                        "getJudgeSettings" => (200, json!({"keySet":false,"updatedAt":null})),
                        "setJudgeKey" => {
                            saves += 1;
                            if saves == 1 {
                                (
                                    400,
                                    json!({"code":"VALIDATION_FAILED","message":"Invalid input.","detail":DETAIL}),
                                )
                            } else {
                                (200, json!({"keySet":true,"updatedAt":5}))
                            }
                        }
                        "deleteJudgeKey" => (200, json!({"keySet":false,"updatedAt":6})),
                        _ => panic!("unexpected TypeSafe settings RPC: {name}"),
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
        view: &Entity<TypeSafeSettings>,
        done: impl Fn(&TypeSafeSettings, &gpui_kit::App) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if view.read_with(cx, |view, cx| done(view, cx)) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "TypeSafe settings RPC did not finish"
            );
            std::thread::yield_now();
        }
    }

    #[gpui_kit::test]
    fn rejected_key_shows_detail_in_place_then_save_and_remove_update_the_badge(
        cx: &mut TestAppContext,
    ) {
        let server = Server::new();
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("native-test-token"));
        cx.background_executor.allow_parking();
        let (window, view): (AnyWindowHandle, Entity<TypeSafeSettings>) = cx.update(|cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| TypeSafeSettings::with_client(Some(client), window, cx))
            })
            .unwrap()
        });
        wait(cx, &view, |view, _| view.settings.is_some());
        view.read_with(cx, |view, cx| {
            assert!(!view.settings.unwrap().key_set);
            assert!(view.input(cx).is_none(), "an empty key cannot be saved");
        });
        let save = |cx: &mut TestAppContext, key: &str| {
            cx.update_window(window, |_, window, cx| {
                view.update(cx, |view, cx| {
                    view.key
                        .update(cx, |input, cx| input.set_value(key, window, cx));
                    view.save(window, cx);
                })
            })
            .unwrap();
            wait(cx, &view, |view, _| !view.pending);
        };
        save(cx, "bad-key");
        view.read_with(cx, |view, cx| {
            assert_eq!(view.problem.as_deref(), Some(DETAIL));
            assert_eq!(view.key.read(cx).value(), "bad-key");
            assert!(!view.settings.unwrap().key_set);
        });
        save(cx, " good-key ");
        view.read_with(cx, |view, cx| {
            assert!(view.problem.is_none());
            assert_eq!(
                view.settings,
                Some(JudgeSettings {
                    key_set: true,
                    updated_at: Some(5.)
                })
            );
            assert_eq!(view.key.read(cx).value(), "");
        });
        assert_eq!(
            server.calls("setJudgeKey"),
            vec![json!({"key":"bad-key"}), json!({"key":"good-key"})]
        );
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.remove(window, cx))
        })
        .unwrap();
        wait(cx, &view, |view, _| !view.pending);
        view.read_with(cx, |view, _| {
            assert!(!view.settings.unwrap().key_set);
        });
        assert_eq!(server.calls("deleteJudgeKey"), vec![json!({})]);
    }
}
