use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::select::{Select, SelectEvent, SelectItem, SelectState};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{IndexPath, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Task, Window, div, uniform_list,
};
use std::time::Duration;
use tempo_protocol::{self as p, api};

const EGRESS_HOST_DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, PartialEq)]
pub struct StatusChoice {
    label: &'static str,
    value: p::EgressStatusFilter,
}
impl SelectItem for StatusChoice {
    type Value = p::EgressStatusFilter;
    fn title(&self) -> SharedString {
        self.label.into()
    }
    fn value(&self) -> &Self::Value {
        &self.value
    }
}

/// The web's `EGRESS_STATUS_FILTERS`: every `egressStatus` getDiagnostics accepts (02).
pub fn status_choices() -> Vec<StatusChoice> {
    use p::EgressStatusFilter as F;
    [
        ("All statuses", F::All),
        ("Blocked", F::Blocked),
        ("2xx", F::X2xx),
        ("3xx", F::X3xx),
        ("4xx", F::X4xx),
        ("5xx", F::X5xx),
    ]
    .into_iter()
    .map(|(label, value)| StatusChoice { label, value })
    .collect()
}

/// 02 getDiagnostics: the server filters the egress rows; the defaults are left out.
pub fn diagnostics_input(
    workspace_id: &str,
    host: &str,
    status: p::EgressStatusFilter,
) -> p::GetDiagnosticsIn {
    let host = host.trim();
    p::GetDiagnosticsIn {
        workspace_id: workspace_id.into(),
        egress_host: (!host.is_empty()).then(|| host.to_string()),
        egress_status: (status != p::EgressStatusFilter::All).then_some(status),
    }
}

pub struct DiagnosticsView {
    events: Entity<super::roles::EventsView>,
    client: tempo_client::Client,
    id: String,
    data: Option<p::Diagnostics>,
    tab: usize,
    host: Entity<InputState>,
    status: Entity<SelectState<Vec<StatusChoice>>>,
    egress_status: p::EgressStatusFilter,
    error: Option<String>,
    generation: u64,
    _request: Option<Task<()>>,
    _filters: Vec<gpui_kit::Subscription>,
}
impl DiagnosticsView {
    pub fn new(
        client: tempo_client::Client,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let events =
            cx.new(|cx| super::roles::EventsView::new(client.clone(), id.clone(), window, cx));
        let host = cx.new(|cx| InputState::new(window, cx).placeholder("Filter by host"));
        let status =
            cx.new(|cx| SelectState::new(status_choices(), Some(IndexPath::default()), window, cx));
        let filters = vec![
            cx.subscribe(&host, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.refresh(true, cx);
                }
            }),
            cx.subscribe(
                &status,
                |this, _, event: &SelectEvent<Vec<StatusChoice>>, cx| {
                    if let SelectEvent::Confirm(Some(value)) = event {
                        this.egress_status = *value;
                        this.refresh(false, cx);
                    }
                },
            ),
        ];
        let mut this = Self {
            client,
            events,
            id,
            data: None,
            tab: 0,
            host,
            status,
            egress_status: p::EgressStatusFilter::All,
            _filters: filters,
            error: None,
            generation: 0,
            _request: None,
        };
        this.refresh(false, cx);
        this
    }
    /// Host edits wait 250 ms, as the web; only the newest request's answer is shown.
    fn refresh(&mut self, debounce: bool, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let input = diagnostics_input(&self.id, &self.host.read(cx).value(), self.egress_status);
        let client = self.client.clone();
        self._request = Some(cx.spawn(async move |this, cx| {
            if debounce {
                cx.background_executor().timer(EGRESS_HOST_DEBOUNCE).await;
            }
            let result = client.call::<api::GetDiagnostics>(input).await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match result {
                    Ok(data) => {
                        this.data = Some(data);
                        this.error = None;
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        }));
    }
}
impl Render for DiagnosticsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows: Vec<String> = self
            .data
            .as_ref()
            .map(|d| match self.tab {
                0 => d
                    .ops
                    .iter()
                    .map(|o| {
                        format!(
                            "{} · {} · {} · attempt {}\n{}{}",
                            o.kind,
                            o.status,
                            o.step,
                            o.attempt,
                            o.timings
                                .iter()
                                .map(|(s, ms)| format!("{s} {ms} ms · "))
                                .collect::<String>(),
                            o.error_detail.as_deref().unwrap_or("")
                        )
                    })
                    .collect(),
                1 => serde_json::to_string_pretty(&d.container)
                    .unwrap_or_default()
                    .lines()
                    .map(Into::into)
                    .collect(),
                2 => d
                    .logs
                    .iter()
                    .map(|l| format!("{} {} {}", l.ts, l.level, l.msg))
                    .collect(),
                3 => d
                    .egress
                    .iter()
                    .map(|e| {
                        format!(
                            "{} {} {}{} · {} · {} ms · rule {}",
                            e.ts, e.method, e.host, e.path, e.status, e.ms, e.rule
                        )
                    })
                    .collect(),
                _ => d
                    .sessions
                    .iter()
                    .map(|s| {
                        format!(
                            "{} · {} · {}\n{}",
                            s.agent,
                            s.acp_session_id.as_deref().unwrap_or("Not started"),
                            if s.live { "Live" } else { "Stopped" },
                            serde_json::to_string(&s.capabilities).unwrap_or_default()
                        )
                    })
                    .collect(),
            })
            .unwrap_or_default();
        v_flex()
            .size_full()
            .gap_2()
            .child(
                TabBar::new("diagnostics-tabs")
                    .selected_index(self.tab)
                    .children(
                        ["Ops", "Container", "Logs", "Egress", "Sessions", "Events"]
                            .map(|t| Tab::new().label(t)),
                    )
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.tab = *ix;
                        if *ix == 5 {
                            this.events.update(cx, |events, cx| events.refresh(cx));
                        }
                        cx.notify();
                    })),
            )
            .child(
                Button::new("refresh-diagnostics")
                    .label("Refresh")
                    .on_click(cx.listener(|this, _, _, cx| this.refresh(false, cx))),
            )
            .children(self.error.clone().map(|e| div().child(e)))
            .children((self.tab == 3).then(|| {
                h_flex()
                    .gap_2()
                    .child(Input::new(&self.host))
                    .child(Select::new(&self.status).accessibility_label("Filter by status"))
            }))
            .children(
                self.data
                    .is_none()
                    .then(|| div().child("Loading diagnostics…")),
            )
            .child(if self.tab == 5 {
                self.events.clone().into_any_element()
            } else {
                uniform_list(
                    "diagnostics-rows",
                    rows.len(),
                    cx.processor(move |_, range: std::ops::Range<usize>, _, _| {
                        range
                            .map(|i| div().p_2().font_family("monospace").child(rows[i].clone()))
                            .collect()
                    }),
                )
                .flex_1()
                .into_any_element()
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AnyWindowHandle, TestAppContext};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[test]
    fn input_sends_the_filters_and_leaves_the_defaults_out() {
        let plain = diagnostics_input("w1", "  ", p::EgressStatusFilter::All);
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            serde_json::json!({"workspaceId": "w1"})
        );
        let both = diagnostics_input("w1", " GitHub ", p::EgressStatusFilter::Blocked);
        assert_eq!(
            serde_json::to_value(&both).unwrap(),
            serde_json::json!({"workspaceId": "w1", "egressHost": "GitHub", "egressStatus": "blocked"})
        );
    }

    #[test]
    fn status_choices_are_the_web_list() {
        let choices = status_choices();
        let values: Vec<String> = choices.iter().map(|c| c.value.to_string()).collect();
        assert_eq!(values, ["all", "blocked", "2xx", "3xx", "4xx", "5xx"]);
        assert_eq!(choices[0].title().as_ref(), "All statuses");
    }

    struct Server {
        url: String,
        bodies: Arc<Mutex<Vec<serde_json::Value>>>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl Server {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let log = bodies.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let reply =
                include_str!("../../../../packages/protocol/fixtures/types/Diagnostics.jsonl")
                    .lines()
                    .next()
                    .unwrap()
                    .to_string();
            let worker = std::thread::spawn(move || {
                while !stopping.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    let mut bytes = Vec::new();
                    let mut chunk = [0; 4096];
                    let (head_end, len) = loop {
                        let n = stream.read(&mut chunk).unwrap_or(0);
                        if n == 0 {
                            break (bytes.len(), 0);
                        }
                        bytes.extend_from_slice(&chunk[..n]);
                        if let Some(ix) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&bytes[..ix]).to_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse().ok())
                                .unwrap_or(0);
                            break (ix + 4, len);
                        }
                    };
                    while bytes.len() < head_end + len {
                        let n = stream.read(&mut chunk).unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&chunk[..n]);
                    }
                    if let Ok(body) = serde_json::from_slice(&bytes[head_end..]) {
                        log.lock().unwrap().push(body);
                    }
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                            reply.len()
                        )
                        .as_bytes(),
                    );
                }
            });
            Self {
                url,
                bodies,
                stop,
                worker: Some(worker),
            }
        }
        fn bodies(&self) -> Vec<serde_json::Value> {
            self.bodies.lock().unwrap().clone()
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    fn wait_for(cx: &mut TestAppContext, done: impl Fn(&mut TestAppContext) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if done(cx) {
                return;
            }
            assert!(Instant::now() < deadline, "request did not arrive");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[gpui_kit::test]
    fn filters_go_to_get_diagnostics_and_the_host_waits_250_ms(cx: &mut TestAppContext) {
        cx.background_executor.allow_parking();
        let server = Server::new();
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let (window, view): (AnyWindowHandle, Entity<DiagnosticsView>) = cx
            .update(|cx| {
                gpui_kit::init(cx);
                gpui_kit::open_window(Default::default(), cx, |window, cx| {
                    cx.new(|cx| DiagnosticsView::new(client, "w1".into(), window, cx))
                })
            })
            .unwrap();
        wait_for(cx, |_| server.bodies().len() == 1);
        assert_eq!(server.bodies()[0], serde_json::json!({"workspaceId": "w1"}));
        wait_for(cx, |cx| view.read_with(cx, |v, _| v.data.is_some()));

        cx.update_window(window, |_, window, cx| {
            let host = view.read(cx).host.clone();
            host.update(cx, |state, cx| {
                state.set_value("api.GitHub", window, cx);
                cx.emit(InputEvent::Change);
            });
        })
        .unwrap();
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(200));
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(server.bodies().len(), 1);
        cx.executor().advance_clock(Duration::from_millis(60));
        wait_for(cx, |_| server.bodies().len() == 2);
        assert_eq!(
            server.bodies()[1],
            serde_json::json!({"workspaceId": "w1", "egressHost": "api.GitHub"})
        );

        view.update(cx, |v, cx| {
            v.status.update(cx, |_, cx| {
                cx.emit(SelectEvent::<Vec<StatusChoice>>::Confirm(Some(
                    p::EgressStatusFilter::X4xx,
                )))
            })
        });
        wait_for(cx, |_| server.bodies().len() == 3);
        assert_eq!(
            server.bodies()[2],
            serde_json::json!({"workspaceId": "w1", "egressHost": "api.GitHub", "egressStatus": "4xx"})
        );
    }
}
