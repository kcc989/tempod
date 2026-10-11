//! Composer (04, Composer; 07): a GPUI Kit `Textarea` that grows from 1 to 12 rows, in the
//! `Composer` key context. Enter sends, ⇧Enter adds a line (the text field's own binding), Esc
//! stops the turn, ⇧Tab toggles plan mode. Pickers, attachments, `@` and `/` come in M2.
use crate::actions::{Send, StopTurn, TogglePlanMode};
use crate::keymap::COMPOSER;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::v_flex;
use gpui_kit::component::{Disableable as _, h_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Styled as _, Subscription, Window,
};

pub enum ComposerEvent {
    Send(String),
    Steer(String),
    Change(String),
    Stop,
    TogglePlanMode,
}

pub struct Composer {
    input: Entity<TextareaState>,
    pub read_only: bool,
    pub sending: bool,
    pub working: bool,
    pub steering: bool,
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
        Self {
            input,
            read_only: false,
            sending: false,
            working: false,
            steering: false,
            _input_changed: changed,
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
