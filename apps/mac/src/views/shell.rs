//! Settings → Shell (04; 07): the owner's shell files, a file list and a monospace editor.
use super::shell_model::{self as model, ShellDraft};
use super::tokens::{ICON_BUTTON, Token, color};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Editor, EditorState, Input, InputEvent, InputState};
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Selectable as _, Sizable as _, h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Role, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Window, div, px,
};
use tempo_client::{ApiError, Client};
use tempo_protocol::{self as p, api};

struct Problem {
    text: String,
    reload: bool,
}

pub struct ShellPage {
    client: Option<Client>,
    draft: Option<ShellDraft>,
    editor: Entity<EditorState>,
    new_path: Entity<InputState>,
    adding: bool,
    add_error: Option<String>,
    pending: bool,
    load_error: Option<String>,
    problem: Option<Problem>,
    _subscriptions: [Subscription; 2],
}

impl ShellPage {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let client = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client());
        let editor = cx.new(|cx| EditorState::new(window, cx));
        let new_path =
            cx.new(|cx| InputState::new(window, cx).placeholder(model::PATH_PLACEHOLDER));
        let edited = cx.subscribe(&editor, |this, editor, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let content = editor.read(cx).value().to_string();
                if let Some(draft) = this.draft.as_mut()
                    && let Some(path) = draft.current().map(|f| f.path.clone())
                {
                    draft.set_content(&path, &content);
                }
                cx.notify();
            }
        });
        let typed = cx.subscribe_in(
            &new_path,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } => this.add(window, cx),
                InputEvent::Change => {
                    this.add_error = None;
                    cx.notify();
                }
                _ => {}
            },
        );
        let mut this = Self {
            client,
            draft: None,
            editor,
            new_path,
            adding: false,
            add_error: None,
            pending: false,
            load_error: None,
            problem: None,
            _subscriptions: [edited, typed],
        };
        this.load(window, cx);
        this
    }

    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        self.pending = true;
        let request = client.call::<api::GetDotfiles>(p::Empty {});
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(state) => {
                        this.load_error = None;
                        this.problem = None;
                        this.show(&state, window, cx);
                    }
                    Err(e) => this.load_error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn show(&mut self, state: &p::GetDotfilesOut, window: &mut Window, cx: &mut Context<Self>) {
        let selected = self
            .draft
            .as_ref()
            .and_then(|d| d.current().map(|f| f.path.clone()));
        self.draft = Some(ShellDraft::from_state(state, selected.as_deref()));
        self.sync_editor(window, cx);
    }

    fn sync_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let content = self
            .draft
            .as_ref()
            .and_then(|d| d.current().map(|f| f.content.clone()))
            .unwrap_or_default();
        self.editor
            .update(cx, |e, cx| e.set_value(content, window, cx));
        cx.notify();
    }

    fn edit(
        &mut self,
        change: impl FnOnce(&mut ShellDraft),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(draft) = self.draft.as_mut() {
            change(draft);
            self.problem = None;
            self.sync_editor(window, cx);
        }
    }

    fn add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.draft.as_mut() else {
            return;
        };
        let path = self.new_path.read(cx).value().to_string();
        match draft.add(&path) {
            Ok(()) => {
                self.close_add(window, cx);
                self.problem = None;
                self.sync_editor(window, cx);
            }
            Err(e) => {
                self.add_error = Some(e);
                cx.notify();
            }
        }
    }

    fn close_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.adding = false;
        self.add_error = None;
        self.new_path
            .update(cx, |i, cx| i.set_value("", window, cx));
        cx.notify();
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(client), Some(draft)) = (self.client.clone(), self.draft.as_ref()) else {
            return;
        };
        if self.pending {
            return;
        }
        let input = match draft.save_input() {
            Ok(input) => input,
            Err(text) => {
                self.problem = Some(Problem {
                    text,
                    reload: false,
                });
                cx.notify();
                return;
            }
        };
        self.pending = true;
        self.problem = None;
        cx.notify();
        let request = client.call::<api::UpdateDotfiles>(input);
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(state) => {
                        this.show(&state, window, cx);
                        super::toast::success(model::SAVED, window, cx);
                    }
                    Err(e) => this.save_failed(&e, window, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_failed(&mut self, e: &ApiError, window: &mut Window, cx: &mut Context<Self>) {
        match e.code() {
            Some(p::ErrorCode::DotfilesChanged) => {
                self.problem = Some(Problem {
                    text: super::toast::error_text(e, None),
                    reload: true,
                })
            }
            Some(p::ErrorCode::ValidationFailed) => {
                self.problem = Some(Problem {
                    text: super::toast::error_text(e, None),
                    reload: false,
                })
            }
            _ => super::toast::error(e, None, window, cx),
        }
    }

    fn render_list(&self, draft: &ShellDraft, cx: &mut Context<Self>) -> AnyElement {
        let mono = cx.theme().mono_font_family.clone();
        let selected = draft.current().map(|f| f.path.clone());
        let add = if self.adding {
            v_flex()
                .gap_1()
                .child(
                    Input::new(&self.new_path)
                        .id("shell-new-path")
                        .aria_label("New file path"),
                )
                .children(self.add_error.clone().map(|e| {
                    div()
                        .id("shell-add-error")
                        .role(Role::Alert)
                        .aria_label(e.clone())
                        .text_xs()
                        .text_color(color(Token::Destructive, cx))
                        .child(e)
                }))
                .child(
                    h_flex()
                        .gap_1()
                        .child(
                            Button::new("shell-add-confirm")
                                .primary()
                                .small()
                                .label("Add")
                                .on_click(cx.listener(|this, _, window, cx| this.add(window, cx))),
                        )
                        .child(
                            Button::new("shell-add-cancel")
                                .ghost()
                                .small()
                                .label("Cancel")
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.close_add(window, cx)),
                                ),
                        ),
                )
                .into_any_element()
        } else {
            let full = !draft.can_add();
            Button::new("shell-add-file")
                .small()
                .outline()
                .icon(IconName::Plus)
                .label("Add file")
                .disabled(full)
                .when(full, |b| {
                    b.tooltip(format!("Up to {} files", model::FILES_MAX))
                })
                .on_click(cx.listener(|this, _, window, cx| {
                    this.adding = true;
                    this.new_path.read(cx).focus_handle(cx).focus(window, cx);
                    cx.notify();
                }))
                .into_any_element()
        };
        v_flex()
            .w(px(224.))
            .flex_shrink_0()
            .gap_2()
            .child(
                v_flex()
                    .id("shell-files")
                    .role(Role::List)
                    .aria_label("Files")
                    .gap_0p5()
                    .children(draft.files.iter().enumerate().map(|(row, f)| {
                        let (select, remove) = (f.path.clone(), f.path.clone());
                        h_flex()
                            .id(SharedString::from(format!("shell-file-{row}")))
                            .role(Role::ListItem)
                            .gap_1()
                            .child(
                                Button::new(SharedString::from(format!("shell-select-{row}")))
                                    .ghost()
                                    .small()
                                    .flex_1()
                                    .min_w_0()
                                    .font_family(mono.clone())
                                    .label(f.path.clone())
                                    .tooltip(f.path.clone())
                                    .selected(selected.as_ref() == Some(&f.path))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        let path = select.clone();
                                        this.edit(|d| d.select(&path), window, cx)
                                    })),
                            )
                            .child(
                                Button::new(SharedString::from(format!("shell-remove-{row}")))
                                    .ghost()
                                    .small()
                                    .size(px(ICON_BUTTON))
                                    .icon(IconName::X)
                                    .accessibility_label(format!("Remove {}", f.path))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        let path = remove.clone();
                                        this.edit(|d| d.remove(&path), window, cx)
                                    })),
                            )
                    })),
            )
            .child(add)
            .child(
                Button::new("shell-reset-defaults")
                    .small()
                    .outline()
                    .label("Reset to defaults")
                    .disabled(self.pending)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.edit(ShellDraft::reset_to_defaults, window, cx)
                    })),
            )
            .into_any_element()
    }

    fn render_bar(&self, dirty: bool, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .gap_2()
            .py_2()
            .border_t_1()
            .border_color(color(Token::Border, cx))
            .children(self.problem.as_ref().map(|problem| {
                h_flex()
                    .id("shell-problem")
                    .role(Role::Alert)
                    .aria_label(problem.text.clone())
                    .flex_1()
                    .min_w_0()
                    .gap_2()
                    .text_xs()
                    .text_color(color(Token::Destructive, cx))
                    .child(problem.text.clone())
                    .children(problem.reload.then(|| {
                        Button::new("shell-reload")
                            .small()
                            .outline()
                            .label("Reload")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, window, cx| this.load(window, cx)))
                    }))
            }))
            .child(div().flex_1())
            .child(
                Button::new("shell-reset")
                    .ghost()
                    .small()
                    .label("Reset")
                    .disabled(!dirty || self.pending)
                    .on_click(
                        cx.listener(|this, _, window, cx| this.edit(ShellDraft::reset, window, cx)),
                    ),
            )
            .child(
                Button::new("shell-save")
                    .primary()
                    .small()
                    .label(if self.pending { "Saving…" } else { "Save" })
                    .disabled(!dirty || self.pending)
                    .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
            )
    }
}

impl Render for ShellPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        let page = v_flex()
            .id("settings-shell")
            .size_full()
            .min_h_0()
            .gap_4()
            .child(div().text_sm().text_color(muted).child(model::HELP));
        if let Some(error) = self.load_error.clone() {
            return page.child(
                h_flex()
                    .gap_2()
                    .child(div().text_color(color(Token::Destructive, cx)).child(error))
                    .child(
                        Button::new("shell-retry")
                            .small()
                            .label("Retry")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, window, cx| this.load(window, cx))),
                    ),
            );
        }
        let Some(draft) = self.draft.as_ref() else {
            return page.child(super::skeleton_rows(6));
        };
        let dirty = draft.dirty();
        let file = match draft.current() {
            Some(f) => Editor::new(&self.editor)
                .aria_label(f.path.clone())
                .size_full()
                .into_any_element(),
            None => div()
                .text_sm()
                .text_color(muted)
                .child(model::EMPTY)
                .into_any_element(),
        };
        let list = self.render_list(draft, cx);
        page.child(
            h_flex()
                .flex_1()
                .min_h_0()
                .items_start()
                .gap_4()
                .child(list)
                .child(div().flex_1().min_w_0().h_full().child(file)),
        )
        .child(self.render_bar(dirty, cx))
    }
}
