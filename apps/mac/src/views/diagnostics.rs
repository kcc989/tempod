use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _, Window,
    div, uniform_list,
};
use tempo_protocol::{self as p, api};

pub struct DiagnosticsView {
    client: tempo_client::Client,
    id: String,
    data: Option<p::Diagnostics>,
    tab: usize,
    host: Entity<InputState>,
    status: Entity<InputState>,
    error: Option<String>,
    _filters: Vec<gpui_kit::Subscription>,
}
impl DiagnosticsView {
    pub fn new(
        client: tempo_client::Client,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let host = cx.new(|cx| InputState::new(window, cx).placeholder("Filter host"));
        let status = cx.new(|cx| InputState::new(window, cx).placeholder("Filter status"));
        let filters = vec![
            cx.observe(&host, |_, _, cx| cx.notify()),
            cx.observe(&status, |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            client,
            id,
            data: None,
            tab: 0,
            host,
            status,
            _filters: filters,
            error: None,
        };
        this.refresh(cx);
        this
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let request = self
            .client
            .call::<api::GetDiagnostics>(p::GetDiagnosticsIn {
                workspace_id: self.id.clone(),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(data) => {
                        this.data = Some(data);
                        this.error = None;
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
impl Render for DiagnosticsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let host = self.host.read(cx).value().to_lowercase();
        let status = self.status.read(cx).value().to_string();
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
                    .filter(|e| {
                        e.host.to_lowercase().contains(&host)
                            && (status.is_empty() || e.status.to_string() == status)
                    })
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
                        ["Ops", "Container", "Logs", "Egress", "Sessions"]
                            .map(|t| Tab::new().label(t)),
                    )
                    .on_click(cx.listener(|this, ix: &usize, _, cx| {
                        this.tab = *ix;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("refresh-diagnostics")
                    .label("Refresh")
                    .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
            )
            .children(self.error.clone().map(|e| div().child(e)))
            .children((self.tab == 3).then(|| {
                h_flex()
                    .gap_2()
                    .child(Input::new(&self.host))
                    .child(Input::new(&self.status))
            }))
            .children(
                self.data
                    .is_none()
                    .then(|| div().child("Loading diagnostics…")),
            )
            .child(
                uniform_list(
                    "diagnostics-rows",
                    rows.len(),
                    cx.processor(move |_, range: std::ops::Range<usize>, _, _| {
                        range
                            .map(|i| div().p_2().font_family("monospace").child(rows[i].clone()))
                            .collect()
                    }),
                )
                .flex_1(),
            )
    }
}
