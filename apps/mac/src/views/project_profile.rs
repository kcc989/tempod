//! Project settings → Agents: the project profile every agent session gets (13, L-ADR-3).

use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    Subscription, Window, div,
};
use tempo_client::{ApiError, Client};
use tempo_protocol::{self as p, api};

const PLACEHOLDER: &str = "version: 1\nstack:\n  runtime: bun 1.3\n  frameworks: [TanStack Start, Effect v4]\nchecks:\n  - name: typecheck\n    command: bun run typecheck\nscreens:\n  - route: /\n    files: ['src/routes/index.tsx']";

const HELP: &str = "The stack, services, checks and screens that every chat gets, so you never restate them. Name credentials, never paste their values.";

#[derive(Clone, Debug, PartialEq)]
struct Problem {
    text: String,
    stale: bool,
}

/// A rejected profile shows in place; a stale revision offers Reload. Other errors go to a toast.
fn problem(error: &ApiError) -> Option<Problem> {
    let ApiError::Server { error: body, .. } = error else {
        return None;
    };
    match body.code {
        p::ErrorCode::ProfileInvalid => Some(Problem {
            text: body
                .detail
                .clone()
                .unwrap_or_else(|| super::toast::error_text(error, None)),
            stale: false,
        }),
        p::ErrorCode::ProfileChanged => Some(Problem {
            text: super::toast::error_text(error, None),
            stale: true,
        }),
        _ => None,
    }
}

pub struct ProjectProfileEditor {
    client: Option<Client>,
    project_id: String,
    profile: Option<p::ProjectProfile>,
    source: Entity<TextareaState>,
    pending: bool,
    problem: Option<Problem>,
    _subscription: Subscription,
}

impl ProjectProfileEditor {
    pub fn with_client(
        client: Option<Client>,
        project_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let source = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(12, 30)
                .placeholder(PLACEHOLDER)
        });
        let subscription = cx.observe(&source, |_, _, cx| cx.notify());
        let mut this = Self {
            client,
            project_id,
            profile: None,
            source,
            pending: false,
            problem: None,
            _subscription: subscription,
        };
        this.load(window, cx);
        this
    }

    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        let request = client.call::<api::GetProjectProfile>(p::GetProjectProfileIn {
            project_id: self.project_id.clone(),
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(profile) => this.show(profile, window, cx),
                    Err(error) => super::toast::error(&error, None, window, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn show(&mut self, profile: p::ProjectProfile, window: &mut Window, cx: &mut Context<Self>) {
        let source = profile.source.clone();
        self.source
            .update(cx, |input, cx| input.set_value(source, window, cx));
        self.profile = Some(profile);
        self.problem = None;
    }

    fn dirty(&self, cx: &gpui_kit::App) -> bool {
        self.profile
            .as_ref()
            .is_some_and(|profile| self.source.read(cx).value().as_ref() != profile.source)
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(client), Some(profile)) = (&self.client, &self.profile) else {
            return;
        };
        if self.pending || !self.dirty(cx) {
            return;
        }
        let request = client.call::<api::UpdateProjectProfile>(p::UpdateProjectProfileIn {
            project_id: profile.project_id.clone(),
            source: self.source.read(cx).value().to_string(),
            revision: profile.revision,
        });
        self.pending = true;
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(profile) => {
                        this.show(profile, window, cx);
                        super::toast::success("Project profile saved", window, cx);
                    }
                    Err(error) => match problem(&error) {
                        Some(problem) => this.problem = Some(problem),
                        None => super::toast::error(&error, None, window, cx),
                    },
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for ProjectProfileEditor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(profile) = &self.profile else {
            return v_flex();
        };
        let muted = color(Token::MutedForeground, cx);
        let revision = if profile.revision == 0. {
            "Not saved yet.".to_string()
        } else {
            format!("Revision {}.", profile.revision)
        };
        v_flex()
            .mt_3()
            .pt_3()
            .gap_2()
            .border_t_1()
            .border_color(color(Token::Border, cx))
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child("Project profile"),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child(format!("{HELP} {revision}")),
            )
            .child(
                div()
                    .font_family("monospace")
                    .text_xs()
                    .child(Textarea::new(&self.source).aria_label("Profile YAML")),
            )
            .children(self.problem.clone().map(|problem| {
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .text_xs()
                    .text_color(color(Token::Destructive, cx))
                    .child(problem.text)
                    .children(problem.stale.then(|| {
                        Button::new("reload-project-profile")
                            .outline()
                            .small()
                            .label("Reload")
                            .on_click(cx.listener(|this, _, window, cx| this.load(window, cx)))
                    }))
            }))
            .child(
                h_flex().child(
                    Button::new("save-project-profile")
                        .primary()
                        .small()
                        .label(if self.pending {
                            "Saving…"
                        } else {
                            "Save profile"
                        })
                        .disabled(self.pending || !self.dirty(cx))
                        .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
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

    const DETAIL: &str = "checks[0].command: Required";

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
                let (mut gets, mut saves) = (0, 0);
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
                        "getProjectProfile" => {
                            gets += 1;
                            (
                                200,
                                json!({"projectId":"p1","revision":gets,"source":format!("version: {gets}\n"),"updatedAt":5}),
                            )
                        }
                        "updateProjectProfile" => {
                            saves += 1;
                            match saves {
                                1 => (
                                    400,
                                    json!({"code":"PROFILE_INVALID","message":"Invalid profile.","detail":DETAIL}),
                                ),
                                2 => (
                                    409,
                                    json!({"code":"PROFILE_CHANGED","message":"Profile changed."}),
                                ),
                                _ => (
                                    200,
                                    json!({"projectId":"p1","revision":3,"source":input["source"],"updatedAt":6}),
                                ),
                            }
                        }
                        _ => panic!("unexpected project profile RPC: {name}"),
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
        view: &Entity<ProjectProfileEditor>,
        done: impl Fn(&ProjectProfileEditor) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if view.read_with(cx, |view, _| done(view)) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "project profile RPC did not finish"
            );
            std::thread::yield_now();
        }
    }

    #[gpui_kit::test]
    fn invalid_profile_shows_detail_and_a_stale_revision_reloads_before_saving(
        cx: &mut TestAppContext,
    ) {
        let server = Server::new();
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("native-test-token"));
        cx.background_executor.allow_parking();
        let (window, view): (AnyWindowHandle, Entity<ProjectProfileEditor>) = cx.update(|cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| {
                    ProjectProfileEditor::with_client(Some(client), "p1".into(), window, cx)
                })
            })
            .unwrap()
        });
        wait(cx, &view, |view| view.profile.is_some());
        let save = |cx: &mut TestAppContext, source: Option<&str>| {
            cx.update_window(window, |_, window, cx| {
                view.update(cx, |view, cx| {
                    if let Some(source) = source {
                        view.source
                            .update(cx, |input, cx| input.set_value(source, window, cx));
                    }
                    view.save(window, cx);
                })
            })
            .unwrap();
            wait(cx, &view, |view| !view.pending);
        };
        save(cx, None);
        assert!(
            server.calls("updateProjectProfile").is_empty(),
            "an unchanged profile is not saved"
        );
        save(cx, Some("checks:\n  - name: test\n"));
        view.read_with(cx, |view, cx| {
            assert_eq!(
                view.problem,
                Some(Problem {
                    text: DETAIL.into(),
                    stale: false
                })
            );
            assert_eq!(view.source.read(cx).value(), "checks:\n  - name: test\n");
        });
        save(cx, None);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.problem,
                Some(Problem {
                    text: crate::errors::error_message("PROFILE_CHANGED", None),
                    stale: true
                })
            );
        });
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.load(window, cx))
        })
        .unwrap();
        wait(cx, &view, |view| {
            view.profile.as_ref().is_some_and(|p| p.revision == 2.)
        });
        view.read_with(cx, |view, cx| {
            assert!(view.problem.is_none());
            assert_eq!(view.source.read(cx).value(), "version: 2\n");
        });
        save(cx, Some("version: 2\nnotes: keep it small\n"));
        view.read_with(cx, |view, cx| {
            assert!(view.problem.is_none());
            assert_eq!(view.profile.as_ref().unwrap().revision, 3.);
            assert!(!view.dirty(cx));
        });
        let revisions: Vec<_> = server
            .calls("updateProjectProfile")
            .iter()
            .map(|input| (input["projectId"].clone(), input["revision"].clone()))
            .collect();
        assert_eq!(
            revisions,
            vec![
                (json!("p1"), json!(1.0)),
                (json!("p1"), json!(1.0)),
                (json!("p1"), json!(2.0)),
            ]
        );
    }
}
