use super::tokens::{Token, color};
use super::{
    processes::{ProcessPanel, ProcessSelected},
    review::{ReviewEvent, ReviewPanel},
};
use crate::stores::workspace::WorkspaceStore;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, Context, Entity, EventEmitter, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Subscription, Window, div,
};
use tempo_client::Client;
use tempo_protocol::{self as p, api};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Changes,
    Files,
    Checks,
    Artifacts,
    Activity,
    Setup,
    Run,
    Terminal,
    Browser,
}
impl Tool {
    fn title(self) -> &'static str {
        match self {
            Self::Changes => "Changes",
            Self::Files => "Files",
            Self::Checks => "Checks",
            Self::Artifacts => "Artifacts",
            Self::Activity => "Activity",
            Self::Setup => "Setup",
            Self::Run => "Run",
            Self::Terminal => "Terminal",
            Self::Browser => "Browser",
        }
    }
}
const TOOLS: [Tool; 9] = [
    Tool::Browser,
    Tool::Files,
    Tool::Terminal,
    Tool::Changes,
    Tool::Checks,
    Tool::Artifacts,
    Tool::Activity,
    Tool::Setup,
    Tool::Run,
];
const REVIEW: [Tool; 5] = [
    Tool::Changes,
    Tool::Files,
    Tool::Checks,
    Tool::Artifacts,
    Tool::Activity,
];
const PROCESSES: [Tool; 3] = [Tool::Setup, Tool::Run, Tool::Terminal];
#[derive(Clone)]
pub struct RevealTools;
impl EventEmitter<RevealTools> for ToolPanel {}

pub struct ToolPanel {
    store: Entity<WorkspaceStore>,
    client: Client,
    review: Entity<ReviewPanel>,
    processes: Entity<ProcessPanel>,
    tabs: Vec<Tool>,
    active: Option<Tool>,
    browser: Option<String>,
    browser_error: Option<String>,
    pub browser_pending: bool,
    browser_generation: u64,
    #[cfg(target_os = "macos")]
    native_browser: Option<crate::macos::live_view::LiveView>,
    _subscriptions: Vec<Subscription>,
}
impl ToolPanel {
    pub fn new(
        store: Entity<WorkspaceStore>,
        client: Client,
        review: Entity<ReviewPanel>,
        processes: Entity<ProcessPanel>,
        cx: &mut Context<Self>,
    ) -> Self {
        let review_events = cx.subscribe(&review, |this, _, event: &ReviewEvent, cx| {
            match event {
                ReviewEvent::Selected(ix) => {
                    if let Some(tool) = REVIEW.get(*ix) {
                        this.activate(*tool, cx);
                    }
                }
                ReviewEvent::Document => {
                    this.active = None;
                    cx.emit(RevealTools);
                }
                _ => {}
            }
            cx.notify();
        });
        let process_events = cx.subscribe(&processes, |this, _, event: &ProcessSelected, cx| {
            if let Some(tool) = PROCESSES.get(event.0) {
                this.activate(*tool, cx);
            }
        });
        let changed = cx.observe(&review, |_, _, cx| cx.notify());
        let state = cx.observe(&store, |this, store, cx| {
            if store
                .read(cx)
                .state
                .workspace
                .as_ref()
                .is_some_and(|w| !w.browser_active)
            {
                this.clear_browser();
                this.browser_error = Some(super::workspace::BROWSER_SESSION_ENDED.into());
                this.browser_pending = false;
                cx.notify();
            }
        });
        Self {
            store,
            client,
            review,
            processes,
            tabs: vec![Tool::Changes],
            active: Some(Tool::Changes),
            browser: None,
            browser_error: None,
            browser_pending: false,
            browser_generation: 0,
            #[cfg(target_os = "macos")]
            native_browser: None,
            _subscriptions: vec![review_events, process_events, changed, state],
        }
    }
    fn activate(&mut self, tool: Tool, cx: &mut Context<Self>) {
        if !self.tabs.contains(&tool) {
            self.tabs.push(tool);
        }
        self.active = Some(tool);
        cx.emit(RevealTools);
        cx.notify();
    }
    fn select(&mut self, tool: Tool, cx: &mut Context<Self>) {
        self.review.update(cx, |r, cx| {
            r.document_open = false;
            cx.notify();
        });
        if let Some(ix) = REVIEW.iter().position(|t| *t == tool) {
            self.review.update(cx, |r, cx| r.select_tab(ix, cx));
        } else if let Some(ix) = PROCESSES.iter().position(|t| *t == tool) {
            self.processes.update(cx, |p, cx| p.select_tab(ix, cx));
        } else if self.browser.is_none() && !self.browser_pending {
            self.open_browser(cx);
        }
        self.activate(tool, cx);
    }
    fn clear_browser(&mut self) {
        self.browser_generation += 1;
        self.browser = None;
        #[cfg(target_os = "macos")]
        {
            self.native_browser = None;
        }
    }
    pub fn open_browser(&mut self, cx: &mut Context<Self>) {
        self.review.update(cx, |r, cx| {
            r.document_open = false;
            cx.notify();
        });
        self.activate(Tool::Browser, cx);
        self.clear_browser();
        let generation = self.browser_generation;
        self.browser_error = None;
        self.browser_pending = true;
        let request = self
            .client
            .call::<api::GetBrowserLiveView>(p::GetBrowserLiveViewIn {
                workspace_id: self.store.read(cx).workspace_id.clone(),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.browser_generation {
                    return;
                }
                this.browser_pending = false;
                match result {
                    Ok(p::GetBrowserLiveViewOut { url: Some(url) }) => {
                        #[cfg(target_os = "macos")]
                        {
                            this.native_browser = crate::macos::live_view::LiveView::new(&url);
                        }
                        this.browser = Some(url);
                    }
                    Ok(_) => {
                        this.browser_error = Some(super::workspace::BROWSER_SESSION_ENDED.into())
                    }
                    Err(error) => this.browser_error = Some(super::toast::error_text(&error, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub fn toggle_terminal(&mut self, cx: &mut Context<Self>) {
        if self.active == Some(Tool::Terminal) {
            self.active = None;
            cx.notify();
        } else {
            self.select(Tool::Terminal, cx);
        }
    }
    pub fn hide_browser(&self) {
        #[cfg(target_os = "macos")]
        if let Some(browser) = &self.native_browser {
            browser.hide();
        }
    }
    pub fn browser_ready(&self) -> bool {
        self.browser.is_some()
    }
    fn close(&mut self, tool: Tool, cx: &mut Context<Self>) {
        self.tabs.retain(|t| *t != tool);
        if self.active == Some(tool) {
            self.active = None;
        }
        if tool == Tool::Browser {
            self.clear_browser();
            self.browser_pending = false;
        }
        cx.notify();
    }
    fn browser_content(&self, cx: &mut Context<Self>) -> AnyElement {
        let body = if self.browser_pending {
            div().p_4().child("Loading browser…").into_any_element()
        } else if let Some(error) = &self.browser_error {
            div().p_4().child(error.clone()).into_any_element()
        } else {
            #[cfg(target_os = "macos")]
            {
                self.native_browser
                    .as_ref()
                    .map(|browser| browser.element())
                    .unwrap_or_else(|| {
                        div()
                            .p_4()
                            .child("Could not display the live view.")
                            .into_any_element()
                    })
            }
            #[cfg(not(target_os = "macos"))]
            {
                div()
                    .p_4()
                    .child("Browser live view is available on Mac.")
                    .into_any_element()
            }
        };
        v_flex()
            .size_full()
            .child(
                h_flex().px_2().py_1().child(
                    Button::new("reload-browser")
                        .ghost()
                        .small()
                        .label("Reload")
                        .on_click(cx.listener(|this, _, _, cx| this.open_browser(cx))),
                ),
            )
            .child(div().flex_1().min_h_0().child(body))
            .into_any_element()
    }
}
impl Render for ToolPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let documents = self.review.read(cx).document_tabs();
        let document_open = self.review.read(cx).document_open;
        if document_open || self.active != Some(Tool::Browser) {
            self.hide_browser();
        }
        let selected = if document_open {
            self.tabs.len()
                + documents
                    .iter()
                    .position(|(key, _)| Some(key) == self.review.read(cx).active_document.as_ref())
                    .unwrap_or(0)
        } else {
            self.active
                .and_then(|tool| self.tabs.iter().position(|t| *t == tool))
                .unwrap_or(self.tabs.len() + documents.len())
        };
        let tab_tools = self.tabs.clone();
        let doc_keys: Vec<_> = documents.iter().map(|(key, _)| key.clone()).collect();
        let content = if document_open {
            self.review.read(cx).document(cx)
        } else if let Some(tool) = self.active {
            if REVIEW.contains(&tool) {
                div()
                    .size_full()
                    .child(self.review.clone())
                    .into_any_element()
            } else if PROCESSES.contains(&tool) {
                div()
                    .size_full()
                    .child(self.processes.clone())
                    .into_any_element()
            } else {
                self.browser_content(cx)
            }
        } else {
            v_flex()
                .p_6()
                .gap_2()
                .child(div().mb_2().child("Open a tool"))
                .children(TOOLS.map(|tool| {
                    Button::new(SharedString::from(format!("open-tool-{}", tool.title())))
                        .outline()
                        .label(tool.title())
                        .on_click(cx.listener(move |this, _, _, cx| this.select(tool, cx)))
                }))
                .child(
                    div()
                        .mt_3()
                        .text_color(color(Token::MutedForeground, cx))
                        .child("Browser shows the workspace’s Cloudflare Browser Run live view."),
                )
                .into_any_element()
        };
        v_flex()
            .size_full()
            .child(
                TabBar::new("tool-tabs")
                    .selected_index(selected)
                    .on_click(cx.listener(move |this, ix: &usize, window, cx| {
                        if let Some(tool) = tab_tools.get(*ix) {
                            this.select(*tool, cx);
                        } else if let Some(key) = doc_keys.get(ix.saturating_sub(tab_tools.len())) {
                            this.review
                                .update(cx, |r, cx| r.select_document(key, window, cx));
                        } else {
                            this.active = None;
                            this.review.update(cx, |r, cx| {
                                r.document_open = false;
                                cx.notify();
                            });
                            cx.notify();
                        }
                    }))
                    .children(self.tabs.clone().into_iter().map(|tool| {
                        Tab::new().label(tool.title()).suffix(
                            Button::new(SharedString::from(format!("close-tool-{}", tool.title())))
                                .ghost()
                                .small()
                                .icon(gpui_kit::assets::IconName::X)
                                .accessibility_label(format!("Close {}", tool.title()))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.close(tool, cx);
                                })),
                        )
                    }))
                    .children(documents.into_iter().map(|(key, title)| {
                        Tab::new().label(SharedString::from(title)).suffix(
                            Button::new(SharedString::from(format!("close-tool-document-{key}")))
                                .ghost()
                                .small()
                                .icon(gpui_kit::assets::IconName::X)
                                .accessibility_label("Close tool tab")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.review
                                        .update(cx, |r, cx| r.close_document_key(&key, cx));
                                })),
                        )
                    }))
                    .child(Tab::new().label("+").aria_label("New tool tab")),
            )
            .child(div().flex_1().min_h_0().child(content))
    }
}
