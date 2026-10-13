//! Named environments (04; 07, Scope): the Settings Environments page, the Environment… dialog of
//! the top bar and the review dialog for agent proposals.
use super::environments_model::{self as model, EnvironmentDraft, InjectorDraft, SecretDraft};
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::select::{Select, SelectEvent, SelectItem, SelectState};
use gpui_kit::component::{
    Disableable as _, IconName, Selectable as _, Sizable as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div, px,
};
use tempo_client::{ApiError, Client, ProposalApply};
use tempo_protocol::{self as p, Environment, api};

/// One entry of an environment select; the empty value is none or the project default.
#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
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

pub type EnvironmentSelect = SelectState<Vec<Choice>>;

pub fn choices(entries: Vec<(String, String)>) -> Vec<Choice> {
    entries
        .into_iter()
        .map(|(value, label)| Choice {
            value,
            label: label.into(),
        })
        .collect()
}

/// Fills `select` with `first` plus every environment and selects `id` (none when it is gone).
pub fn sync_select(
    select: &Entity<EnvironmentSelect>,
    first: String,
    environments: &[Environment],
    id: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) {
    let selected = model::find(environments, id).map_or(String::new(), |e| e.id.clone());
    let items = choices(model::select_entries(first, environments));
    select.update(cx, |state, cx| {
        state.set_items(items, window, cx);
        state.set_selected_value(&selected, window, cx);
    });
}

fn error_line(error: Option<String>, cx: &App) -> Option<impl IntoElement> {
    error.map(|e| {
        div()
            .id("environment-error")
            .role(Role::Alert)
            .aria_label(e.clone())
            .text_xs()
            .text_color(color(Token::Destructive, cx))
            .child(e)
    })
}

fn text(input: &Entity<InputState>, cx: &App) -> String {
    input.read(cx).value().to_string()
}

fn input<T: 'static>(
    value: &str,
    placeholder: &str,
    masked: bool,
    window: &mut Window,
    cx: &mut Context<T>,
) -> Entity<InputState> {
    let (value, placeholder) = (value.to_owned(), placeholder.to_owned());
    cx.new(|cx| {
        InputState::new(window, cx)
            .masked(masked)
            .placeholder(placeholder)
            .default_value(value)
    })
}

fn code_area<T: 'static>(
    code: &str,
    window: &mut Window,
    cx: &mut Context<T>,
) -> Entity<TextareaState> {
    let code = code.to_owned();
    cx.new(|cx| {
        TextareaState::new(window, cx)
            .auto_grow(4, 20)
            .placeholder("export default { async fetch(request, env) { … } };")
            .default_value(code)
    })
}

fn update_projects(cx: &mut App, change: impl Fn(&mut p::Project)) {
    if let Some(app) = crate::app::AppState::try_global(cx) {
        app.read(cx).hub.clone().update(cx, |hub, cx| {
            hub.projects.iter_mut().for_each(&change);
            cx.notify();
        });
    }
}

/// Replaces the hub's copy of `project` after `setProjectEnvironment`.
pub fn store_project(project: p::Project, cx: &mut App) {
    update_projects(cx, |p| {
        if p.id == project.id {
            *p = project.clone();
        }
    });
}

fn project_of(project_id: &str, cx: &App) -> Option<p::Project> {
    let app = crate::app::AppState::try_global(cx)?;
    let hub = app.read(cx).hub.read(cx);
    hub.projects.iter().find(|p| p.id == project_id).cloned()
}

struct SecretRow {
    name: Entity<InputState>,
    hosts: Entity<InputState>,
    value: Entity<InputState>,
    set: bool,
    /// The secret exists on the server, so Remove deletes it there.
    stored: bool,
    _changed: Subscription,
}

struct InjectorRow {
    name: Entity<InputState>,
    hosts: Entity<InputState>,
    code: Entity<TextareaState>,
}

struct Editor {
    id: String,
    name: Entity<InputState>,
    policy: p::EgressPolicy,
    allowlist: Entity<TextareaState>,
    secrets: Vec<SecretRow>,
    injectors: Vec<InjectorRow>,
}

/// Settings → Environments (04, Settings).
pub struct EnvironmentsPage {
    client: Option<Client>,
    environments: Option<Vec<Environment>>,
    editor: Option<Editor>,
    new_name: Entity<InputState>,
    naming: bool,
    pending: bool,
    error: Option<String>,
}

impl EnvironmentsPage {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let client = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client());
        let mut this = Self {
            client,
            environments: None,
            editor: None,
            new_name: input("", "Name", false, window, cx),
            naming: false,
            pending: false,
            error: None,
        };
        this.load(None, window, cx);
        this
    }

    /// Lists the environments, then shows `select` (or the one already shown) in the editor.
    fn load(&mut self, select: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        let request = client.call::<api::ListEnvironments>(p::Empty {});
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(list) => {
                        let id = select.or_else(|| this.editor.as_ref().map(|e| e.id.clone()));
                        this.environments = Some(list);
                        this.error = None;
                        this.select(id, window, cx);
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn select(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let environment = self
            .environments
            .as_deref()
            .and_then(|all| model::find(all, id.as_deref()))
            .cloned();
        self.editor = environment.map(|e| self.editor_for(&e, window, cx));
        self.error = None;
        cx.notify();
    }

    fn secret_row(
        &self,
        secret: &SecretDraft,
        set: bool,
        stored: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SecretRow {
        let hosts = input(&secret.hosts, "api.example.com", false, window, cx);
        let changed = cx.subscribe(&hosts, |_, _, _: &InputEvent, cx| cx.notify());
        SecretRow {
            name: input(&secret.name, "API_KEY", false, window, cx),
            hosts,
            value: input("", "Value", true, window, cx),
            set,
            stored,
            _changed: changed,
        }
    }

    fn injector_row(
        &self,
        injector: &InjectorDraft,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> InjectorRow {
        InjectorRow {
            name: input(&injector.name, "aws-sigv4", false, window, cx),
            hosts: input(&injector.hosts, "s3.amazonaws.com", false, window, cx),
            code: code_area(&injector.code, window, cx),
        }
    }

    fn editor_for(&self, e: &Environment, window: &mut Window, cx: &mut Context<Self>) -> Editor {
        let draft = EnvironmentDraft::from_environment(e);
        let allowlist = draft.allowlist.clone();
        Editor {
            id: e.id.clone(),
            name: input(&draft.name, "Name", false, window, cx),
            policy: draft.policy,
            allowlist: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(2, 12)
                    .placeholder("example.com\n*.example.com")
                    .default_value(allowlist)
            }),
            secrets: draft
                .secrets
                .iter()
                .zip(&e.secrets)
                .map(|(s, stored)| self.secret_row(s, stored.set, true, window, cx))
                .collect(),
            injectors: draft
                .injectors
                .iter()
                .map(|i| self.injector_row(i, window, cx))
                .collect(),
        }
    }

    fn draft(editor: &Editor, cx: &App) -> EnvironmentDraft {
        EnvironmentDraft {
            name: text(&editor.name, cx),
            policy: editor.policy,
            allowlist: editor.allowlist.read(cx).value().to_string(),
            secrets: editor
                .secrets
                .iter()
                .map(|s| SecretDraft {
                    name: text(&s.name, cx),
                    hosts: text(&s.hosts, cx),
                    value: text(&s.value, cx),
                })
                .collect(),
            injectors: editor
                .injectors
                .iter()
                .map(|i| InjectorDraft {
                    name: text(&i.name, cx),
                    hosts: text(&i.hosts, cx),
                    code: i.code.read(cx).value().to_string(),
                })
                .collect(),
        }
    }

    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.pending {
            return;
        }
        let Ok(name) = text(&self.new_name, cx).trim().parse() else {
            self.error = Some("Enter a name of 1 to 64 characters.".into());
            cx.notify();
            return;
        };
        self.pending = true;
        let request = client.call::<api::CreateEnvironment>(p::CreateEnvironmentIn { name });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(created) => {
                        this.naming = false;
                        this.new_name
                            .update(cx, |i, cx| i.set_value("", window, cx));
                        this.load(Some(created.id), window, cx);
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Save: `updateEnvironment`, then `setEnvironmentSecret` for each filled value field.
    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(client), Some(editor)) = (self.client.clone(), self.editor.as_ref()) else {
            return;
        };
        if self.pending {
            return;
        }
        let (update, values) = match Self::draft(editor, cx).save(&editor.id) {
            Ok(save) => save,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        self.pending = true;
        self.error = None;
        cx.notify();
        let id = editor.id.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result: Result<(), ApiError> = async {
                client.call::<api::UpdateEnvironment>(update).await?;
                for (name, value) in values {
                    client
                        .call::<api::SetEnvironmentSecret>(p::SetEnvironmentSecretIn {
                            environment_id: id.clone(),
                            name,
                            value,
                        })
                        .await?;
                }
                Ok(())
            }
            .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(()) => this.load(Some(id), window, cx),
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn remove_secret(&mut self, row: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.as_mut() else {
            return;
        };
        let Some(secret) = editor.secrets.get(row) else {
            return;
        };
        if !secret.stored {
            editor.secrets.remove(row);
            cx.notify();
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.pending {
            return;
        }
        self.pending = true;
        let (id, name) = (editor.id.clone(), text(&secret.name, cx));
        let request = client.call::<api::DeleteEnvironmentSecret>(p::DeleteEnvironmentSecretIn {
            environment_id: id.clone(),
            name: name.clone(),
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, _, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        if let Some(editor) = this.editor.as_mut().filter(|e| e.id == id) {
                            editor
                                .secrets
                                .retain(|s| !(s.stored && s.name.read(cx).value() == name));
                        }
                        if let Some(e) = this.environments.iter_mut().flatten().find(|e| e.id == id)
                        {
                            e.secrets.retain(|s| s.name != name);
                        }
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn confirm_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = &self.editor else {
            return;
        };
        let name = self
            .environments
            .as_deref()
            .and_then(|all| model::find(all, Some(&editor.id)))
            .map_or_else(|| text(&editor.name, cx), |e| e.name.clone());
        let id = editor.id.clone();
        let weak = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let weak = weak.clone();
            let id = id.clone();
            alert
                .title(model::delete_confirm(&name))
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let _ = weak.update(cx, |this, cx| this.delete(id.clone(), window, cx));
                    true
                })
        });
    }

    fn delete(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.pending {
            return;
        }
        self.pending = true;
        let request = client.call::<api::DeleteEnvironment>(p::DeleteEnvironmentIn {
            environment_id: id.clone(),
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        update_projects(cx, |p| {
                            if p.environment_id.as_deref() == Some(id.as_str()) {
                                p.environment_id = None;
                            }
                        });
                        if let Some(list) = this.environments.as_mut() {
                            list.retain(|e| e.id != id);
                        }
                        this.select(None, window, cx);
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_list(&self, cx: &mut Context<Self>) -> AnyElement {
        let muted = color(Token::MutedForeground, cx);
        let selected = self.editor.as_ref().map(|e| e.id.clone());
        let list = match &self.environments {
            None => super::skeleton_rows(3).into_any_element(),
            Some(list) if list.is_empty() => div()
                .text_xs()
                .text_color(muted)
                .child("No environments.")
                .into_any_element(),
            Some(list) => v_flex()
                .id("environment-list")
                .role(Role::List)
                .aria_label("Environments")
                .gap_0p5()
                .children(list.iter().map(|e| {
                    let id = e.id.clone();
                    Button::new(SharedString::from(format!("environment-{}", e.id)))
                        .ghost()
                        .small()
                        .label(e.name.clone())
                        .selected(selected.as_ref() == Some(&e.id))
                        .disabled(self.pending)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.select(Some(id.clone()), window, cx)
                        }))
                }))
                .into_any_element(),
        };
        v_flex()
            .w(px(200.))
            .gap_2()
            .child(list)
            .child(if self.naming {
                v_flex()
                    .gap_1()
                    .child(
                        Input::new(&self.new_name)
                            .id("new-environment-name")
                            .aria_label("Environment name"),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(
                                Button::new("create-environment")
                                    .primary()
                                    .small()
                                    .label("Create")
                                    .disabled(self.pending)
                                    .on_click(
                                        cx.listener(|this, _, window, cx| this.create(window, cx)),
                                    ),
                            )
                            .child(
                                Button::new("cancel-new-environment")
                                    .ghost()
                                    .small()
                                    .label("Cancel")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.naming = false;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .into_any_element()
            } else {
                Button::new("new-environment")
                    .small()
                    .outline()
                    .icon(IconName::Plus)
                    .label(model::NEW_ENVIRONMENT)
                    .disabled(self.client.is_none())
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.naming = true;
                        cx.notify();
                    }))
                    .into_any_element()
            })
            .into_any_element()
    }

    fn render_editor(&self, editor: &Editor, cx: &mut Context<Self>) -> AnyElement {
        let muted = color(Token::MutedForeground, cx);
        let heading = |label: &'static str| {
            div()
                .text_xs()
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(muted)
                .child(label.to_uppercase())
        };
        let policy = editor.policy;
        v_flex()
            .id("environment-editor")
            .role(Role::Group)
            .aria_label(text(&editor.name, cx))
            .flex_1()
            .min_w_0()
            .gap_2()
            .child(heading("Name"))
            .child(
                Input::new(&editor.name)
                    .id("environment-name")
                    .aria_label("Name"),
            )
            .child(heading("Egress policy"))
            .child(h_flex().gap_1().children(
                [p::EgressPolicy::Allowlist, p::EgressPolicy::Open].map(|option| {
                    Button::new(SharedString::from(format!("environment-policy-{option}")))
                        .small()
                        .outline()
                        .label(option.to_string())
                        .selected(policy == option)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(editor) = this.editor.as_mut() {
                                editor.policy = option;
                            }
                            cx.notify();
                        }))
                }),
            ))
            .child(heading("Allowlist"))
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("One pattern per line."),
            )
            .child(Textarea::new(&editor.allowlist).aria_label("Allowlist"))
            .child(heading("Secrets"))
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child(model::VALUES_HIDDEN),
            )
            .children(editor.secrets.iter().enumerate().map(|(row, s)| {
                let name = text(&s.name, cx);
                let hosts = model::hosts(&text(&s.hosts, cx));
                let hint = model::secret_hint(&name, &hosts);
                v_flex()
                    .id(SharedString::from(format!("environment-secret-{row}")))
                    .role(Role::ListItem)
                    .aria_label(format!("Secret {name}"))
                    .gap_1()
                    .child(
                        h_flex()
                            .gap_1p5()
                            .child(
                                div().w(px(150.)).child(
                                    Input::new(&s.name)
                                        .id(SharedString::from(format!("secret-name-{row}")))
                                        .aria_label("Secret name"),
                                ),
                            )
                            .child(
                                div().flex_1().child(
                                    Input::new(&s.hosts)
                                        .id(SharedString::from(format!("secret-hosts-{row}")))
                                        .aria_label("Hosts, comma separated"),
                                ),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(model::set_label(s.set)),
                            )
                            .child(
                                div().w(px(150.)).child(
                                    Input::new(&s.value)
                                        .id(SharedString::from(format!("secret-value-{row}")))
                                        .aria_label(format!("Value of {name}")),
                                ),
                            )
                            .child(
                                Button::new(SharedString::from(format!("remove-secret-{row}")))
                                    .ghost()
                                    .small()
                                    .label("Remove")
                                    .accessibility_label(format!("Remove {name}"))
                                    .disabled(self.pending)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.remove_secret(row, window, cx)
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(color(
                                if hosts.is_empty() {
                                    Token::Warning
                                } else {
                                    Token::MutedForeground
                                },
                                cx,
                            ))
                            .child(hint),
                    )
            }))
            .child(
                Button::new("add-environment-secret")
                    .small()
                    .outline()
                    .icon(IconName::Plus)
                    .label("Add secret")
                    .on_click(cx.listener(|this, _, window, cx| {
                        let row =
                            this.secret_row(&SecretDraft::default(), false, false, window, cx);
                        if let Some(editor) = this.editor.as_mut() {
                            editor.secrets.push(row);
                        }
                        cx.notify();
                    })),
            )
            .child(heading("Injectors"))
            .children(editor.injectors.iter().enumerate().map(|(row, i)| {
                let name = text(&i.name, cx);
                v_flex()
                    .id(SharedString::from(format!("environment-injector-{row}")))
                    .role(Role::ListItem)
                    .aria_label(format!("Injector {name}"))
                    .gap_1()
                    .child(
                        h_flex()
                            .gap_1p5()
                            .child(
                                div().w(px(150.)).child(
                                    Input::new(&i.name)
                                        .id(SharedString::from(format!("injector-name-{row}")))
                                        .aria_label("Injector name"),
                                ),
                            )
                            .child(
                                div().flex_1().child(
                                    Input::new(&i.hosts)
                                        .id(SharedString::from(format!("injector-hosts-{row}")))
                                        .aria_label("Hosts, comma separated"),
                                ),
                            )
                            .child(
                                Button::new(SharedString::from(format!("remove-injector-{row}")))
                                    .ghost()
                                    .small()
                                    .label("Remove")
                                    .accessibility_label(format!("Remove {name}"))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if let Some(editor) = this.editor.as_mut()
                                            && row < editor.injectors.len()
                                        {
                                            editor.injectors.remove(row);
                                        }
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .font_family("monospace")
                            .child(Textarea::new(&i.code).aria_label(format!("Code of {name}"))),
                    )
            }))
            .child(
                Button::new("add-environment-injector")
                    .small()
                    .outline()
                    .icon(IconName::Plus)
                    .label("Add injector")
                    .on_click(cx.listener(|this, _, window, cx| {
                        let row = this.injector_row(&InjectorDraft::default(), window, cx);
                        if let Some(editor) = this.editor.as_mut() {
                            editor.injectors.push(row);
                        }
                        cx.notify();
                    })),
            )
            .child(
                h_flex()
                    .gap_2()
                    .py_2()
                    .child(
                        Button::new("delete-environment")
                            .danger()
                            .small()
                            .label("Delete")
                            .disabled(self.pending)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.confirm_delete(window, cx)),
                            ),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("save-environment")
                            .primary()
                            .small()
                            .label(if self.pending { "Saving…" } else { "Save" })
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
                    ),
            )
            .into_any_element()
    }
}

impl Render for EnvironmentsPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let editor = self.editor.as_ref().map(|e| self.render_editor(e, cx));
        v_flex()
            .id("settings-environments")
            .size_full()
            .overflow_y_scroll()
            .gap_2()
            .children(error_line(self.error.clone(), cx))
            .child(
                h_flex()
                    .items_start()
                    .gap_4()
                    .child(self.render_list(cx))
                    .children(editor),
            )
    }
}

/// The Environment… dialog (04, Overflow menu).
pub struct WorkspaceEnvironmentDialog {
    client: Client,
    workspace_id: String,
    project_id: String,
    environments: Option<Vec<Environment>>,
    select: Entity<EnvironmentSelect>,
    pending: bool,
    error: Option<String>,
    _selected: Subscription,
}

impl WorkspaceEnvironmentDialog {
    pub fn new(
        client: Client,
        workspace_id: String,
        project_id: String,
        current: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let select = cx.new(|cx| SelectState::new(Vec::<Choice>::new(), None, window, cx));
        let selected = cx.subscribe_in(
            &select,
            window,
            |this, _, event: &SelectEvent<Vec<Choice>>, window, cx| {
                if let SelectEvent::Confirm(Some(value)) = event {
                    this.choose(model::selected_id(value), window, cx);
                }
            },
        );
        let request = client.call::<api::ListEnvironments>(p::Empty {});
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(list) => {
                        let project =
                            project_of(&this.project_id, cx).and_then(|p| p.environment_id);
                        sync_select(
                            &this.select,
                            model::project_default_label(&list, project.as_deref()),
                            &list,
                            current.as_deref(),
                            window,
                            cx,
                        );
                        this.environments = Some(list);
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
        Self {
            client,
            workspace_id,
            project_id,
            environments: None,
            select,
            pending: false,
            error: None,
            _selected: selected,
        }
    }

    /// `setWorkspaceEnvironment` at once; null uses the project's.
    fn choose(
        &mut self,
        environment_id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending = true;
        self.error = None;
        let request =
            self.client
                .call::<api::SetWorkspaceEnvironment>(p::SetWorkspaceEnvironmentIn {
                    workspace_id: self.workspace_id.clone(),
                    environment_id,
                });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                if let Err(e) = result {
                    this.error = Some(super::toast::error_text(&e, None));
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for WorkspaceEnvironmentDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("workspace-environment")
            .role(Role::Group)
            .aria_label("Environment")
            .gap_3()
            .child(
                Select::new(&self.select)
                    .id("workspace-environment-select")
                    .accessibility_label("Environment")
                    .placeholder("Environment")
                    .disabled(self.environments.is_none() || self.pending),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(color(Token::MutedForeground, cx))
                    .child(model::ENVIRONMENT_DIALOG_NOTE),
            )
            .children(error_line(self.error.clone(), cx))
    }
}

/// Opens the Environment… dialog for the workspace of `detail`.
pub fn open_workspace_dialog(
    client: Client,
    detail: &p::WorkspaceDetail,
    window: &mut Window,
    cx: &mut App,
) {
    let (id, project, current) = (
        detail.id.clone(),
        detail.project_id.clone(),
        detail.environment_id.clone(),
    );
    let view =
        cx.new(|cx| WorkspaceEnvironmentDialog::new(client, id, project, current, window, cx));
    window.open_dialog(cx, move |d, _, _| {
        d.title("Environment").w(px(480.)).child(view.clone())
    });
}

/// The review dialog of the oldest pending proposal (04, Pending environment proposals).
pub struct ProposalReview {
    client: Client,
    workspace_id: String,
    workspace_override: Option<String>,
    project: p::Project,
    pending_proposal: p::PendingEnvironmentProposal,
    environments: Option<Vec<Environment>>,
    values: Vec<(String, Entity<InputState>)>,
    code: Vec<(String, Entity<TextareaState>)>,
    pending: bool,
    error: Option<String>,
}

impl ProposalReview {
    pub fn new(
        client: Client,
        detail: &p::WorkspaceDetail,
        project: p::Project,
        proposal: p::PendingEnvironmentProposal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let code = proposal
            .proposal
            .injectors
            .iter()
            .flatten()
            .map(|i| {
                let area = code_area(&i.code, window, cx);
                (i.name.clone(), area)
            })
            .collect();
        let request = client.call::<api::ListEnvironments>(p::Empty {});
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(list) => {
                        let target = this.target(&list).cloned();
                        this.values =
                            model::value_fields(target.as_ref(), &this.pending_proposal.proposal)
                                .into_iter()
                                .map(|name| {
                                    let field = input("", "Value", true, window, cx);
                                    (name, field)
                                })
                                .collect();
                        this.environments = Some(list);
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
        Self {
            client,
            workspace_id: detail.id.clone(),
            workspace_override: detail.environment_id.clone(),
            project,
            pending_proposal: proposal,
            environments: None,
            values: vec![],
            code,
            pending: false,
            error: None,
        }
    }

    fn target<'a>(&self, environments: &'a [Environment]) -> Option<&'a Environment> {
        model::applies(
            environments,
            self.workspace_override.as_deref(),
            self.project.environment_id.as_deref(),
        )
    }

    fn apply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(environments) = self.environments.as_deref() else {
            return;
        };
        if self.pending {
            return;
        }
        let apply = ProposalApply {
            workspace_id: self.workspace_id.clone(),
            proposal_id: self.pending_proposal.id.clone(),
            proposal: self.pending_proposal.proposal.clone(),
            target: self.target(environments).cloned(),
            project_id: self.project.id.clone(),
            new_name: self.project.name.clone(),
            taken: environments.iter().map(|e| e.name.clone()).collect(),
            values: self
                .values
                .iter()
                .map(|(name, field)| (name.clone(), text(field, cx)))
                .collect(),
        };
        self.run(self.client.apply_environment_proposal(apply), window, cx);
    }

    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let request =
            self.client
                .call::<api::ResolveEnvironmentProposal>(p::ResolveEnvironmentProposalIn {
                    workspace_id: self.workspace_id.clone(),
                    proposal_id: self.pending_proposal.id.clone(),
                    status: p::ResolveEnvironmentProposalInStatus::Dismissed,
                });
        self.run(
            async move { request.await.map(|_| None::<tempo_client::ProposalApplied>) },
            window,
            cx,
        );
    }

    fn run<T: Into<Option<tempo_client::ProposalApplied>>>(
        &mut self,
        request: impl std::future::Future<Output = Result<T, ApiError>> + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending = true;
        self.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result.map(Into::into) {
                    Ok(applied) => {
                        if let Some(project) = applied.and_then(|a| a.project) {
                            store_project(project, cx);
                        }
                        window.close_dialog(cx);
                    }
                    Err(e) => this.error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for ProposalReview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        let proposal = &self.pending_proposal.proposal;
        let target = self
            .environments
            .as_deref()
            .map(|list| model::target_label(self.target(list), &self.project.name));
        let lists = model::change_lists(proposal);
        let heading = |label: &str| {
            div()
                .text_xs()
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(muted)
                .child(label.to_owned())
        };
        v_flex()
            .id("environment-proposal")
            .role(Role::Group)
            .aria_label(model::PROPOSAL_BANNER)
            .gap_3()
            .child(div().text_sm().child(proposal.note.to_string()))
            .children(lists.into_iter().map(|(title, items)| {
                v_flex()
                    .id(SharedString::from(format!("proposal-{title}")))
                    .role(Role::List)
                    .aria_label(title)
                    .gap_0p5()
                    .child(heading(title))
                    .children(
                        items
                            .into_iter()
                            .map(|i| div().text_sm().child(format!("• {i}"))),
                    )
            }))
            .when(!self.code.is_empty(), |col| {
                col.child(heading("Injectors")).children(
                    proposal.injectors.iter().flatten().zip(&self.code).map(
                        |(injector, (name, area))| {
                            v_flex()
                                .gap_1()
                                .child(div().text_sm().child(format!(
                                    "{name} · {}",
                                    model::hosts_text(&injector.hosts)
                                )))
                                .child(
                                    div().font_family("monospace").child(
                                        Textarea::new(area)
                                            .readonly(true)
                                            .aria_label(format!("Code of {name}")),
                                    ),
                                )
                        },
                    ),
                )
            })
            .when(model::has_injectors(proposal), |col| {
                col.child(
                    div()
                        .id("proposal-injector-warning")
                        .role(Role::Alert)
                        .aria_label(model::INJECTOR_WARNING)
                        .text_sm()
                        .text_color(color(Token::Warning, cx))
                        .child(model::INJECTOR_WARNING),
                )
            })
            .children(self.values.iter().map(|(name, field)| {
                h_flex()
                    .gap_2()
                    .child(div().w(px(150.)).text_sm().child(name.clone()))
                    .child(
                        div().flex_1().child(
                            Input::new(field)
                                .id(SharedString::from(format!("proposal-value-{name}")))
                                .aria_label(format!("Value of {name}")),
                        ),
                    )
            }))
            .children(target.map(|t| div().text_sm().child(t)))
            .children(error_line(self.error.clone(), cx))
            .child(
                h_flex()
                    .gap_2()
                    .justify_end()
                    .child(
                        Button::new("dismiss-proposal")
                            .label("Dismiss")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
                    )
                    .child(
                        Button::new("apply-proposal")
                            .primary()
                            .label("Apply")
                            .disabled(self.pending || self.environments.is_none())
                            .on_click(cx.listener(|this, _, window, cx| this.apply(window, cx))),
                    ),
            )
    }
}

/// Review opens the dialog for the oldest pending proposal.
pub fn open_proposal_review(
    client: Client,
    detail: &p::WorkspaceDetail,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(proposal) = detail
        .environment_proposals
        .as_ref()
        .and_then(|all| all.first())
        .cloned()
    else {
        return;
    };
    let Some(project) = project_of(&detail.project_id, cx) else {
        return;
    };
    let detail = detail.clone();
    let view = cx.new(|cx| ProposalReview::new(client, &detail, project, proposal, window, cx));
    window.open_dialog(cx, move |d, _, _| {
        d.title(model::PROPOSAL_BANNER)
            .w(px(640.))
            .child(view.clone())
    });
}

/// The banner above the composer while proposals are pending.
pub fn proposal_banner(
    detail: &p::WorkspaceDetail,
    client: &Client,
    cx: &App,
) -> Option<impl IntoElement> {
    detail
        .environment_proposals
        .as_ref()
        .filter(|all| !all.is_empty())?;
    let (detail, client) = (detail.clone(), client.clone());
    Some(
        h_flex()
            .id("environment-proposal-banner")
            .role(Role::Status)
            .aria_label(model::PROPOSAL_BANNER)
            .px_3()
            .py_1()
            .gap_2()
            .border_t_1()
            .border_color(color(Token::Border, cx))
            .child(div().flex_1().min_w_0().child(model::PROPOSAL_BANNER))
            .child(
                Button::new("review-environment-proposal")
                    .label("Review")
                    .on_click(move |_, window, cx| {
                        open_proposal_review(client.clone(), &detail, window, cx)
                    }),
            ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;

    fn detail() -> p::WorkspaceDetail {
        serde_json::from_str(
            include_str!("../../../../packages/protocol/fixtures/types/WorkspaceDetail.jsonl")
                .lines()
                .next()
                .expect("one sample"),
        )
        .expect("detail")
    }

    #[gpui_kit::test]
    fn the_banner_shows_only_while_proposals_are_pending(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let runtime = tempo_client::Runtime::start().unwrap();
        let client = tempo_client::Server::new(&runtime.handle(), "http://127.0.0.1:9", "0.2.0")
            .unwrap()
            .client(tempo_client::Token::new("test-token"));
        let mut detail = detail();
        let pending: p::PendingEnvironmentProposal = serde_json::from_str(include_str!(
            "../../../../packages/protocol/fixtures/types/PendingEnvironmentProposal.jsonl"
        ))
        .unwrap();
        detail.environment_proposals = None;
        cx.update(|cx| assert!(proposal_banner(&detail, &client, cx).is_none()));
        detail.environment_proposals = Some(vec![]);
        cx.update(|cx| assert!(proposal_banner(&detail, &client, cx).is_none()));
        detail.environment_proposals = Some(vec![pending]);
        cx.update(|cx| assert!(proposal_banner(&detail, &client, cx).is_some()));
    }

    #[test]
    fn select_choices_keep_value_and_label() {
        let items = choices(vec![
            (String::new(), "None".into()),
            ("e1".into(), "Payments".into()),
        ]);
        assert_eq!(items[0].value(), "");
        assert_eq!(items[1].title(), SharedString::from("Payments"));
    }
}
