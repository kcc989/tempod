//! Settings tabs (04, Settings): Logins, Project, Appearance and Notifications. Server data
//! changes with the same functions as the web (07, Local storage and settings).
use super::settings_model::{self as model, EditValue, FieldState, Kind};
use super::tokens::{Token, color};
use crate::platform::Permission;
use crate::storage::{Local, Theme as SavedTheme};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{
    Disableable as _, IconName, Selectable as _, Sizable as _, Theme, ThemeMode, h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div, px,
};
use std::collections::BTreeMap;
use tempo_protocol::{self as p, api};

pub const TAB_PROJECT: usize = 1;
pub const TAB_NOTIFICATIONS: usize = 3;

struct RunEditor {
    id: Entity<InputState>,
    command: Entity<InputState>,
    cwd: Entity<InputState>,
    is_default: bool,
}

struct EnvEditor {
    name: Entity<InputState>,
    value: Entity<InputState>,
}

enum Editor {
    Line(Entity<InputState>),
    Area(Entity<TextareaState>),
    Choice(String),
    Toggle(bool),
    Instance {
        preset: String,
        vcpu: Entity<InputState>,
        memory: Entity<InputState>,
        disk: Entity<InputState>,
    },
    Run(Vec<RunEditor>),
    Env(Vec<EnvEditor>),
}

/// One settings key: whether Tempo sets it, and its editor.
struct Field {
    set: bool,
    editor: Editor,
}

fn text(input: &Entity<InputState>, cx: &App) -> String {
    input.read(cx).value().to_string()
}

impl Field {
    fn state(&self, cx: &App) -> FieldState {
        let value = match &self.editor {
            Editor::Line(input) => EditValue::Text(text(input, cx)),
            Editor::Area(input) => EditValue::Text(input.read(cx).value().to_string()),
            Editor::Choice(value) => EditValue::Text(value.clone()),
            Editor::Toggle(on) => EditValue::Bool(*on),
            Editor::Instance {
                preset,
                vcpu,
                memory,
                disk,
            } => EditValue::Instance(model::InstanceEdit {
                preset: preset.clone(),
                vcpu: text(vcpu, cx),
                memory_mib: text(memory, cx),
                disk_mb: text(disk, cx),
            }),
            Editor::Run(rows) => EditValue::Run(
                rows.iter()
                    .map(|r| model::RunRow {
                        id: text(&r.id, cx),
                        command: text(&r.command, cx),
                        cwd: text(&r.cwd, cx),
                        is_default: r.is_default,
                    })
                    .collect(),
            ),
            Editor::Env(rows) => EditValue::Env(
                rows.iter()
                    .map(|r| model::EnvRow {
                        name: text(&r.name, cx),
                        value: text(&r.value, cx),
                    })
                    .collect(),
            ),
        };
        FieldState {
            set: self.set,
            value,
        }
    }
}

fn line(
    value: &str,
    placeholder: &str,
    window: &mut Window,
    cx: &mut Context<SettingsForm>,
) -> Entity<InputState> {
    let (value, placeholder) = (value.to_string(), placeholder.to_string());
    cx.new(|cx| {
        InputState::new(window, cx)
            .placeholder(placeholder)
            .default_value(value)
    })
}

fn run_editor(
    row: &model::RunRow,
    window: &mut Window,
    cx: &mut Context<SettingsForm>,
) -> RunEditor {
    RunEditor {
        id: line(&row.id, "dev", window, cx),
        command: line(&row.command, "bun run dev", window, cx),
        cwd: line(&row.cwd, "Folder (empty = /workspace)", window, cx),
        is_default: row.is_default,
    }
}

fn env_editor(
    row: &model::EnvRow,
    window: &mut Window,
    cx: &mut Context<SettingsForm>,
) -> EnvEditor {
    EnvEditor {
        name: line(&row.name, "NODE_ENV", window, cx),
        value: line(&row.value, "development", window, cx),
    }
}

fn field_editor(
    def: &model::FieldDef,
    state: &FieldState,
    window: &mut Window,
    cx: &mut Context<SettingsForm>,
) -> Field {
    let editor = match (&state.value, def.kind) {
        (EditValue::Text(value), Kind::Select) => Editor::Choice(value.clone()),
        (EditValue::Text(value), Kind::Multiline | Kind::Hosts) => {
            let (value, hosts) = (value.clone(), def.kind == Kind::Hosts);
            Editor::Area(cx.new(|cx| {
                let area = TextareaState::new(window, cx).auto_grow(2, 12);
                let area = if hosts {
                    area.placeholder("example.com\n*.example.com")
                } else {
                    area
                };
                area.default_value(value)
            }))
        }
        (EditValue::Text(value), _) => Editor::Line(line(value, "", window, cx)),
        (EditValue::Bool(on), _) => Editor::Toggle(*on),
        (EditValue::Instance(i), _) => Editor::Instance {
            preset: i.preset.clone(),
            vcpu: line(&i.vcpu, "", window, cx),
            memory: line(&i.memory_mib, "", window, cx),
            disk: line(&i.disk_mb, "", window, cx),
        },
        (EditValue::Run(rows), _) => {
            Editor::Run(rows.iter().map(|r| run_editor(r, window, cx)).collect())
        }
        (EditValue::Env(rows), _) => {
            Editor::Env(rows.iter().map(|r| env_editor(r, window, cx)).collect())
        }
    };
    Field {
        set: state.set,
        editor,
    }
}

pub struct SettingsForm {
    pub tab: usize,
    client: Option<tempo_client::Client>,
    credentials: Option<p::CredentialStatus>,
    secret_inputs: BTreeMap<String, Entity<InputState>>,
    project: Option<p::Project>,
    workspace: Option<p::WorkspaceDetail>,
    fields: Vec<Field>,
    initial: Vec<FieldState>,
    field_errors: BTreeMap<&'static str, String>,
    problem: Option<String>,
    secret_name: Entity<InputState>,
    secret_value: Entity<InputState>,
    secret_names: Vec<String>,
    secret_error: Option<String>,
    load_error: Option<String>,
    login_error: Option<String>,
    pending: bool,
    credential_changed: Option<p::CredentialProvider>,
    permission: Option<Permission>,
}

impl SettingsForm {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let app = crate::app::AppState::try_global(cx);
        let client = app.as_ref().and_then(|a| a.read(cx).client());
        let open = app.as_ref().and_then(|a| {
            a.read(cx)
                .workspaces
                .iter()
                .find(|w| Some(&w.read(cx).workspace_id) == a.read(cx).active_workspace.as_ref())
                .and_then(|w| w.read(cx).state.workspace.clone())
        });
        let projects = app
            .as_ref()
            .map(|a| a.read(cx).hub.read(cx).projects.clone())
            .unwrap_or_default();
        let project = open
            .as_ref()
            .and_then(|w| projects.iter().find(|p| p.id == w.project_id))
            .or_else(|| projects.first())
            .cloned();
        let secret_inputs = ["Claude", "Codex", "OpenRouter", "Anthropic", "OpenAI"]
            .into_iter()
            .map(|name| {
                (
                    name.into(),
                    cx.new(|cx| InputState::new(window, cx).masked(true)),
                )
            })
            .collect();
        let mut this = Self {
            tab: 0,
            client,
            credentials: None,
            secret_inputs,
            project: None,
            workspace: None,
            fields: vec![],
            initial: vec![],
            field_errors: BTreeMap::new(),
            problem: None,
            secret_name: cx.new(|cx| InputState::new(window, cx).placeholder("API_TOKEN")),
            secret_value: cx.new(|cx| {
                InputState::new(window, cx)
                    .masked(true)
                    .placeholder("Value")
            }),
            secret_names: vec![],
            secret_error: None,
            load_error: None,
            login_error: None,
            pending: false,
            credential_changed: None,
            permission: None,
        };
        if let Some(project) = project {
            this.load_project(project, window, cx);
        }
        this.refresh(cx);
        this.refresh_permission(cx);
        this
    }

    /// Selects a settings tab; the Notifications tab reads the macOS permission again.
    pub fn show_tab(&mut self, tab: usize, cx: &mut Context<Self>) {
        self.tab = tab;
        if tab == TAB_NOTIFICATIONS {
            self.refresh_permission(cx);
        }
        cx.notify();
    }

    fn refresh_permission(&mut self, cx: &mut Context<Self>) {
        let (tx, rx) = async_channel::bounded(1);
        crate::platform::notification_permission(move |permission| {
            let _ = tx.try_send(permission);
        });
        self.await_permission(rx, cx);
    }

    fn await_permission(
        &mut self,
        rx: async_channel::Receiver<Permission>,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |this, cx| {
            if let Ok(permission) = rx.recv().await {
                let _ = this.update(cx, |this, cx| {
                    this.permission = Some(permission);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn ask_permission(&mut self, cx: &mut Context<Self>) {
        let (tx, rx) = async_channel::bounded(1);
        crate::platform::request_notification_permission(move |permission| {
            let _ = tx.try_send(permission);
        });
        self.await_permission(rx, cx);
    }

    /// The open workspace of `project`, whose effective settings and sources show here.
    fn open_workspace(project: &p::Project, cx: &App) -> Option<p::WorkspaceDetail> {
        let app = crate::app::AppState::try_global(cx)?;
        let app = app.read(cx);
        let id = app.active_workspace.as_ref()?;
        app.workspaces
            .iter()
            .find(|w| &w.read(cx).workspace_id == id)
            .and_then(|w| w.read(cx).state.workspace.clone())
            .filter(|w| w.project_id == project.id)
    }

    fn load_project(&mut self, project: p::Project, window: &mut Window, cx: &mut Context<Self>) {
        let workspace = Self::open_workspace(&project, cx);
        let layer = serde_json::to_value(&project.settings).unwrap_or_default();
        let effective = workspace
            .as_ref()
            .and_then(|w| serde_json::to_value(&w.settings).ok())
            .unwrap_or_else(model::defaults);
        let initial = model::form_from_layer(&layer, &effective);
        self.fields = model::FIELDS
            .iter()
            .zip(&initial)
            .map(|(def, state)| field_editor(def, state, window, cx))
            .collect();
        if self.project.as_ref().map(|p| &p.id) != Some(&project.id) {
            self.secret_names.clear();
            self.secret_error = None;
        }
        self.initial = initial;
        self.field_errors.clear();
        self.problem = None;
        self.project = Some(project);
        self.workspace = workspace;
        cx.notify();
    }

    fn select_project(&mut self, project: p::Project, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.load_project(project, window, cx);
        self.refresh(cx);
    }

    fn form(&self, cx: &App) -> Vec<FieldState> {
        self.fields.iter().map(|f| f.state(cx)).collect()
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        let request = client.call::<api::GetCredentialStatus>(Default::default());
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(status) => {
                        this.credentials = Some(status);
                        this.load_error = None;
                    }
                    Err(e) => this.load_error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
        if let Some(project_id) = self.project.as_ref().map(|p| p.id.clone()) {
            let request = client.call::<api::ListProjectSecretNames>(p::ListProjectSecretNamesIn {
                project_id: project_id.clone(),
            });
            cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = this.update(cx, |this, cx| {
                    if this.project.as_ref().map(|p| &p.id) != Some(&project_id) {
                        return;
                    }
                    match result {
                        Ok(out) => this.secret_names = out.names,
                        Err(e) => this.load_error = Some(super::toast::error_text(&e, None)),
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }

    /// Calls `F`. Field errors from the server show next to the form; others toast (04).
    fn mutate<F: p::Function>(
        &mut self,
        input: F::Input,
        clear: Option<Entity<InputState>>,
        success: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pending {
            return;
        }
        let Some(client) = &self.client else {
            return;
        };
        self.pending = true;
        let changed = self.credential_changed.take();
        let request = client.call::<F>(input);
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(output) => {
                        if F::NAME == "updateProjectSettings"
                            && let Ok(project) = serde_json::from_value::<p::Project>(
                                serde_json::to_value(output).unwrap_or_default(),
                            )
                        {
                            if let Some(app) = crate::app::AppState::try_global(cx) {
                                app.read(cx).hub.clone().update(cx, |hub, cx| {
                                    if let Some(p) =
                                        hub.projects.iter_mut().find(|p| p.id == project.id)
                                    {
                                        *p = project.clone();
                                    }
                                    cx.notify();
                                });
                            }
                            this.load_project(project, window, cx);
                        }
                        if matches!(
                            F::NAME,
                            "setClaudeToken" | "setCodexAuth" | "setApiKey" | "deleteCredential"
                        ) && let Some(app) = crate::app::AppState::try_global(cx)
                        {
                            app.update(cx, |a, cx| {
                                a.credentials_rev += 1;
                                a.credential_changed = changed;
                                cx.notify();
                            });
                        }
                        if let Some(input) = clear {
                            input.update(cx, |i, cx| i.set_value("", window, cx));
                        }
                        if F::NAME == "setProjectSecret" {
                            this.secret_name
                                .update(cx, |i, cx| i.set_value("", window, cx));
                        }
                        this.login_error = None;
                        this.secret_error = None;
                        if let Some(text) = success {
                            super::toast::success(text, window, cx);
                        }
                        this.refresh(cx);
                    }
                    Err(e) => {
                        let code = super::toast::error_code(&e);
                        match (F::NAME, code.as_str()) {
                            ("updateProjectSettings", "SETTINGS_INVALID") => {
                                let detail = match &e {
                                    tempo_client::ApiError::Server { error, .. } => {
                                        error.detail.clone()
                                    }
                                    _ => None,
                                };
                                let text = super::toast::error_text(&e, None);
                                this.problem = Some(match detail {
                                    Some(detail) => format!("{text} {detail}"),
                                    None => text,
                                });
                            }
                            ("setProjectSecret", "VALIDATION_FAILED") => {
                                this.secret_error = Some(super::toast::error_text(&e, None))
                            }
                            (
                                "setClaudeToken" | "setCodexAuth" | "setApiKey",
                                "VALIDATION_FAILED",
                            ) => this.login_error = Some(super::toast::error_text(&e, None)),
                            _ => super::toast::error(&e, None, window, cx),
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn upload_codex(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let pick = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Choose Codex auth.json".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Some(path) = pick
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                .and_then(|p| p.into_iter().next())
            else {
                return;
            };
            let text = cx
                .background_executor()
                .spawn(async move {
                    use std::io::Read as _;
                    let file = std::fs::File::open(path)
                        .map_err(|_| "The auth file could not be read.")?;
                    let mut bytes = vec![];
                    file.take(1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|_| "The auth file could not be read.")?;
                    if bytes.len() > 1024 * 1024 {
                        return Err("The auth file is too large.");
                    }
                    String::from_utf8(bytes).map_err(|_| "The auth file must be UTF-8 JSON.")
                })
                .await;
            let _ = this.update_in(cx, |this, window, cx| match text {
                Ok(text) => {
                    this.secret_inputs["Codex"].update(cx, |i, cx| i.set_value(text, window, cx));
                    this.save_login("Codex", window, cx);
                }
                Err(error) => {
                    this.login_error = Some(error.into());
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn save_login(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.credential_changed = name.to_lowercase().parse().ok();
        let input = self.secret_inputs[name].clone();
        let value = input.read(cx).value().to_string();
        let saved = Some(format!(
            "{} saved",
            match name {
                "Claude" => "Claude login",
                "Codex" => "Codex login",
                other => other,
            }
        ));
        let result = match name {
            "Claude" => match value.try_into() {
                Ok(token) => {
                    self.mutate::<api::SetClaudeToken>(
                        p::SetClaudeTokenIn { token },
                        Some(input),
                        saved,
                        window,
                        cx,
                    );
                    true
                }
                Err(_) => false,
            },
            "Codex" => match value.try_into() {
                Ok(auth_json) => {
                    self.mutate::<api::SetCodexAuth>(
                        p::SetCodexAuthIn { auth_json },
                        Some(input),
                        saved,
                        window,
                        cx,
                    );
                    true
                }
                Err(_) => false,
            },
            _ => match (value.try_into(), name.to_lowercase().parse()) {
                (Ok(key), Ok(provider)) => {
                    self.mutate::<api::SetApiKey>(
                        p::SetApiKeyIn { provider, key },
                        Some(input),
                        saved,
                        window,
                        cx,
                    );
                    true
                }
                _ => false,
            },
        };
        if !result {
            self.login_error = Some("Enter a valid credential.".into());
            cx.notify();
        }
    }

    fn save_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let (layer, errors) = model::layer_from_form(&self.form(cx));
        self.field_errors = errors;
        if !self.field_errors.is_empty() {
            self.problem = Some("Check the highlighted fields.".into());
            cx.notify();
            return;
        }
        self.problem = None;
        match serde_json::from_value(layer) {
            Ok(settings) => self.mutate::<api::UpdateProjectSettings>(
                p::UpdateProjectSettingsIn {
                    project_id: project.id,
                    settings,
                },
                None,
                Some("Project settings saved".into()),
                window,
                cx,
            ),
            Err(_) => {
                self.problem = Some(crate::errors::error_message("SETTINGS_INVALID", None));
                cx.notify();
            }
        }
    }

    fn reset_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(project) = self.project.clone() {
            self.load_project(project, window, cx);
        }
    }

    fn set_secret(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project_id) = self.project.as_ref().map(|p| p.id.clone()) else {
            return;
        };
        let name = self.secret_name.read(cx).value().trim().to_string();
        let value = self.secret_value.read(cx).value().to_string();
        if !model::is_env_name(&name) {
            self.secret_error =
                Some("Use capital letters, digits and _, starting with a letter or _.".into());
            cx.notify();
            return;
        }
        if value.is_empty() {
            self.secret_error = Some("Enter a value.".into());
            cx.notify();
            return;
        }
        self.secret_error = None;
        let saved = format!("{name} saved");
        self.mutate::<api::SetProjectSecret>(
            p::SetProjectSecretIn {
                project_id,
                name,
                value,
            },
            Some(self.secret_value.clone()),
            Some(saved),
            window,
            cx,
        );
    }

    fn render_logins(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let muted = color(Token::MutedForeground, cx);
        v_flex()
            .gap_3()
            .children(
                self.login_error
                    .clone()
                    .map(|e| div().text_color(color(Token::Destructive, cx)).child(e)),
            )
            .children(
                ["Claude", "Codex", "OpenRouter", "Anthropic", "OpenAI"]
                    .into_iter()
                    .map(|name| {
                        let status = self.credentials.as_ref().map(|s| match name {
                            "Claude" => (s.claude.set, s.claude.updated_at),
                            "Codex" => (s.codex.set, s.codex.updated_at),
                            "OpenRouter" => (s.openrouter.set, s.openrouter.updated_at),
                            "Anthropic" => (s.anthropic.set, s.anthropic.updated_at),
                            _ => (s.openai.set, s.openai.updated_at),
                        });
                        let set = status.is_some_and(|s| s.0);
                        let updated = status.and_then(|s| s.1);
                        v_flex()
                            .gap_1()
                            .child(format!("{name} · {}", if set { "Set" } else { "Not set" }))
                            .children(updated.filter(|at| at.is_finite() && *at >= 0.).map(|at| {
                                div().text_sm().text_color(muted).child(format!(
                                    "Last updated {}",
                                    super::indicators::format_relative(
                                        at,
                                        super::indicators::now_ms()
                                    )
                                ))
                            }))
                            .children(
                                match name {
                                    "Claude" => {
                                        Some("Run claude setup-token, then paste the token.")
                                    }
                                    "Codex" => {
                                        Some("Run codex login, then paste ~/.codex/auth.json.")
                                    }
                                    _ => None,
                                }
                                .map(|s| div().child(s)),
                            )
                            .child(Input::new(&self.secret_inputs[name]))
                            .children((name == "Codex").then(|| {
                                Button::new("upload-codex-auth")
                                    .label("Upload auth.json")
                                    .disabled(self.pending)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.upload_codex(window, cx)
                                    }))
                            }))
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(
                                        Button::new(SharedString::from(format!("save-{name}")))
                                            .label("Save")
                                            .disabled(self.pending)
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.save_login(name, window, cx)
                                            })),
                                    )
                                    .child(
                                        Button::new(SharedString::from(format!("delete-{name}")))
                                            .label("Remove")
                                            .disabled(!set || self.pending)
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                let key = match name {
                                                    "Claude" => "claude.oauth_token",
                                                    "Codex" => "codex.auth_json",
                                                    "OpenRouter" => "openrouter.api_key",
                                                    "Anthropic" => "anthropic.api_key",
                                                    _ => "openai.api_key",
                                                };
                                                this.credential_changed =
                                                    name.to_lowercase().parse().ok();
                                                this.mutate::<api::DeleteCredential>(
                                                    p::DeleteCredentialIn { key: key.into() },
                                                    None,
                                                    Some(format!("{name} removed")),
                                                    window,
                                                    cx,
                                                );
                                            })),
                                    ),
                            )
                    }),
            )
            .into_any_element()
    }

    fn source_tag(&self, source: p::SettingsSource, cx: &App) -> impl IntoElement {
        let tint = color(
            if source == p::SettingsSource::Tempo {
                Token::Primary
            } else {
                Token::MutedForeground
            },
            cx,
        );
        Tag::custom(tint.opacity(0.12), tint, tint.opacity(0.))
            .xsmall()
            .child(model::source_label(source))
    }

    fn render_field(
        &self,
        ix: usize,
        ctx: &model::EffectiveContext,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let def = &model::FIELDS[ix];
        let field = &self.fields[ix];
        let muted = color(Token::MutedForeground, cx);
        let id = def.path.replace('.', "-");
        let effective = if matches!(def.kind, Kind::Run | Kind::Env) {
            let entries = model::effective_entries(def, ctx);
            if entries.is_empty() {
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("In effect: none. Entries set in Tempo are added to the ones in repo files.")
                    .into_any_element()
            } else {
                v_flex()
                    .gap_0p5()
                    .text_xs()
                    .children(entries.into_iter().map(|e| {
                        h_flex()
                            .gap_2()
                            .when(def.kind == Kind::Run, |row| {
                                row.child(
                                    div()
                                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                                        .child(e.key.clone()),
                                )
                            })
                            .child(div().flex_1().min_w_0().truncate().child(e.text))
                            .child(self.source_tag(e.source, cx))
                    }))
                    .into_any_element()
            }
        } else {
            let (value, source) = model::effective_leaf(def, ctx);
            h_flex()
                .gap_2()
                .text_xs()
                .child(div().text_color(muted).child("In effect"))
                .child(div().flex_1().min_w_0().child(value))
                .child(self.source_tag(source, cx))
                .into_any_element()
        };
        let error = self.field_errors.get(def.path).cloned();
        v_flex()
            .id(SharedString::from(format!("setting-{id}")))
            .role(gpui_kit::Role::Group)
            .aria_label(def.label)
            .gap_1p5()
            .py_2p5()
            .border_b_1()
            .border_color(color(Token::Border, cx))
            .child(
                h_flex()
                    .gap_3()
                    .items_start()
                    .child(
                        v_flex()
                            .flex_1()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                                    .child(def.label),
                            )
                            .children(def.hint.map(|h| div().text_xs().text_color(muted).child(h))),
                    )
                    .child(
                        Switch::new(SharedString::from(format!("{id}-set")))
                            .checked(field.set)
                            .label("Set in Tempo")
                            .accessibility_label(format!("Set {} in Tempo", def.label))
                            .disabled(self.pending)
                            .on_click(cx.listener(move |this, on: &bool, _, cx| {
                                this.fields[ix].set = *on;
                                this.field_errors.remove(model::FIELDS[ix].path);
                                cx.notify();
                            })),
                    ),
            )
            .child(effective)
            .when(field.set, |row| {
                row.child(
                    div()
                        .p_2()
                        .rounded_md()
                        .border_1()
                        .border_dashed()
                        .border_color(color(Token::Border, cx))
                        .child(self.render_editor(ix, &id, cx)),
                )
            })
            .children(error.map(|e| {
                div()
                    .text_xs()
                    .text_color(color(Token::Destructive, cx))
                    .child(e)
            }))
            .into_any_element()
    }

    fn render_editor(&self, ix: usize, id: &str, cx: &mut Context<Self>) -> AnyElement {
        let def = &model::FIELDS[ix];
        let muted = color(Token::MutedForeground, cx);
        match &self.fields[ix].editor {
            Editor::Line(input) => Input::new(input).into_any_element(),
            Editor::Area(input) => Textarea::new(input).into_any_element(),
            Editor::Choice(value) => h_flex()
                .gap_1()
                .children(def.options.iter().map(|(option, label)| {
                    let option = option.to_string();
                    Button::new(SharedString::from(format!("{id}-{option}")))
                        .small()
                        .outline()
                        .label(*label)
                        .selected(*value == option)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.fields[ix].editor = Editor::Choice(option.clone());
                            cx.notify();
                        }))
                }))
                .into_any_element(),
            Editor::Toggle(on) => Switch::new(SharedString::from(format!("{id}-value")))
                .checked(*on)
                .label(if *on { "On" } else { "Off" })
                .accessibility_label(format!("{}, set in Tempo", def.label))
                .on_click(cx.listener(move |this, on: &bool, _, cx| {
                    this.fields[ix].editor = Editor::Toggle(*on);
                    cx.notify();
                }))
                .into_any_element(),
            Editor::Instance {
                preset,
                vcpu,
                memory,
                disk,
            } => v_flex()
                .gap_2()
                .child(
                    h_flex().gap_1().children(
                        model::INSTANCE_PRESETS
                            .iter()
                            .copied()
                            .chain([model::CUSTOM])
                            .map(|option| {
                                Button::new(SharedString::from(format!("{id}-{option}")))
                                    .small()
                                    .outline()
                                    .label(if option == model::CUSTOM {
                                        "Custom"
                                    } else {
                                        option
                                    })
                                    .selected(preset == option)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if let Editor::Instance { preset, .. } =
                                            &mut this.fields[ix].editor
                                        {
                                            *preset = option.into();
                                        }
                                        cx.notify();
                                    }))
                            }),
                    ),
                )
                .when(preset == model::CUSTOM, |col| {
                    col.child(
                        h_flex().gap_2().children(
                            [("vCPU", vcpu), ("Memory (MiB)", memory), ("Disk (MB)", disk)].map(
                                |(label, input)| {
                                    v_flex()
                                        .w(px(112.))
                                        .gap_1()
                                        .child(div().text_xs().text_color(muted).child(label))
                                        .child(Input::new(input))
                                },
                            ),
                        ),
                    )
                })
                .into_any_element(),
            Editor::Run(rows) => v_flex()
                .gap_2()
                .when(rows.is_empty(), |col| {
                    col.child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child("No run scripts set in Tempo."),
                    )
                })
                .children(rows.iter().enumerate().map(|(row, r)| {
                    v_flex()
                        .gap_1()
                        .child(
                            h_flex()
                                .gap_1p5()
                                .child(div().w(px(128.)).child(Input::new(&r.id)))
                                .child(div().flex_1().child(Input::new(&r.command)))
                                .child(
                                    Button::new(SharedString::from(format!("{id}-remove-{row}")))
                                        .ghost()
                                        .small()
                                        .icon(IconName::Close)
                                        .accessibility_label(format!("Remove run script {}", row + 1))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            if let Editor::Run(rows) = &mut this.fields[ix].editor {
                                                rows.remove(row);
                                            }
                                            cx.notify();
                                        })),
                                ),
                        )
                        .child(Input::new(&r.cwd))
                        .child(
                            Checkbox::new(SharedString::from(format!("{id}-default-{row}")))
                                .checked(r.is_default)
                                .label("Default")
                                .on_click(cx.listener(move |this, on: &bool, _, cx| {
                                    if let Editor::Run(rows) = &mut this.fields[ix].editor {
                                        for (i, r) in rows.iter_mut().enumerate() {
                                            r.is_default = if i == row { *on } else { r.is_default && !*on };
                                        }
                                    }
                                    cx.notify();
                                })),
                        )
                }))
                .child(
                    Button::new(SharedString::from(format!("{id}-add")))
                        .small()
                        .outline()
                        .icon(IconName::Plus)
                        .label("Add run script")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let first = matches!(&this.fields[ix].editor, Editor::Run(rows) if rows.is_empty());
                            let editor = run_editor(
                                &model::RunRow {
                                    id: String::new(),
                                    command: String::new(),
                                    cwd: String::new(),
                                    is_default: first,
                                },
                                window,
                                cx,
                            );
                            if let Editor::Run(rows) = &mut this.fields[ix].editor {
                                rows.push(editor);
                            }
                            cx.notify();
                        })),
                )
                .into_any_element(),
            Editor::Env(rows) => v_flex()
                .gap_2()
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child("Stored as plain text. Put keys and tokens in secrets below."),
                )
                .children(rows.iter().enumerate().map(|(row, r)| {
                    h_flex()
                        .gap_1p5()
                        .child(div().w(px(160.)).child(Input::new(&r.name)))
                        .child(div().flex_1().child(Input::new(&r.value)))
                        .child(
                            Button::new(SharedString::from(format!("{id}-remove-{row}")))
                                .ghost()
                                .small()
                                .icon(IconName::Close)
                                .accessibility_label(format!("Remove variable {}", row + 1))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Editor::Env(rows) = &mut this.fields[ix].editor {
                                        rows.remove(row);
                                    }
                                    cx.notify();
                                })),
                        )
                }))
                .child(
                    Button::new(SharedString::from(format!("{id}-add")))
                        .small()
                        .outline()
                        .icon(IconName::Plus)
                        .label("Add variable")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let editor = env_editor(
                                &model::EnvRow {
                                    name: String::new(),
                                    value: String::new(),
                                },
                                window,
                                cx,
                            );
                            if let Editor::Env(rows) = &mut this.fields[ix].editor {
                                rows.push(editor);
                            }
                            cx.notify();
                        })),
                )
                .into_any_element(),
        }
    }

    fn render_project(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let muted = color(Token::MutedForeground, cx);
        let projects = crate::app::AppState::try_global(cx)
            .map(|a| a.read(cx).hub.read(cx).projects.clone())
            .unwrap_or_default();
        let Some(project) = self.project.clone() else {
            return v_flex()
                .gap_3()
                .items_center()
                .p_4()
                .child("Link a repo to start.")
                .child(
                    Button::new("settings-add-project")
                        .primary()
                        .label("Add project")
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(crate::actions::AddProject), cx)
                        }),
                )
                .into_any_element();
        };
        let layer = serde_json::to_value(&project.settings).unwrap_or_default();
        let settings = self
            .workspace
            .as_ref()
            .and_then(|w| serde_json::to_value(&w.settings).ok());
        let defaults = model::defaults();
        let ctx = model::EffectiveContext {
            settings: settings.as_ref(),
            sources: self
                .workspace
                .as_ref()
                .and_then(|w| w.settings_sources.as_ref()),
            layer: &layer,
            defaults: &defaults,
        };
        let dirty = self.form(cx) != self.initial;
        let sections = model::SECTIONS.map(|section| {
            v_flex()
                .mt_3()
                .child(
                    div()
                        .text_xs()
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .text_color(muted)
                        .child(section.to_uppercase()),
                )
                .children(
                    model::FIELDS
                        .iter()
                        .enumerate()
                        .filter(|(_, f)| f.section == section)
                        .map(|(ix, _)| self.render_field(ix, &ctx, cx))
                        .collect::<Vec<_>>(),
                )
        });
        let secret_names = self.secret_names.clone();
        let replace = secret_names
            .iter()
            .any(|n| n.as_str() == self.secret_name.read(cx).value().trim());
        v_flex()
            .gap_2()
            .when(projects.len() > 1, |col| {
                col.child(
                    h_flex().gap_1().flex_wrap().children(projects.into_iter().map(|p| {
                        let selected = p.id == project.id;
                        Button::new(SharedString::from(format!("project-settings-{}", p.id)))
                            .small()
                            .outline()
                            .label(format!("{}/{}", p.owner, p.name))
                            .selected(selected)
                            .disabled(self.pending)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select_project(p.clone(), window, cx)
                            }))
                    })),
                )
            })
            .child(div().text_xs().text_color(muted).child(match &self.workspace {
                Some(w) => format!(
                    "Values in effect for {}. Set a key in Tempo to override the repo files.",
                    w.title
                ),
                None => "Open a workspace of this project to see values from its repo files. Set a key in Tempo to override them.".into(),
            }))
            .children(sections)
            .child(
                h_flex()
                    .gap_2()
                    .py_2()
                    .children(self.problem.clone().map(|p| {
                        div()
                            .flex_1()
                            .text_xs()
                            .text_color(color(Token::Destructive, cx))
                            .child(p)
                    }))
                    .child(div().flex_1())
                    .child(
                        Button::new("reset-project")
                            .ghost()
                            .small()
                            .label("Reset")
                            .disabled(!dirty || self.pending)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.reset_project(window, cx)),
                            ),
                    )
                    .child(
                        Button::new("save-project")
                            .primary()
                            .small()
                            .label(if self.pending { "Saving…" } else { "Save" })
                            .disabled(!dirty || self.pending)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.save_project(window, cx)),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .gap_2()
                    .pt_3()
                    .border_t_1()
                    .border_color(color(Token::Border, cx))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child("Secrets"),
                    )
                    .child(div().text_xs().text_color(muted).child(
                        "Added to the environment of scripts and agents. Values are never shown again.",
                    ))
                    .when(secret_names.is_empty(), |col| {
                        col.child(div().text_xs().text_color(muted).child("No secrets."))
                    })
                    .children(secret_names.into_iter().map(|name| {
                        let label = name.clone();
                        h_flex()
                            .id(SharedString::from(format!("secret-{name}")))
                            .role(gpui_kit::Role::ListItem)
                            .aria_label(name.clone())
                            .gap_2()
                            .child(div().flex_1().text_xs().child(name.clone()))
                            .child(div().text_xs().text_color(muted).child("Set"))
                            .child(
                                Button::new(SharedString::from(format!("remove-secret-{name}")))
                                    .ghost()
                                    .small()
                                    .icon(IconName::Delete)
                                    .accessibility_label(format!("Delete {label}"))
                                    .disabled(self.pending)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        if let Some(project_id) =
                                            this.project.as_ref().map(|p| p.id.clone())
                                        {
                                            this.mutate::<api::DeleteProjectSecret>(
                                                p::DeleteProjectSecretIn {
                                                    project_id,
                                                    name: name.clone(),
                                                },
                                                None,
                                                Some(format!("{name} deleted")),
                                                window,
                                                cx,
                                            );
                                        }
                                    })),
                            )
                    }))
                    .child(
                        h_flex()
                            .gap_1p5()
                            .child(div().w(px(160.)).child(Input::new(&self.secret_name)))
                            .child(div().flex_1().child(Input::new(&self.secret_value)))
                            .child(
                                Button::new("set-secret")
                                    .small()
                                    .outline()
                                    .label(if replace { "Replace" } else { "Add" })
                                    .disabled(self.pending)
                                    .on_click(
                                        cx.listener(|this, _, window, cx| this.set_secret(window, cx)),
                                    ),
                            ),
                    )
                    .children(self.secret_error.clone().map(|e| {
                        div()
                            .text_xs()
                            .text_color(color(Token::Destructive, cx))
                            .child(e)
                    })),
            )
            .into_any_element()
    }

    fn render_notifications(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let config = cx.global::<Local>().config().clone();
        let permission = self.permission;
        let blocked = matches!(
            permission,
            Some(Permission::Denied | Permission::Unsupported)
        );
        let muted = color(Token::MutedForeground, cx);
        v_flex()
            .gap_4()
            .child(
                v_flex()
                    .gap_1p5()
                    .child(
                        Switch::new("notifications")
                            .checked(config.notifications && !blocked)
                            .label("macOS notifications")
                            .disabled(permission == Some(Permission::Unsupported))
                            .on_click(cx.listener(move |this, on: &bool, _, cx| {
                                let on = *on;
                                cx.global_mut::<Local>()
                                    .update_config(|c| c.notifications = on);
                                if on && this.permission != Some(Permission::Granted) {
                                    this.ask_permission(cx);
                                }
                                cx.notify();
                            })),
                    )
                    .child(div().text_xs().text_color(muted).child(
                        "When a turn ends, or a workspace waits for you or needs attention, while Tempo is in the background.",
                    ))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                div()
                                    .id("notification-permission")
                                    .role(gpui_kit::Role::Status)
                                    .aria_label(permission_text(permission))
                                    .text_xs()
                                    .text_color(if permission == Some(Permission::Denied) {
                                        color(Token::Destructive, cx)
                                    } else {
                                        muted
                                    })
                                    .child(permission_text(permission)),
                            )
                            .when(permission == Some(Permission::Default), |row| {
                                row.child(
                                    Button::new("allow-notifications")
                                        .small()
                                        .outline()
                                        .label("Allow notifications")
                                        .on_click(
                                            cx.listener(|this, _, _, cx| this.ask_permission(cx)),
                                        ),
                                )
                            }),
                    ),
            )
            .child(
                Switch::new("notification-sound")
                    .checked(config.sound)
                    .label("Sound")
                    .disabled(!config.notifications || blocked)
                    .on_click(|on: &bool, _, cx| {
                        let on = *on;
                        cx.global_mut::<Local>().update_config(|c| c.sound = on)
                    }),
            )
            .into_any_element()
    }
}

/// What macOS allows, as the web's `PERMISSION_TEXT`.
pub fn permission_text(permission: Option<Permission>) -> &'static str {
    match permission {
        Some(Permission::Granted) => "macOS allows notifications from Tempo.",
        Some(Permission::Denied) => {
            "macOS blocks notifications from Tempo. Allow them in System Settings → Notifications."
        }
        Some(Permission::Default) => "macOS has not been asked yet.",
        Some(Permission::Unsupported) => "This build of Tempo cannot show notifications.",
        None => "Checking…",
    }
}

impl Render for SettingsForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match self.tab {
            0 => self.render_logins(cx),
            TAB_PROJECT => self.render_project(cx),
            2 => {
                let current = cx.global::<Local>().config().theme;
                h_flex()
                    .gap_2()
                    .children(
                        [
                            ("System", SavedTheme::System),
                            ("Light", SavedTheme::Light),
                            ("Dark", SavedTheme::Dark),
                        ]
                        .map(|(label, theme)| {
                            Button::new(label)
                                .label(label)
                                .selected(current == theme)
                                .on_click(move |_, window, cx| {
                                    cx.global_mut::<Local>().update_config(|c| c.theme = theme);
                                    match theme {
                                        SavedTheme::System => {
                                            Theme::sync_system_appearance(Some(window), cx)
                                        }
                                        SavedTheme::Light => {
                                            Theme::change(ThemeMode::Light, Some(window), cx)
                                        }
                                        SavedTheme::Dark => {
                                            Theme::change(ThemeMode::Dark, Some(window), cx)
                                        }
                                    }
                                })
                        }),
                    )
                    .into_any_element()
            }
            _ => self.render_notifications(cx),
        };
        v_flex()
            .id("settings-form")
            .size_full()
            .overflow_y_scroll()
            .gap_2()
            .children(self.load_error.clone().map(|e| {
                h_flex()
                    .gap_2()
                    .child(div().text_color(color(Token::Destructive, cx)).child(e))
                    .child(
                        Button::new("retry-settings")
                            .small()
                            .label("Retry")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.load_error = None;
                                this.refresh(cx);
                            })),
                    )
            }))
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denied_permission_says_so() {
        assert!(permission_text(Some(Permission::Denied)).contains("blocks"));
        assert!(permission_text(Some(Permission::Granted)).contains("allows"));
        assert_ne!(
            permission_text(Some(Permission::Default)),
            permission_text(None)
        );
    }

    fn project() -> p::Project {
        serde_json::from_value(serde_json::json!({
            "id": "a", "installationId": 1, "repoId": 1, "owner": "acme", "name": "api",
            "defaultBranch": "main", "settings": {"git": {"branch_prefix": "me/"}}, "sortOrder": 0
        }))
        .unwrap()
    }

    #[gpui_kit::test]
    fn project_fields_are_typed_and_validated_before_saving(cx: &mut gpui_kit::TestAppContext) {
        use gpui_kit::test::TestWindowExt as _;
        cx.background_executor.allow_parking();
        let (handle, form) = cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_global(crate::storage::Local::load(None));
            let runtime = crate::client::ClientRuntime::start().unwrap();
            let state = cx.new(|cx| crate::app::AppState::new(runtime, cx));
            state.update(cx, |s, cx| {
                s.hub.update(cx, |h, _| h.projects = vec![project()])
            });
            crate::app::set_global_for_test(state, cx);
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| SettingsForm::new(window, cx))
            })
            .unwrap()
        });
        let sleep = model::FIELDS
            .iter()
            .position(|f| f.path == "environment.sleep_after_idle_minutes")
            .unwrap();
        let prefix = model::FIELDS
            .iter()
            .position(|f| f.path == "git.branch_prefix")
            .unwrap();
        form.update(cx, |f, cx| f.show_tab(TAB_PROJECT, cx));
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find("git-branch_prefix-set").checked(), Some(true));
            window.click("environment-sleep_after_idle_minutes-set", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            form.update(cx, |f, cx| {
                assert!(f.fields[sleep].set);
                assert!(f.fields[prefix].set);
                let Editor::Line(input) = &f.fields[sleep].editor else {
                    panic!("a number is one line");
                };
                assert_eq!(input.read(cx).value().as_ref(), "15");
                input.update(cx, |i, cx| i.set_value("3", window, cx));
                f.save_project(window, cx);
                assert_eq!(
                    f.field_errors
                        .get("environment.sleep_after_idle_minutes")
                        .map(String::as_str),
                    Some("Use a whole number from 5 to 240.")
                );
                assert_eq!(f.problem.as_deref(), Some("Check the highlighted fields."));
                let Editor::Line(input) = &f.fields[sleep].editor else {
                    unreachable!()
                };
                input.update(cx, |i, cx| i.set_value("30", window, cx));
                let (layer, errors) = model::layer_from_form(&f.form(cx));
                assert!(errors.is_empty());
                assert_eq!(
                    layer,
                    serde_json::json!({
                        "environment": {"sleep_after_idle_minutes": 30},
                        "git": {"branch_prefix": "me/"}
                    })
                );
                assert_ne!(f.form(cx), f.initial);
            });
        })
        .unwrap();
    }
}
