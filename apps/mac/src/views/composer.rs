//! Composer (04, Composer; 07): a GPUI Kit `Textarea` that grows from 2 to 12 rows, in the
//! `Composer` key context. Enter sends, ⇧Enter adds a line (the text field's own binding), Esc
//! stops the turn, ⇧Tab toggles plan mode. Pickers use agent-reported modes and models.
use super::composer_model::{self, SlashEntry};
use super::composer_parts::{self, Choice, Picker};
use super::file_picker::{FilePicker, MentionTrigger};
use super::tokens::{Token, color};
use crate::actions::{
    DismissComposerChoice, NextComposerChoice, PreviousComposerChoice, Send, StopTurn,
    TogglePlanMode,
};
use crate::keymap::COMPOSER;
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::command::{Command, CommandItem, CommandState};
use gpui_kit::component::input::{InputEvent, TextareaState};
use gpui_kit::component::list::{List, ListEvent, ListState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::select::{SelectEvent, SelectState};
use gpui_kit::component::v_flex;
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex};
use gpui_kit::component::{Icon, IndexPath};
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Styled as _, Subscription, Window, div,
    px,
};
use tempo_protocol as p;

/// A select option's values, with group names kept in the labels.
fn select_choices(config: Option<&p::ConfigOption>) -> Vec<Choice> {
    config
        .and_then(|c| c.options.as_ref())
        .into_iter()
        .flatten()
        .flat_map(|option| match option {
            p::ConfigOptionOptionsItem::Option(option) => vec![Choice {
                value: option.value.clone(),
                label: option.name.clone().into(),
                trigger_label: None,
            }],
            p::ConfigOptionOptionsItem::Group(group) => group
                .options
                .iter()
                .map(|option| Choice {
                    value: option.value.clone(),
                    label: format!("{} · {}", group.name, option.name).into(),
                    trigger_label: None,
                })
                .collect(),
        })
        .collect()
}

pub enum ComposerEvent {
    Send(String),
    Attach(Vec<std::path::PathBuf>),
    AttachImage(gpui_kit::Image),
    Steer(String),
    Change(String),
    ClearReview,
    LoadFiles,
    Stop,
    TogglePlanMode,
    SetMode(String),
    SetModel { config_id: String, value: String },
    SetIntentCheck(bool),
}

pub struct Composer {
    input: Entity<TextareaState>,
    placeholder: String,
    mentions: Vec<p::Mention>,
    attachments: Vec<(String, String)>,
    pub uploading: bool,
    pub review_count: usize,
    files: Option<Vec<String>>,
    files_loading: bool,
    files_error: Option<String>,
    files_loaded: Option<std::time::Instant>,
    file_menu: Entity<ListState<FilePicker>>,
    _file_events: Subscription,
    pub run_running: bool,
    agents: Vec<String>,
    attached_agents: std::collections::HashSet<String>,
    pub read_only: bool,
    pub sending: bool,
    pub working: bool,
    pub starting: bool,
    pub steering: bool,
    commands: Vec<p::AvailableCommand>,
    usage: Option<(f64, f64)>,
    context_details_open: bool,
    plan_available: bool,
    command_menu: Entity<CommandState>,
    command_dismissed: bool,
    command_query: Option<String>,
    command_selected: usize,
    model: Entity<Picker>,
    model_menu: Entity<CommandState>,
    model_menu_open: bool,
    mode: Entity<Picker>,
    model_config: Option<String>,
    model_choices: Vec<Choice>,
    /// The reasoning level: the agent's `thought_level` option (04, Composer).
    level: Entity<Picker>,
    level_config: Option<String>,
    level_choices: Vec<Choice>,
    mode_choices: Vec<Choice>,
    /// The profile-issues notice (04) and whether it was dismissed for this session.
    profile_notice: Option<String>,
    notice_dismissed: bool,
    pub configuring: bool,
    /// The chat's intent check (13); `None` for runs.
    intent_check: Option<bool>,
    pub intent_check_pending: bool,
    _picker_events: Vec<Subscription>,
    _input_changed: Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Composer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| TextareaState::new(window, cx).auto_grow(2, 12));
        let changed = cx.subscribe(&input, |_, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.emit(ComposerEvent::Change(input.read(cx).value().to_string()));
            }
            cx.notify();
        });
        let file_menu = cx.new(|cx| ListState::new(FilePicker::default(), window, cx));
        let file_events = cx.subscribe_in(
            &file_menu,
            window,
            |this, _, event: &ListEvent, window, cx| match event {
                ListEvent::Confirm(index) => this.pick_file(index.row, window, cx),
                ListEvent::Select(index) => {
                    this.command_selected = index.row;
                    cx.notify();
                }
                ListEvent::Cancel => {
                    this.command_dismissed = true;
                    cx.notify();
                }
            },
        );
        let model =
            cx.new(|cx| SelectState::new(Vec::<Choice>::new(), None, window, cx).searchable(true));
        let mode = cx.new(|cx| SelectState::new(Vec::<Choice>::new(), None, window, cx));
        let level = cx.new(|cx| SelectState::new(Vec::<Choice>::new(), None, window, cx));
        let level_events = cx.subscribe(&level, |this, _, event: &SelectEvent<Vec<Choice>>, cx| {
            if this.read_only || this.working || this.starting || this.configuring {
                return;
            }
            if let (SelectEvent::Confirm(Some(value)), Some(config_id)) =
                (event, &this.level_config)
            {
                cx.emit(ComposerEvent::SetModel {
                    config_id: config_id.clone(),
                    value: value.clone(),
                });
            }
        });
        let model_events = cx.subscribe(&model, |this, _, event: &SelectEvent<Vec<Choice>>, cx| {
            if this.read_only || this.working || this.starting || this.configuring {
                return;
            }
            if let (SelectEvent::Confirm(Some(value)), Some(config_id)) =
                (event, &this.model_config)
            {
                cx.emit(ComposerEvent::SetModel {
                    config_id: config_id.clone(),
                    value: value.clone(),
                });
            }
        });
        let mode_events = cx.subscribe(&mode, |this, _, event: &SelectEvent<Vec<Choice>>, cx| {
            if this.read_only || this.working || this.starting || this.configuring {
                return;
            }
            if let SelectEvent::Confirm(Some(value)) = event {
                cx.emit(ComposerEvent::SetMode(value.clone()));
            }
        });
        Self {
            input,
            placeholder: String::new(),
            mentions: vec![],
            attachments: vec![],
            uploading: false,
            review_count: 0,
            files: None,
            files_loading: false,
            files_error: None,
            files_loaded: None,
            file_menu,
            _file_events: file_events,
            run_running: false,
            agents: vec![],
            attached_agents: Default::default(),
            read_only: false,
            sending: false,
            working: false,
            starting: false,
            steering: false,
            commands: vec![],
            usage: None,
            context_details_open: false,
            plan_available: false,
            command_menu: cx.new(|cx| CommandState::new(window, cx)),
            command_dismissed: false,
            command_query: None,
            command_selected: 0,
            model,
            model_menu: cx.new(|cx| CommandState::new(window, cx)),
            model_menu_open: false,
            mode,
            model_config: None,
            model_choices: vec![],
            level,
            level_config: None,
            level_choices: vec![],
            mode_choices: vec![],
            profile_notice: None,
            notice_dismissed: false,
            configuring: false,
            intent_check: None,
            intent_check_pending: false,
            _picker_events: vec![model_events, mode_events, level_events],
            _input_changed: changed,
        }
    }

    pub fn set_placeholder(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.placeholder != text {
            self.placeholder = text.into();
            let text = SharedString::from(text.to_string());
            self.input
                .update(cx, |input, cx| input.set_placeholder(text, window, cx));
        }
    }

    pub fn sync_session(
        &mut self,
        session: &p::Session,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.commands = session.commands.clone();
        self.usage = session
            .usage
            .0
            .get("used")
            .and_then(|u| u.as_f64())
            .zip(session.usage.0.get("size").and_then(|u| u.as_f64()))
            .filter(|(used, size)| {
                used.is_finite() && size.is_finite() && *used >= 0. && *size > 0.
            });
        self.plan_available = super::chat_model::plan_target(session, None).is_some();
        self.starting = session.status == p::SessionStatus::Starting;
        self.intent_check = session.intent_check;
        let config = session
            .config_options
            .iter()
            .find(|c| c.category.as_deref() == Some("model") && c.type_ == "select");
        self.model_config = config.map(|c| c.id.clone());
        let choices = select_choices(config);
        if self.model_choices != choices {
            self.model_choices = choices.clone();
            self.model
                .update(cx, |state, cx| state.set_items(choices, window, cx));
        }
        if !self.configuring
            && let Some(p::ConfigOptionCurrentValue::String(value)) =
                config.map(|c| &c.current_value)
        {
            self.model.update(cx, |state, cx| {
                if state.selected_value() != Some(value) {
                    state.set_selected_value(value, window, cx);
                }
            });
        }
        let level = session
            .config_options
            .iter()
            .find(|c| c.category.as_deref() == Some("thought_level") && c.type_ == "select");
        self.level_config = level.map(|c| c.id.clone());
        let choices = select_choices(level);
        if self.level_choices != choices {
            self.level_choices = choices.clone();
            self.level
                .update(cx, |state, cx| state.set_items(choices, window, cx));
        }
        if !self.configuring
            && let Some(p::ConfigOptionCurrentValue::String(value)) =
                level.map(|c| &c.current_value)
        {
            self.level.update(cx, |state, cx| {
                if state.selected_value() != Some(value) {
                    state.set_selected_value(value, window, cx);
                }
            });
        }
        self.profile_notice = super::agents_model::profile_issues_text(session);
        let choices: Vec<_> = session
            .modes
            .iter()
            .map(|mode| Choice {
                value: mode.id.clone(),
                label: mode.name.clone().into(),
                trigger_label: None,
            })
            .collect();
        if self.mode_choices != choices {
            self.mode_choices = choices.clone();
            self.mode
                .update(cx, |state, cx| state.set_items(choices, window, cx));
        }
        if !self.configuring
            && let Some(value) = &session.mode_id
        {
            self.mode.update(cx, |state, cx| {
                if state.selected_value() != Some(value) {
                    state.set_selected_value(value, window, cx);
                }
            });
        }
        cx.notify();
    }

    pub fn focus_model(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.model_choices.is_empty()
            && !self.read_only
            && !self.working
            && !self.starting
            && !self.configuring
        {
            self.model_menu_open = true;
            self.model_menu.read(cx).focus_handle(cx).focus(window, cx);
            cx.notify();
        }
    }

    fn render_context_usage(
        &self,
        used: f64,
        size: f64,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let ratio = (used / size).min(1.);
        let percent = ratio * 100.;
        let label = format!("Context usage: {used:.0} of {size:.0} tokens ({percent:.0}%)");
        let owner = cx.weak_entity();
        Popover::new("context-details")
            .anchor(gpui_kit::Anchor::BottomRight)
            .open(self.context_details_open)
            .trigger(
                Button::new("context-usage")
                    .ghost()
                    .small()
                    .h(px(28.))
                    .accessibility_label(label.clone())
                    .tooltip(label)
                    .child(
                        h_flex()
                            .gap_2()
                            .text_xs()
                            .text_color(color(Token::MutedForeground, cx))
                            .child(
                                div()
                                    .w(px(48.))
                                    .h(px(6.))
                                    .rounded(px(3.))
                                    .overflow_hidden()
                                    .bg(color(Token::MutedForeground, cx).opacity(0.25))
                                    .child(
                                        div()
                                            .h_full()
                                            .w(gpui_kit::relative(ratio as f32))
                                            .rounded(px(3.))
                                            .bg(color(Token::MutedForeground, cx)),
                                    ),
                            ),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.context_details_open = true;
                        cx.notify();
                    })),
            )
            .on_open_change(move |open, _, cx| {
                let _ = owner.update(cx, |this, cx| {
                    this.context_details_open = *open;
                    cx.notify();
                });
            })
            .content(move |_, _, cx| {
                v_flex()
                    .w(px(240.))
                    .gap_2()
                    .text_sm()
                    .child(
                        h_flex()
                            .justify_between()
                            .child("Context used")
                            .child(format!("{percent:.0}%")),
                    )
                    .child(
                        div()
                            .text_color(color(Token::MutedForeground, cx))
                            .child(format!("{used:.0} of {size:.0} tokens")),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(color(Token::MutedForeground, cx))
                            .child(
                                "The fill shows how much of the agent’s context window is used.",
                            ),
                    )
            })
    }

    fn render_model_menu(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let disabled = self.read_only || self.working || self.starting || self.configuring;
        let selected = self.model.read(cx).selected_value().cloned();
        let level = self.level.read(cx).selected_value().cloned();
        let mode = self.mode.read(cx).selected_value().cloned();
        let label = self
            .model_choices
            .iter()
            .find(|c| Some(&c.value) == selected.as_ref())
            .map(|c| c.label.to_string())
            .unwrap_or_else(|| "Model".into());
        let level_label = self
            .level_choices
            .iter()
            .find(|c| Some(&c.value) == level.as_ref())
            .map(|c| c.label.to_string())
            .unwrap_or_else(|| "Default".into());
        let label = if level_label.eq_ignore_ascii_case("default") {
            label
        } else {
            format!("{label} · {level_label}")
        };
        let mode_label = self
            .mode_choices
            .iter()
            .find(|c| Some(&c.value) == mode.as_ref())
            .map(|c| c.label.to_string())
            .unwrap_or_else(|| "Mode".into());
        let models = self.model_choices.clone();
        let levels = self.level_choices.clone();
        let modes = self.mode_choices.clone();
        let model_id = self.model_config.clone();
        let level_id = self.level_config.clone();
        let menu_state = self.model_menu.clone();
        let focus = menu_state.read(cx).focus_handle(cx);
        let weak = cx.weak_entity();
        let close = weak.clone();
        let confirm = weak.clone();
        let cancel = weak.clone();
        let level_owner = weak.clone();
        let mode_owner = weak.clone();
        Popover::new("composer-model-menu")
            .anchor(gpui_kit::Anchor::BottomLeft)
            .open(self.model_menu_open)
            .track_focus(&focus)
            .trigger(
                Button::new("composer-model-trigger")
                    .ghost()
                    .small()
                    .h(px(28.))
                    .child(
                        h_flex()
                            .gap_1()
                            .child(label.clone())
                            .child(Icon::new(IconName::ChevronDown).small()),
                    )
                    .accessibility_label(format!("Model and thinking: {label}"))
                    .tooltip("Model and thinking (⌘/)")
                    .disabled(disabled)
                    .on_click(cx.listener(|this, _, window, cx| this.focus_model(window, cx))),
            )
            .on_open_change(move |open, window, cx| {
                let _ = close.update(cx, |this, cx| {
                    this.model_menu_open = *open;
                    if *open {
                        this.model_menu.read(cx).focus_handle(cx).focus(window, cx);
                    } else {
                        this.input.read(cx).focus_handle(cx).focus(window, cx);
                    }
                    cx.notify();
                });
            })
            .content(move |_, _, _| {
                let confirm = confirm.clone();
                let cancel = cancel.clone();
                let model_id = model_id.clone();
                let level_owner = level_owner.clone();
                let mode_owner = mode_owner.clone();
                let levels = levels.clone();
                let level = level.clone();
                let level_id = level_id.clone();
                let modes = modes.clone();
                let mode = mode.clone();
                v_flex()
                    .w(px(320.))
                    .gap_1()
                    .child(
                        Command::new(&menu_state)
                            .searchable(true)
                            .placeholder("Search models")
                            .max_h(px(240.))
                            .items(models.iter().map(|choice| {
                                CommandItem::new()
                                    .label(choice.label.clone())
                                    .checked(Some(&choice.value) == selected.as_ref())
                            }))
                            .on_cancel(move |window, cx| {
                                let _ = cancel.update(cx, |this, cx| {
                                    this.model_menu_open = false;
                                    this.input.read(cx).focus_handle(cx).focus(window, cx);
                                    cx.notify();
                                });
                            })
                            .on_confirm(move |index, window, cx| {
                                let _ = confirm.update(cx, |this, cx| {
                                    if this.read_only
                                        || this.working
                                        || this.starting
                                        || this.configuring
                                    {
                                        return;
                                    }
                                    if let (Some(id), Some(choice)) =
                                        (&model_id, this.model_choices.get(index.row))
                                    {
                                        cx.emit(ComposerEvent::SetModel {
                                            config_id: id.clone(),
                                            value: choice.value.clone(),
                                        });
                                        this.model_menu_open = false;
                                        this.input.read(cx).focus_handle(cx).focus(window, cx);
                                        cx.notify();
                                    }
                                });
                            }),
                    )
                    .children((!levels.is_empty()).then(|| {
                        Button::new("model-thinking-settings")
                            .ghost()
                            .small()
                            .w_full()
                            .h(px(32.))
                            .child(
                                h_flex()
                                    .w_full()
                                    .justify_between()
                                    .child(format!("Thinking: {level_label}"))
                                    .child(Icon::new(IconName::ChevronRight).small()),
                            )
                            .accessibility_label("Thinking level")
                            .dropdown_menu(move |mut menu, _, _| {
                                for choice in &levels {
                                    let owner = level_owner.clone();
                                    let id = level_id.clone();
                                    let value = choice.value.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(choice.label.clone())
                                            .checked(Some(&value) == level.as_ref())
                                            .on_click(move |_, _, cx| {
                                                let _ = owner.update(cx, |this, cx| {
                                                    if this.read_only
                                                        || this.working
                                                        || this.starting
                                                        || this.configuring
                                                    {
                                                        return;
                                                    }
                                                    if let Some(id) = &id {
                                                        cx.emit(ComposerEvent::SetModel {
                                                            config_id: id.clone(),
                                                            value: value.clone(),
                                                        });
                                                    }
                                                });
                                            }),
                                    );
                                }
                                menu
                            })
                    }))
                    .children((!modes.is_empty()).then(|| {
                        Button::new("model-mode-settings")
                            .ghost()
                            .small()
                            .w_full()
                            .h(px(32.))
                            .child(
                                h_flex()
                                    .w_full()
                                    .justify_between()
                                    .child(format!("Mode: {mode_label}"))
                                    .child(Icon::new(IconName::ChevronRight).small()),
                            )
                            .accessibility_label("Mode")
                            .dropdown_menu(move |mut menu, _, _| {
                                for choice in &modes {
                                    let owner = mode_owner.clone();
                                    let value = choice.value.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(choice.label.clone())
                                            .checked(Some(&value) == mode.as_ref())
                                            .on_click(move |_, _, cx| {
                                                let _ = owner.update(cx, |this, cx| {
                                                    if this.read_only
                                                        || this.working
                                                        || this.starting
                                                        || this.configuring
                                                    {
                                                        return;
                                                    }
                                                    cx.emit(ComposerEvent::SetMode(value.clone()));
                                                });
                                            }),
                                    );
                                }
                                menu
                            })
                    }))
            })
    }

    fn render_intent_check(&self, on: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let (label, tooltip) = composer_model::intent_check_text(on);
        Button::new("intent-check")
            .ghost()
            .small()
            .h(px(28.))
            .label(label)
            .accessibility_label(label)
            .toggled(on)
            .tooltip(tooltip)
            .disabled(self.intent_check_pending)
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.intent_check_pending {
                    cx.emit(ComposerEvent::SetIntentCheck(!on));
                }
            }))
    }

    pub fn text(&self, cx: &gpui_kit::App) -> String {
        self.input.read(cx).value().to_string()
    }
    pub fn set_text(&self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value(text.to_string(), window, cx)
        });
    }
    pub fn add_mention(&mut self, path: &str, cx: &mut Context<Self>) {
        if !self.read_only && !self.sending && !self.mentions.iter().any(|m| m.path == path) {
            self.mentions.push(p::Mention { path: path.into() });
            cx.notify();
        }
    }
    pub fn add_attachment(&mut self, id: String, name: String, cx: &mut Context<Self>) {
        self.attachments.push((id, name));
        cx.notify();
    }
    fn has_content(&self, cx: &Context<Self>) -> bool {
        !self.text(cx).trim().is_empty() || !self.attachments.is_empty() || self.review_count > 0
    }
    pub fn prompt(&self, text: &str) -> p::TurnPrompt {
        p::TurnPrompt {
            text: text.into(),
            mentions: self.mentions.clone(),
            attachment_ids: self.attachments.iter().map(|(id, _)| id.clone()).collect(),
            review_comment_ids: vec![],
        }
    }
    pub fn clear_sent(
        &mut self,
        sent: &p::TurnPrompt,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.text(cx) == sent.text && self.mentions == sent.mentions {
            self.set_text("", window, cx);
            self.mentions.clear();
            self.attachments
                .retain(|(id, _)| !sent.attachment_ids.contains(id));
            cx.emit(ComposerEvent::Change(String::new()));
        }
    }
    pub fn set_attached_agents(&mut self, handles: Vec<String>, cx: &mut Context<Self>) {
        self.attached_agents = handles.into_iter().map(|h| format!("@{h}")).collect();
        cx.notify();
    }
    pub fn set_agents(&mut self, agents: Vec<p::AgentSummary>, cx: &mut Context<Self>) {
        self.agents = agents
            .into_iter()
            .map(|r| format!("@{}", r.handle))
            .collect();
        cx.notify();
    }
    pub fn set_files(&mut self, result: Result<Vec<String>, String>, cx: &mut Context<Self>) {
        self.files_loading = false;
        match result {
            Ok(paths) => {
                self.files = Some(paths);
                self.files_error = None;
                self.files_loaded = Some(std::time::Instant::now());
            }
            Err(error) => self.files_error = Some(error),
        }
        cx.notify();
    }
    fn load_files(&mut self, cx: &mut Context<Self>) {
        if self.files_loading {
            return;
        }
        self.files_loading = true;
        self.files_error = None;
        cx.emit(ComposerEvent::LoadFiles);
        cx.notify();
    }
    fn file_rows(&self, cx: &gpui_kit::App) -> Vec<String> {
        let input = self.input.read(cx);
        composer_model::mention_query(input.value().as_ref(), input.cursor())
            .map(|(_, query)| {
                let attached: Vec<_> = self
                    .agents
                    .iter()
                    .filter(|h| self.attached_agents.contains(*h))
                    .cloned()
                    .collect();
                let rest: Vec<_> = self
                    .agents
                    .iter()
                    .filter(|h| !self.attached_agents.contains(*h))
                    .cloned()
                    .collect();
                let mut matches = composer_model::file_matches(&attached, query);
                matches.extend(composer_model::file_matches(&rest, query));
                matches.extend(composer_model::file_matches(
                    self.files.as_deref().unwrap_or_default(),
                    query,
                ));
                matches
            })
            .unwrap_or_default()
    }
    fn mention_open(&self, cx: &gpui_kit::App) -> bool {
        let input = self.input.read(cx);
        !self.read_only
            && !self.sending
            && !self.command_dismissed
            && composer_model::mention_query(input.value().as_ref(), input.cursor()).is_some()
    }
    fn picker_count(&self, cx: &gpui_kit::App) -> usize {
        if self.mention_open(cx) {
            self.file_rows(cx).len()
        } else {
            self.command_rows(cx).len()
        }
    }
    fn pick_file(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if !self.mention_open(cx) {
            return;
        }
        let Some(path) = self.file_rows(cx).get(index).cloned() else {
            return;
        };
        let input = self.input.read(cx);
        let caret = input.cursor();
        let text = input.value().to_string();
        let Some((start, _)) = composer_model::mention_query(&text, caret) else {
            return;
        };
        if self.agents.contains(&path) {
            if text.trim_start().starts_with("/agent ") {
                return;
            }
            self.set_text(
                &format!(
                    "/agent {} {}{}",
                    path.trim_start_matches('@'),
                    &text[..start],
                    &text[caret..]
                ),
                window,
                cx,
            );
            self.command_dismissed = true;
            cx.emit(ComposerEvent::Change(self.text(cx)));
            cx.notify();
            return;
        }
        self.add_mention(&path, cx);
        let prefix = &text[..start];
        let line = prefix.chars().filter(|c| *c == '\n').count() as u32;
        let col = prefix
            .rsplit('\n')
            .next()
            .unwrap_or_default()
            .chars()
            .count() as u32;
        self.set_text(&format!("{prefix}{}", &text[caret..]), window, cx);
        self.input.update(cx, |i, cx| {
            i.set_cursor_position(gpui_kit::base::input::Position::new(line, col), window, cx)
        });
        self.command_dismissed = true;
        cx.emit(ComposerEvent::Change(self.text(cx)));
        cx.notify();
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| input.focus(window, cx));
    }

    fn command_rows(&self, cx: &gpui_kit::App) -> Vec<SlashEntry> {
        if self.read_only || self.sending || self.command_dismissed {
            return vec![];
        }
        let input = self.input.read(cx);
        composer_model::slash_query(input.value().as_ref(), input.cursor())
            .map(|query| {
                composer_model::slash_entries(
                    &self.commands,
                    self.plan_available && !self.working && !self.starting && !self.configuring,
                    query,
                )
            })
            .unwrap_or_default()
    }

    fn pick_command(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(entry) = self.command_rows(cx).get(index).cloned() else {
            return;
        };
        let input = self.input.read(cx);
        let suffix = input.value().as_ref()[input.cursor()..].to_string();
        let insert = if entry.plan {
            String::new()
        } else {
            format!("/{} ", entry.name)
        };
        let caret = insert.chars().count() as u32;
        self.set_text(&format!("{insert}{suffix}"), window, cx);
        self.input.update(cx, |input, cx| {
            input.set_cursor_position(gpui_kit::base::input::Position::new(0, caret), window, cx)
        });
        self.command_dismissed = true;
        cx.emit(ComposerEvent::Change(self.text(cx)));
        if entry.plan {
            cx.emit(ComposerEvent::TogglePlanMode);
        }
        cx.notify();
    }

    fn send(&mut self, _: &Send, window: &mut Window, cx: &mut Context<Self>) {
        if self.mention_open(cx) {
            self.pick_file(self.command_selected, window, cx);
            return;
        }
        if !self.command_rows(cx).is_empty() {
            self.pick_command(self.command_selected, window, cx);
            return;
        }
        self.submit(window, cx);
    }

    fn submit(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().to_string();
        if self.read_only || self.sending || self.uploading || !self.has_content(cx) {
            return;
        }
        cx.emit(ComposerEvent::Send(text));
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let input = self.input.read(cx);
        let query = composer_model::slash_query(input.value().as_ref(), input.cursor())
            .map(|q| format!("slash:{q}"))
            .or_else(|| {
                composer_model::mention_query(input.value().as_ref(), input.cursor())
                    .map(|(start, q)| format!("mention:{start}:{q}"))
            });
        if query != self.command_query {
            if query.is_none() {
                self.command_dismissed = false;
            }
            self.command_selected = 0;
            self.command_query = query;
        }
        let mention_open = self.mention_open(cx);
        if mention_open
            && !self.files_loading
            && self.files_error.is_none()
            && (self.files.is_none()
                || self
                    .files_loaded
                    .is_some_and(|at| at.elapsed().as_secs() >= 30))
        {
            self.load_files(cx);
        }
        let file_rows = self.file_rows(cx);
        self.command_selected = self
            .command_selected
            .min(self.picker_count(cx).saturating_sub(1));
        let status = if self.files_loading {
            "Loading files".to_string()
        } else if let Some(error) = &self.files_error {
            error.clone()
        } else {
            "No matching files.".into()
        };
        self.file_menu.update(cx, |menu, cx| {
            if menu.delegate().paths != file_rows || menu.delegate().status != status {
                menu.delegate_mut().paths = file_rows;
                menu.delegate_mut().status = status;
                cx.notify();
            }
            menu.set_selected_index(Some(IndexPath::new(self.command_selected)), window, cx);
        });
        let rows = self.command_rows(cx);
        self.command_selected = self
            .command_selected
            .min(self.picker_count(cx).saturating_sub(1));
        self.command_menu.update(cx, |menu, cx| {
            if menu.matched_count() == 0 {
                return;
            }
            menu.set_selected_index(Some(IndexPath::new(self.command_selected)), window, cx)
        });
        let mut field = div();
        if !rows.is_empty() || mention_open {
            field = field.key_context("ComposerPicker");
        }
        let field = field.child(
            composer_parts::input(&self.input, "Message")
                .pr(px(80.))
                .on_paste({
                    let weak = cx.weak_entity();
                    move |item, _, cx| {
                        let paths: Vec<_> = item
                            .entries()
                            .iter()
                            .flat_map(|entry| match entry {
                                gpui_kit::ClipboardEntry::ExternalPaths(p) => p.0.to_vec(),
                                _ => vec![],
                            })
                            .collect();
                        if paths.is_empty() {
                            if let Some(image) = item.entries().iter().find_map(|e| match e {
                                gpui_kit::ClipboardEntry::Image(i) => Some(i.clone()),
                                _ => None,
                            }) {
                                let _ = weak
                                    .update(cx, |_, cx| cx.emit(ComposerEvent::AttachImage(image)));
                                true
                            } else {
                                false
                            }
                        } else {
                            let _ = weak.update(cx, |_, cx| cx.emit(ComposerEvent::Attach(paths)));
                            true
                        }
                    }
                })
                .disabled(self.read_only || self.sending),
        );
        let list = self.file_menu.clone();
        let retry = self.files_error.is_some();
        let weak_picker = cx.weak_entity();
        let weak_retry = weak_picker.clone();
        let input_focus = self.input.read(cx).focus_handle(cx);
        let field = Popover::new("mention-picker")
            .open(mention_open)
            .track_focus(&input_focus)
            .trigger(MentionTrigger(field))
            .on_open_change(move |open, _, cx| {
                if !*open {
                    let _ = weak_picker.update(cx, |this, cx| {
                        this.command_dismissed = true;
                        cx.notify();
                    });
                }
            })
            .content(move |_, _, _| {
                v_flex()
                    .w(gpui_kit::px(400.))
                    .max_h(gpui_kit::px(220.))
                    .child(List::new(&list).max_h(gpui_kit::px(180.)))
                    .children(retry.then(|| {
                        Button::new("retry-files").label("Retry").on_click({
                            let weak = weak_retry.clone();
                            move |_, _, cx| {
                                let _ = weak.update(cx, |this, cx| this.load_files(cx));
                            }
                        })
                    }))
            });
        let weak = cx.weak_entity();
        let selection = weak.clone();
        let menu = (!rows.is_empty()).then(|| {
            Command::new(&self.command_menu)
                .searchable(false)
                .filterable(false)
                .max_h(gpui_kit::px(220.))
                .items(rows.into_iter().map(|entry| {
                    CommandItem::new()
                        .label(format!("/{}", entry.name))
                        .child(move |_, cx| {
                            v_flex().child(format!("/{}", entry.name)).child(
                                div()
                                    .text_sm()
                                    .text_color(super::tokens::color(
                                        super::tokens::Token::MutedForeground,
                                        cx,
                                    ))
                                    .child(entry.description.clone()),
                            )
                        })
                }))
                .on_select(move |index, _, cx| {
                    let _ = selection.update(cx, |this, cx| {
                        if this.command_selected != index.row && !this.command_rows(cx).is_empty() {
                            this.command_selected = index.row;
                            cx.notify();
                        }
                    });
                })
                .on_confirm(move |index, window, cx| {
                    let _ = weak.update(cx, |this, cx| this.pick_command(index.row, window, cx));
                })
        });
        composer_parts::surface(cx)
            .key_context(COMPOSER)
            .on_action(cx.listener(|_, _: &crate::actions::AttachFile, _, cx| {
                cx.emit(ComposerEvent::Attach(vec![]))
            }))
            .on_drop(cx.listener(|_, paths: &gpui_kit::ExternalPaths, _, cx| {
                cx.emit(ComposerEvent::Attach(paths.0.to_vec()))
            }))
            .on_action(cx.listener(|this, _: &NextComposerChoice, _, cx| {
                let len = this.picker_count(cx);
                if len > 0 {
                    this.command_selected = (this.command_selected + 1) % len;
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &PreviousComposerChoice, _, cx| {
                let len = this.picker_count(cx);
                if len > 0 {
                    this.command_selected = (this.command_selected + len - 1) % len;
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &DismissComposerChoice, _, cx| {
                this.command_dismissed = true;
                cx.notify();
            }))
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(|_, _: &StopTurn, _, cx| cx.emit(ComposerEvent::Stop)))
            .on_action(
                cx.listener(|_, _: &TogglePlanMode, _, cx| cx.emit(ComposerEvent::TogglePlanMode)),
            )
            .w_full()
            .mb_4()
            .flex_shrink_0()
            .children(
                self.profile_notice
                    .clone()
                    .filter(|_| !self.notice_dismissed)
                    .map(|text| {
                        h_flex()
                            .gap_2()
                            .child(div().flex_1().text_sm().child(text))
                            .child(
                                Button::new("dismiss-profile-notice")
                                    .label("Dismiss")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.notice_dismissed = true;
                                        cx.notify();
                                    })),
                            )
                    }),
            )
            .children(self.attachments.iter().enumerate().map(|(ix, (id, name))| {
                let id = id.clone();
                Button::new(("attachment", ix))
                    .label(name.clone())
                    .tooltip("Remove attachment")
                    .disabled(self.sending)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.attachments.retain(|(a, _)| a != &id);
                        cx.notify();
                    }))
            }))
            .children((self.review_count > 0).then(|| {
                Button::new("review-context")
                    .label(composer_model::review_chip_label(self.review_count))
                    .tooltip("Remove review comments")
                    .accessibility_label(format!(
                        "{}. Remove",
                        composer_model::review_chip_label(self.review_count)
                    ))
                    .disabled(self.sending)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(ComposerEvent::ClearReview)))
            }))
            .children(self.uploading.then(|| div().child("Uploading attachment…")))
            .children(menu)
            .children((!self.mentions.is_empty()).then(|| {
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .children(self.mentions.iter().enumerate().map(|(index, mention)| {
                        let path = mention.path.clone();
                        Button::new(("mention", index))
                            .label(mention.path.clone())
                            .tooltip("Remove mention")
                            .disabled(self.read_only || self.sending)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.mentions.retain(|m| m.path != path);
                                cx.notify();
                            }))
                    }))
            }))
            .children(
                self.text(cx)
                    .trim_start()
                    .strip_prefix("/agent ")
                    .and_then(|rest| rest.split_whitespace().next())
                    .map(|name| {
                        Button::new("role-chip")
                            .ghost()
                            .label(format!("@{name}"))
                            .tooltip("Remove agent")
                            .on_click(cx.listener(|this, _, window, cx| {
                                let text = this.text(cx);
                                let rest = text
                                    .trim_start()
                                    .strip_prefix("/agent ")
                                    .unwrap_or_default();
                                let request = rest
                                    .split_once(char::is_whitespace)
                                    .map(|(_, text)| text)
                                    .unwrap_or_default();
                                this.set_text(request, window, cx);
                                cx.emit(ComposerEvent::Change(this.text(cx)));
                            }))
                    }),
            )
            .child(field)
            .child(
                composer_parts::toolbar()
                    .children((!self.model_choices.is_empty()).then(|| self.render_model_menu(cx)))
                    .children(self.intent_check.map(|on| self.render_intent_check(on, cx)))
                    .child(div().flex_1())
                    .children(
                        self.usage
                            .map(|(used, size)| self.render_context_usage(used, size, cx)),
                    )
                    .child(
                        Button::new("attach-file")
                            .ghost()
                            .small()
                            .size(px(super::tokens::ICON_BUTTON))
                            .icon(IconName::Plus)
                            .accessibility_label("Attach file")
                            .tooltip("Attach file (⌘U)")
                            .disabled(self.read_only || self.uploading || self.sending)
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(ComposerEvent::Attach(vec![]))),
                            ),
                    )
                    .child(
                        Button::new("send-prompt")
                            .primary()
                            .icon(IconName::ArrowUp)
                            .small()
                            .accessibility_label(if self.working { "Queue" } else { "Send" })
                            .w(px(28.))
                            .h(px(super::tokens::ICON_BUTTON))
                            .rounded(px(8.))
                            .disabled(
                                self.read_only
                                    || self.sending
                                    || self.uploading
                                    || !self.has_content(cx),
                            )
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    )
                    .children(self.working.then(|| {
                        Button::new("stop-turn")
                            .label(if self.run_running {
                                "Cancel run"
                            } else {
                                "Stop"
                            })
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(ComposerEvent::Stop)))
                    }))
                    .children((self.working && self.steering).then(|| {
                        Button::new("steer-prompt")
                            .label("Send now")
                            .disabled(
                                self.read_only
                                    || self.sending
                                    || self.uploading
                                    || !self.has_content(cx),
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                if !this.read_only && !this.sending {
                                    let text = this.text(cx);
                                    if !this.uploading && this.has_content(cx) {
                                        cx.emit(ComposerEvent::Steer(text));
                                    }
                                }
                            }))
                    })),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{TestAppContext, test::TestWindowExt as _};
    use std::cell::RefCell;
    use std::rc::Rc;

    #[gpui_kit::test]
    fn mention_picker_loads_once_keeps_suffix_and_retains_failed_prompts(cx: &mut TestAppContext) {
        let events = Rc::new(RefCell::new(Vec::new()));
        let log = events.clone();
        let (window, composer, subscription) = cx.update(|cx| {
            gpui_kit::init(cx);
            crate::keymap::bind(cx);
            let (window, composer) = gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| Composer::new(window, cx))
            })
            .unwrap();
            let subscription = cx.subscribe(&composer, move |_, event: &ComposerEvent, _| {
                log.borrow_mut().push(match event {
                    ComposerEvent::LoadFiles => "load",
                    ComposerEvent::Send(_) => "send",
                    ComposerEvent::Stop => "stop",
                    _ => "other",
                });
            });
            (window, composer, subscription)
        });
        let draft = "Ask é @sr tail";
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                c.set_text(draft, window, cx);
                c.input.update(cx, |i, cx| {
                    i.set_cursor_position(gpui_kit::base::input::Position::new(0, 9), window, cx)
                });
            });
            window.render_frame(cx);
            window.press("enter", cx);
            window.render_frame(cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(events.borrow().iter().filter(|e| **e == "load").count(), 1);
        assert!(!events.borrow().contains(&"send"));
        composer.read_with(cx, |c, cx| assert_eq!(c.text(cx), draft));
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                c.set_files(Err("Could not load files".into()), cx);
            });
            window.render_frame(cx);
            composer.update(cx, |c, cx| {
                assert_eq!(c.files_error.as_deref(), Some("Could not load files"));
                c.load_files(cx);
                c.set_files(Ok(vec!["src/main.rs".into(), "README.md".into()]), cx);
            });
            window.render_frame(cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        composer.read_with(cx, |c, cx| {
            assert_eq!(c.text(cx), "Ask é  tail");
            assert_eq!(
                c.prompt(&c.text(cx)).mentions,
                vec![p::Mention {
                    path: "src/main.rs".into()
                }]
            );
        });
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                c.add_mention("src/main.rs", cx);
                let sent = c.prompt(&c.text(cx));
                assert_eq!(sent.mentions.len(), 1);
                c.set_text("Newer draft", window, cx);
                c.clear_sent(&sent, window, cx);
                assert_eq!(c.text(cx), "Newer draft");
                assert_eq!(c.mentions, sent.mentions);
                c.clear_sent(&c.prompt("Newer draft"), window, cx);
                assert!(c.mentions.is_empty());
                assert!(c.text(cx).is_empty());
            });
        })
        .unwrap();
        drop(subscription);
    }

    #[gpui_kit::test]
    fn slash_keyboard_selects_before_sending_and_escape_does_not_stop(cx: &mut TestAppContext) {
        let events = Rc::new(RefCell::new(Vec::new()));
        let log = events.clone();
        let (window, composer, subscription) = cx.update(|cx| {
            gpui_kit::init(cx);
            crate::keymap::bind(cx);
            let (window, composer) = gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| Composer::new(window, cx))
            })
            .unwrap();
            let subscription = cx.subscribe(&composer, move |_, event: &ComposerEvent, _| {
                log.borrow_mut().push(match event {
                    ComposerEvent::Send(_) => "send",
                    ComposerEvent::Stop => "stop",
                    ComposerEvent::TogglePlanMode => "plan",
                    _ => "other",
                });
            });
            (window, composer, subscription)
        });
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                c.commands = ["compact", "review"]
                    .into_iter()
                    .map(|name| p::AvailableCommand {
                        name: name.into(),
                        description: None,
                        input: None,
                    })
                    .collect();
                c.set_text("/ later", window, cx);
                c.input.update(cx, |i, cx| {
                    i.set_cursor_position(gpui_kit::base::input::Position::new(0, 1), window, cx)
                });
            });
            window.render_frame(cx);
            window.press("down", cx);
            window.render_frame(cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        composer.read_with(cx, |c, cx| assert_eq!(c.text(cx), "/review  later"));
        assert!(!events.borrow().contains(&"send"));
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert!(events.borrow().contains(&"send"));
        events.borrow_mut().clear();
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                c.set_text("/", window, cx);
                c.input.update(cx, |i, cx| {
                    i.set_cursor_position(gpui_kit::base::input::Position::new(0, 1), window, cx)
                });
            });
            window.render_frame(cx);
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert!(!events.borrow().contains(&"stop"));
        composer.read_with(cx, |c, cx| {
            assert!(c.command_dismissed);
            assert_eq!(c.text(cx), "/");
        });
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                c.command_dismissed = false;
                c.plan_available = true;
                c.pick_command(0, window, cx);
            });
        })
        .unwrap();
        cx.run_until_parked();
        composer.read_with(cx, |c, cx| assert_eq!(c.text(cx), ""));
        assert!(events.borrow().contains(&"plan"));
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert!(events.borrow().contains(&"stop"));
        drop(subscription);
    }

    #[gpui_kit::test]
    fn grouped_model_choices_keep_ids_and_busy_controls_cannot_emit_changes(
        cx: &mut TestAppContext,
    ) {
        let mut state = tempo_client::state::workspace::WorkspaceState::new();
        for line in include_str!(
            "../../../../packages/protocol/fixtures/channel/workspace-first-load.jsonl"
        )
        .lines()
        {
            state.apply(serde_json::from_str(line).unwrap());
        }
        let mut session = state.sessions.values().next().unwrap().clone();
        session.status = p::SessionStatus::Idle;
        session.config_options = vec![serde_json::from_value(serde_json::json!({
            "id": "agent-model", "name": "Model", "type": "select", "category": "model", "currentValue": "a",
            "options": [{"group":"provider", "name":"Provider", "options":[{"value":"a", "name":"Fast"}, {"value":"b", "name":"Careful"}]}]
        })).unwrap()];
        let events = Rc::new(RefCell::new(Vec::new()));
        let log = events.clone();
        let (window, composer, subscription) = cx.update(|cx| {
            gpui_kit::init(cx);
            let (window, composer) = gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| Composer::new(window, cx))
            })
            .unwrap();
            let subscription = cx.subscribe(&composer, move |_, event: &ComposerEvent, _| {
                if let ComposerEvent::SetModel { config_id, value } = event {
                    log.borrow_mut().push((config_id.clone(), value.clone()));
                }
            });
            (window, composer, subscription)
        });
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                c.sync_session(&session, window, cx);
                assert_eq!(
                    c.model.read(cx).selected_value().map(String::as_str),
                    Some("a")
                );
                assert_eq!(c.model_choices[1].label.as_ref(), "Provider · Careful");
                c.model.update(cx, |_, cx| {
                    cx.emit(SelectEvent::<Vec<Choice>>::Confirm(Some("b".into())))
                });
            })
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(&*events.borrow(), &[("agent-model".into(), "b".into())]);
        for read_only in [false, true] {
            composer.update(cx, |c, cx| {
                c.working = !read_only;
                c.read_only = read_only;
                c.model.update(cx, |_, cx| {
                    cx.emit(SelectEvent::<Vec<Choice>>::Confirm(Some("a".into())))
                });
            });
            cx.run_until_parked();
        }
        composer.update(cx, |c, cx| {
            c.working = false;
            c.read_only = false;
            c.starting = true;
            c.model.update(cx, |_, cx| {
                cx.emit(SelectEvent::<Vec<Choice>>::Confirm(Some("a".into())))
            });
        });
        cx.run_until_parked();
        assert_eq!(events.borrow().len(), 1);
        drop(subscription);
    }
}

#[cfg(test)]
mod attachment_tests {
    use super::*;
    use gpui_kit::TestAppContext;
    use std::{cell::RefCell, rc::Rc};

    #[gpui_kit::test]
    fn attachment_and_review_only_prompts_wait_for_upload_and_keep_failed_context(
        cx: &mut TestAppContext,
    ) {
        let sends = Rc::new(RefCell::new(vec![]));
        let log = sends.clone();
        let (window, composer, _subscription) = cx.update(|cx| {
            gpui_kit::init(cx);
            let (window, composer) = gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| Composer::new(window, cx))
            })
            .unwrap();
            let subscription = cx.subscribe(&composer, move |_, event: &ComposerEvent, _| {
                if let ComposerEvent::Send(text) = event {
                    log.borrow_mut().push(text.clone());
                }
            });
            (window, composer, subscription)
        });
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                c.submit(window, cx);
                c.add_attachment("a1".into(), "image.png".into(), cx);
                c.uploading = true;
                c.submit(window, cx);
                c.uploading = false;
                c.submit(window, cx);
                assert_eq!(c.prompt("").attachment_ids, ["a1"]);
                c.clear_sent(&c.prompt(""), window, cx);
                c.review_count = 2;
                c.submit(window, cx);
                c.read_only = true;
                c.submit(window, cx);
            })
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(*sends.borrow(), vec![String::new(), String::new()]);
    }
    #[gpui_kit::test]
    fn agent_picker_inserts_one_request_and_no_file_mention(cx: &mut TestAppContext) {
        let (window, composer) = cx.update(|cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| Composer::new(window, cx))
            })
            .unwrap()
        });
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |c, cx| {
                let agent: p::AgentSummary = serde_json::from_str(
                    include_str!("../../../../packages/protocol/fixtures/types/AgentSummary.jsonl")
                        .lines()
                        .next()
                        .unwrap(),
                )
                .unwrap();
                c.set_agents(vec![agent], cx);
                c.set_files(Ok(vec!["reviewer.md".into()]), cx);
                c.set_text("@rev focus on auth", window, cx);
                c.input.update(cx, |i, cx| {
                    i.set_cursor_position(gpui_kit::base::input::Position::new(0, 4), window, cx)
                });
                assert_eq!(c.file_rows(cx)[0], "@reviewer");
                c.pick_file(0, window, cx);
                assert_eq!(c.text(cx), "/agent reviewer  focus on auth");
                assert!(c.prompt(&c.text(cx)).mentions.is_empty());
            })
        })
        .unwrap();
    }
}
