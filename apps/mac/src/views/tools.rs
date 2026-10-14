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
    AnyElement, AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement as _,
    Render, SharedString, Styled as _, Subscription, Window, div,
};
use tempo_client::Client;
use tempo_protocol::{self as p, api};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Guides,
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
    fn group(self) -> Self {
        match self {
            Self::Files | Self::Checks => Self::Changes,
            Self::Setup => Self::Run,
            _ => self,
        }
    }
    fn icon(self) -> gpui_kit::assets::IconName {
        use gpui_kit::assets::IconName;
        match self.group() {
            Self::Changes => IconName::FileDiff,
            Self::Run => IconName::Play,
            Self::Terminal => IconName::Terminal,
            Self::Browser => IconName::Globe,
            Self::Guides => IconName::BookOpen,
            _ => IconName::Boxes,
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::Guides => "Guides",
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
const TOOLS: [Tool; 7] = [
    Tool::Changes,
    Tool::Terminal,
    Tool::Activity,
    Tool::Run,
    Tool::Browser,
    Tool::Guides,
    Tool::Artifacts,
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
#[derive(Clone)]
pub struct InfoVisibilityChanged;
impl EventEmitter<InfoVisibilityChanged> for ToolPanel {}
impl EventEmitter<super::workspace_info::InfoAction> for ToolPanel {}

pub struct ToolPanel {
    store: Entity<WorkspaceStore>,
    client: Client,
    review: Entity<ReviewPanel>,
    processes: Entity<ProcessPanel>,
    pub(super) info: Entity<super::workspace_info::WorkspaceInfo>,
    guides: Entity<super::guides::GuidePanel>,
    pub info_open: bool,
    pub shared_header: bool,
    tabs: Vec<Tool>,
    active: Option<Tool>,
    last_review: Tool,
    last_process: Tool,
    browser: Option<String>,
    browser_error: Option<String>,
    pub browser_pending: bool,
    browser_generation: u64,
    /// Keeps the selected tool tab in view when the tabs overflow the pane.
    tab_scroll: gpui_kit::ScrollHandle,
    scrolled_to: Option<usize>,
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
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let info = cx.new(|cx| {
            super::workspace_info::WorkspaceInfo::new(store.clone(), client.clone(), window, cx)
        });
        let guides = cx.new(|cx| {
            super::guides::GuidePanel::new(store.clone(), client.clone(), review.clone(), cx)
        });
        let info_events = cx.subscribe(
            &info,
            |this, _, event: &super::workspace_info::InfoAction, cx| {
                if let super::workspace_info::InfoAction::OpenTool(tool) = event {
                    this.select(*tool, cx);
                } else {
                    cx.emit(event.clone());
                }
            },
        );
        let guide_events = cx.subscribe(
            &guides,
            |_, _, event: &super::workspace_info::InfoAction, cx| cx.emit(event.clone()),
        );
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
            info,
            guides,
            info_open: true,
            shared_header: false,
            tabs: vec![],
            active: None,
            last_review: Tool::Changes,
            last_process: Tool::Run,
            browser: None,
            browser_error: None,
            browser_pending: false,
            browser_generation: 0,
            tab_scroll: gpui_kit::ScrollHandle::new(),
            scrolled_to: None,
            #[cfg(target_os = "macos")]
            native_browser: None,
            _subscriptions: vec![
                review_events,
                process_events,
                changed,
                state,
                info_events,
                guide_events,
            ],
        }
    }
    fn activate(&mut self, tool: Tool, cx: &mut Context<Self>) {
        let group = tool.group();
        if !self.tabs.contains(&group) {
            self.tabs.push(group);
        }
        self.active = Some(tool);
        if group == Tool::Changes {
            self.last_review = tool;
        }
        if group == Tool::Run {
            self.last_process = tool;
        }
        cx.emit(RevealTools);
        cx.notify();
    }
    fn select_group(&mut self, group: Tool, cx: &mut Context<Self>) {
        let tool = match group {
            Tool::Changes => self.last_review,
            Tool::Run => self.last_process,
            _ => group,
        };
        self.select(tool, cx);
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
        } else if tool == Tool::Browser && self.browser.is_none() && !self.browser_pending {
            self.open_browser(cx);
        }
        if tool == Tool::Guides {
            self.guides.update(cx, |g, cx| g.refresh(cx));
        }
        self.activate(tool, cx);
    }
    pub fn show_info(&mut self, chat: Option<String>, cx: &mut Context<Self>) {
        self.guides.update(cx, |g, cx| {
            g.active_chat = chat;
            cx.notify();
        });
        self.info_open = true;
        self.hide_browser();
        self.info.update(cx, |i, cx| i.refresh(cx));
        cx.emit(InfoVisibilityChanged);
        cx.notify();
    }
    pub fn close_info(&mut self, cx: &mut Context<Self>) {
        self.info_open = false;
        cx.emit(InfoVisibilityChanged);
        cx.notify();
    }
    pub fn toggle_info(&mut self, chat: Option<String>, cx: &mut Context<Self>) {
        if self.info_open {
            self.close_info(cx);
        } else {
            self.show_info(chat, cx);
        }
    }
    pub fn set_chat(&mut self, chat: Option<String>, cx: &mut Context<Self>) {
        self.guides.update(cx, |g, cx| {
            g.active_chat = chat;
            cx.notify();
        });
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
    pub fn show_launcher(&mut self, cx: &mut Context<Self>) {
        self.active = None;
        self.review.update(cx, |review, cx| {
            review.document_open = false;
            cx.notify();
        });
        cx.notify();
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
        self.tabs.retain(|t| *t != tool.group());
        if self.active.map(Tool::group) == Some(tool.group()) {
            self.active = None;
        }
        if tool == Tool::Browser {
            self.clear_browser();
            self.browser_pending = false;
        }
        cx.notify();
    }
    pub fn tab_bar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let documents = self.review.read(cx).document_tabs();
        let document_open = self.review.read(cx).document_open;
        let selected = if document_open {
            self.tabs.len()
                + documents
                    .iter()
                    .position(|(key, _)| Some(key) == self.review.read(cx).active_document.as_ref())
                    .unwrap_or(0)
        } else {
            self.active
                .and_then(|tool| self.tabs.iter().position(|t| *t == tool.group()))
                .unwrap_or(self.tabs.len() + documents.len())
        };
        if self.scrolled_to != Some(selected) {
            self.tab_scroll.scroll_to_item(selected);
            self.scrolled_to = Some(selected);
        }
        let tab_tools = self.tabs.clone();
        let doc_keys: Vec<_> = documents.iter().map(|(key, _)| key.clone()).collect();
        div()
            .h(gpui_kit::px(40.))
            .w_full()
            .bg(color(Token::Muted, cx))
            .child(
                TabBar::new("tool-tabs")
                    .underline()
                    .menu(true)
                    .track_scroll(&self.tab_scroll)
                    .h_full()
                    .bg(color(Token::Muted, cx))
                    .selected_index(selected)
                    .on_click(cx.listener(move |this, ix: &usize, window, cx| {
                        if let Some(tool) = tab_tools.get(*ix) {
                            this.select_group(*tool, cx);
                        } else if let Some(key) = doc_keys.get(ix.saturating_sub(tab_tools.len())) {
                            this.review
                                .update(cx, |r, cx| r.select_document(key, window, cx));
                        } else {
                            this.show_launcher(cx);
                        }
                    }))
                    .children(self.tabs.clone().into_iter().map(|tool| {
                        Tab::new().label(tool.title()).suffix(
                            Button::new(SharedString::from(format!("close-tool-{}", tool.title())))
                                .ghost()
                                .small()
                                .size(gpui_kit::px(super::tokens::ICON_BUTTON))
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
                                .size(gpui_kit::px(super::tokens::ICON_BUTTON))
                                .icon(gpui_kit::assets::IconName::X)
                                .accessibility_label("Close tool tab")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.review
                                        .update(cx, |r, cx| r.close_document_key(&key, cx));
                                })),
                        )
                    }))
                    .suffix(
                        Button::new("new-tool-tab")
                            .ghost()
                            .small()
                            .size(gpui_kit::px(super::tokens::ICON_BUTTON))
                            .icon(gpui_kit::assets::IconName::Plus)
                            .accessibility_label("New tool tab")
                            .tooltip("Open a tool")
                            .on_click(cx.listener(|this, _, _, cx| this.show_launcher(cx))),
                    ),
            )
            .into_any_element()
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
        let document_open = self.review.read(cx).document_open;
        if document_open || self.active != Some(Tool::Browser) {
            self.hide_browser();
        }
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
            } else if tool == Tool::Guides {
                self.guides.clone().into_any_element()
            } else {
                self.browser_content(cx)
            }
        } else {
            v_flex()
                .p_4()
                .gap_4()
                .child(div().text_base().child("Tools"))
                .child(
                    div()
                        .grid()
                        .grid_cols(2)
                        .gap_2()
                        .children(TOOLS.map(|tool| {
                            Button::new(SharedString::from(format!("open-tool-{}", tool.title())))
                                .ghost()
                                .small()
                                .w_full()
                                .h(gpui_kit::px(36.))
                                .bg(color(Token::Muted, cx))
                                .accessibility_label(tool.title())
                                .child(
                                    h_flex()
                                        .w_full()
                                        .text_sm()
                                        .font_weight(gpui_kit::FontWeight::NORMAL)
                                        .gap_2()
                                        .child(gpui_kit::component::Icon::new(tool.icon()).small())
                                        .child(div().flex_1().text_left().child(tool.title()))
                                        .children((tool == Tool::Terminal).then(|| {
                                            div()
                                                .px_2()
                                                .rounded_md()
                                                .bg(color(Token::SidebarAccent, cx))
                                                .text_color(color(Token::MutedForeground, cx))
                                                .child("⌘J")
                                        })),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| this.select(tool, cx)))
                        })),
                )
                .into_any_element()
        };
        v_flex()
            .size_full()
            .children((!self.shared_header).then(|| self.tab_bar(cx)))
            .children((!document_open).then(|| {
                let sections: Vec<Tool> = match self.active.map(Tool::group) {
                    Some(Tool::Changes) => vec![Tool::Changes, Tool::Files, Tool::Checks],
                    Some(Tool::Run) => vec![Tool::Setup, Tool::Run],
                    _ => vec![],
                };
                let selected = sections
                    .iter()
                    .position(|tool| Some(*tool) == self.active)
                    .unwrap_or(0);
                let choices = sections.clone();
                div().px_3().children((!sections.is_empty()).then(|| {
                    TabBar::new("tool-sections")
                        .underline()
                        .selected_index(selected)
                        .on_click(cx.listener(move |this, ix: &usize, _, cx| {
                            if let Some(tool) = choices.get(*ix) {
                                this.select(*tool, cx);
                            }
                        }))
                        .children(
                            sections
                                .into_iter()
                                .map(|tool| Tab::new().label(tool.title())),
                        )
                }))
            }))
            .child(div().flex_1().min_h_0().child(content))
            .into_any_element()
    }
}
