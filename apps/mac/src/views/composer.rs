//! Composer (04, Composer; 07): a GPUI Kit `Textarea` that grows from 1 to 12 rows, in the
//! `Composer` key context. Enter sends, ⇧Enter adds a line (the text field's own binding), Esc
//! stops the turn, ⇧Tab toggles plan mode. Pickers use agent-reported modes and models.
use crate::actions::{Send, StopTurn, TogglePlanMode};
use crate::keymap::COMPOSER;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::select::{Select, SelectEvent, SelectItem, SelectState};
use gpui_kit::component::v_flex;
use gpui_kit::component::{Disableable as _, h_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Subscription, Window,
};
use tempo_protocol as p;

#[derive(Clone, Debug, PartialEq)]
struct Choice {
    value: String,
    label: SharedString,
}
impl SelectItem for Choice {
    type Value = String;
    fn title(&self) -> SharedString {
        self.label.clone()
    }
    fn value(&self) -> &String {
        &self.value
    }
}
type Picker = SelectState<Vec<Choice>>;

pub enum ComposerEvent {
    Send(String),
    Steer(String),
    Change(String),
    Stop,
    TogglePlanMode,
    SetMode(String),
    SetModel { config_id: String, value: String },
}

pub struct Composer {
    input: Entity<TextareaState>,
    pub read_only: bool,
    pub sending: bool,
    pub working: bool,
    pub starting: bool,
    pub steering: bool,
    model: Entity<Picker>,
    mode: Entity<Picker>,
    model_config: Option<String>,
    model_choices: Vec<Choice>,
    mode_choices: Vec<Choice>,
    pub configuring: bool,
    _picker_events: Vec<Subscription>,
    _input_changed: Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Composer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 12));
        let changed = cx.subscribe(&input, |_, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.emit(ComposerEvent::Change(input.read(cx).value().to_string()));
            }
            cx.notify();
        });
        let model =
            cx.new(|cx| SelectState::new(Vec::<Choice>::new(), None, window, cx).searchable(true));
        let mode = cx.new(|cx| SelectState::new(Vec::<Choice>::new(), None, window, cx));
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
            read_only: false,
            sending: false,
            working: false,
            starting: false,
            steering: false,
            model,
            mode,
            model_config: None,
            model_choices: vec![],
            mode_choices: vec![],
            configuring: false,
            _picker_events: vec![model_events, mode_events],
            _input_changed: changed,
        }
    }

    pub fn sync_session(
        &mut self,
        session: &p::Session,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.starting = session.status == p::SessionStatus::Starting;
        let config = session
            .config_options
            .iter()
            .find(|c| c.category.as_deref() == Some("model") && c.type_ == "select");
        self.model_config = config.map(|c| c.id.clone());
        let choices: Vec<_> = config
            .and_then(|c| c.options.as_ref())
            .into_iter()
            .flatten()
            .flat_map(|option| match option {
                p::ConfigOptionOptionsItem::Option(option) => vec![Choice {
                    value: option.value.clone(),
                    label: option.name.clone().into(),
                }],
                p::ConfigOptionOptionsItem::Group(group) => group
                    .options
                    .iter()
                    .map(|option| Choice {
                        value: option.value.clone(),
                        label: format!("{} · {}", group.name, option.name).into(),
                    })
                    .collect(),
            })
            .collect();
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
        let choices: Vec<_> = session
            .modes
            .iter()
            .map(|mode| Choice {
                value: mode.id.clone(),
                label: mode.name.clone().into(),
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

    pub fn focus_model(&self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.model_choices.is_empty()
            && !self.read_only
            && !self.working
            && !self.starting
            && !self.configuring
        {
            self.model.update(cx, |state, cx| state.focus(window, cx));
            window.dispatch_action(Box::new(gpui_kit::base::actions::SelectDown), cx);
        }
    }

    pub fn text(&self, cx: &gpui_kit::App) -> String {
        self.input.read(cx).value().to_string()
    }
    pub fn set_text(&self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value(text.to_string(), window, cx)
        });
    }
    pub fn clear_sent(&self, sent: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.text(cx) == sent {
            self.set_text("", window, cx);
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| input.focus(window, cx));
    }

    fn send(&mut self, _: &Send, _: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().to_string();
        if self.read_only || self.sending || text.trim().is_empty() {
            return;
        }
        cx.emit(ComposerEvent::Send(text));
    }
}

impl Render for Composer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .key_context(COMPOSER)
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(|_, _: &StopTurn, _, cx| cx.emit(ComposerEvent::Stop)))
            .on_action(
                cx.listener(|_, _: &TogglePlanMode, _, cx| cx.emit(ComposerEvent::TogglePlanMode)),
            )
            .p_3()
            .child(
                Textarea::new(&self.input)
                    .aria_label("Message")
                    .disabled(self.read_only || self.sending),
            )
            .child(
                h_flex()
                    .gap_2()
                    .children((!self.model_choices.is_empty()).then(|| {
                        Select::new(&self.model)
                            .accessibility_label("Model")
                            .placeholder("Model")
                            .disabled(
                                self.read_only || self.working || self.starting || self.configuring,
                            )
                    }))
                    .children((!self.mode_choices.is_empty()).then(|| {
                        Select::new(&self.mode)
                            .accessibility_label("Mode")
                            .placeholder("Mode")
                            .disabled(
                                self.read_only || self.working || self.starting || self.configuring,
                            )
                    }))
                    .child(
                        Button::new("send-prompt")
                            .primary()
                            .label(if self.working { "Queue" } else { "Send" })
                            .disabled(
                                self.read_only || self.sending || self.text(cx).trim().is_empty(),
                            )
                            .on_click(
                                cx.listener(|this, _, window, cx| this.send(&Send, window, cx)),
                            ),
                    )
                    .children(self.working.then(|| {
                        Button::new("stop-turn")
                            .label("Stop")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(ComposerEvent::Stop)))
                    }))
                    .children((self.working && self.steering).then(|| {
                        Button::new("steer-prompt")
                            .label("Send now")
                            .disabled(
                                self.read_only || self.sending || self.text(cx).trim().is_empty(),
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                if !this.read_only && !this.sending {
                                    let text = this.text(cx);
                                    if !text.trim().is_empty() {
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
    use gpui_kit::TestAppContext;
    use std::cell::RefCell;
    use std::rc::Rc;

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
