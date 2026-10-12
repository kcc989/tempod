use crate::storage::{Local, Theme as SavedTheme, TranscriptDetail};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::{Disableable as _, Selectable as _, Theme, ThemeMode, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Task, Window, div,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;
use tempo_protocol::{self as p, api};

struct Field {
    path: Vec<String>,
    original: Value,
    input: Entity<TextareaState>,
    source: String,
}
pub struct SettingsForm {
    pub tab: usize,
    pub section: usize,
    client: Option<tempo_client::Client>,
    credentials: Option<p::CredentialStatus>,
    secret_inputs: BTreeMap<String, Entity<InputState>>,
    fields: Vec<Field>,
    removed_settings: Vec<Vec<String>>,
    project: Option<p::Project>,
    project_id: Option<String>,
    secret_name: Entity<InputState>,
    secret_value: Entity<InputState>,
    secret_names: Vec<String>,
    add_name: Entity<InputState>,
    add_value: Entity<InputState>,
    error: Option<String>,
    pending: bool,
    credential_changed: Option<p::CredentialProvider>,
    codex_login: Option<p::StartCodexLoginOut>,
    codex_busy: bool,
    codex_login_task: Option<Task<()>>,
    codex_upload: bool,
}
impl SettingsForm {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let app = crate::app::AppState::try_global(cx);
        let client = app.as_ref().and_then(|a| a.read(cx).client());
        let workspace = app.as_ref().and_then(|a| {
            a.read(cx)
                .workspaces
                .iter()
                .find(|w| Some(&w.read(cx).workspace_id) == a.read(cx).active_workspace.as_ref())
                .and_then(|w| w.read(cx).state.workspace.clone())
        });
        let project = workspace
            .as_ref()
            .and_then(|w| {
                app.as_ref()?
                    .read(cx)
                    .hub
                    .read(cx)
                    .projects
                    .iter()
                    .find(|p| p.id == w.project_id)
                    .cloned()
            })
            .or_else(|| {
                app.as_ref()?
                    .read(cx)
                    .hub
                    .read(cx)
                    .projects
                    .first()
                    .cloned()
            });
        let project_id = project.as_ref().map(|p| p.id.clone());
        let fields = project
            .as_ref()
            .map(|project| project_fields(project, workspace.as_ref(), window, cx))
            .unwrap_or_default();
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
            section: 0,
            client,
            credentials: None,
            secret_inputs,
            fields,
            removed_settings: vec![],
            project,
            project_id,
            secret_name: cx.new(|cx| InputState::new(window, cx).placeholder("Secret name")),
            secret_value: cx.new(|cx| {
                InputState::new(window, cx)
                    .masked(true)
                    .placeholder("Secret value")
            }),
            secret_names: vec![],
            add_name: cx.new(|cx| InputState::new(window, cx).placeholder("Name")),
            add_value: cx.new(|cx| InputState::new(window, cx).placeholder("Command or value")),
            error: None,
            pending: false,
            credential_changed: None,
            codex_login: None,
            codex_busy: false,
            codex_login_task: None,
            codex_upload: false,
        };
        this.refresh(cx);
        this
    }
    fn select_project(&mut self, project: p::Project, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let app = crate::app::AppState::global(cx);
        let workspace = app.read(cx).workspaces.iter().find_map(|w| {
            w.read(cx)
                .state
                .workspace
                .as_ref()
                .filter(|w| w.project_id == project.id)
                .cloned()
        });
        self.fields = project_fields(&project, workspace.as_ref(), window, cx);
        self.removed_settings.clear();
        self.project_id = Some(project.id.clone());
        self.project = Some(project);
        self.secret_names.clear();
        self.error = None;
        self.refresh(cx);
        cx.notify();
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if let Some(client) = &self.client {
            let request = client.call::<api::GetCredentialStatus>(Default::default());
            cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = this.update(cx, |this, cx| {
                    match result {
                        Ok(status) => this.credentials = Some(status),
                        Err(e) => this.error = Some(e.to_string()),
                    }
                    cx.notify();
                });
            })
            .detach();
            if let Some(project_id) = self.project_id.clone() {
                let request =
                    client.call::<api::ListProjectSecretNames>(p::ListProjectSecretNamesIn {
                        project_id: project_id.clone(),
                    });
                cx.spawn(async move |this, cx| {
                    let result = request.await;
                    let _ = this.update(cx, |this, cx| {
                        if this.project_id.as_ref() != Some(&project_id) {
                            return;
                        }
                        if let Ok(out) = result {
                            this.secret_names = out.names;
                        }
                        cx.notify();
                    });
                })
                .detach();
            }
        }
    }
    fn mutate<F: p::Function>(
        &mut self,
        input: F::Input,
        clear: Option<Entity<InputState>>,
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
                                serde_json::to_value(output).unwrap_or(Value::Null),
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
                            this.project = Some(project);
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
                        this.error = None;
                        this.refresh(cx);
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn codex_connected(&mut self, cx: &mut Context<Self>) {
        self.codex_login = None;
        self.codex_busy = false;
        self.error = None;
        if let Some(app) = crate::app::AppState::try_global(cx) {
            app.update(cx, |a, cx| {
                a.credentials_rev += 1;
                a.credential_changed = Some(p::CredentialProvider::Codex);
                cx.notify();
            });
        }
        self.refresh(cx);
        cx.notify();
    }
    fn connect_codex(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.codex_busy || self.pending {
            return;
        }
        self.codex_busy = true;
        self.error = None;
        cx.notify();
        self.codex_login_task = Some(cx.spawn(async move |this, cx| {
            let result = client.call::<api::StartCodexLogin>(p::Empty {}).await;
            let login = match result {
                Ok(login) => login,
                Err(error) => {
                    let _ = this.update(cx, |this, cx| {
                        this.codex_busy = false;
                        this.error = Some(error.to_string());
                        cx.notify();
                    });
                    return;
                }
            };
            if this
                .update(cx, |this, cx| {
                    this.codex_login = Some(login.clone());
                    cx.notify();
                })
                .is_err()
            {
                return;
            }
            loop {
                cx.background_executor()
                    .timer(Duration::from_secs_f64((login.interval_ms / 1000.).max(1.)))
                    .await;
                let Ok(login_id) = login.login_id.clone().try_into() else {
                    return;
                };
                let result = client
                    .call::<api::PollCodexLogin>(p::PollCodexLoginIn { login_id })
                    .await;
                match result {
                    Ok(result) if result.status == p::PollCodexLoginOutStatus::Pending => continue,
                    Ok(result) if result.status == p::PollCodexLoginOutStatus::Connected => {
                        let _ = this.update(cx, |this, cx| this.codex_connected(cx));
                    }
                    result => {
                        let _ = this.update(cx, |this, cx| {
                            this.codex_login = None;
                            this.codex_busy = false;
                            this.error = Some(match result {
                                Err(error) => error.to_string(),
                                _ => "Codex login expired. Connect again to get a new code.".into(),
                            });
                            cx.notify();
                        });
                    }
                }
                break;
            }
        }));
    }

    fn cancel_codex(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let Some(login) = &self.codex_login else {
            return;
        };
        let Ok(login_id) = login.login_id.clone().try_into() else {
            return;
        };
        self.codex_login_task.take();
        self.codex_login_task = Some(cx.spawn(async move |this, cx| {
            let result = client
                .call::<api::CancelCodexLogin>(p::CancelCodexLoginIn { login_id })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.codex_login = None;
                this.codex_busy = false;
                this.error = result.err().map(|error| error.to_string());
                cx.notify();
            });
        }));
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
                    this.error = Some(error.into());
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
        let result = match name {
            "Claude" => match value.try_into() {
                Ok(token) => {
                    self.mutate::<api::SetClaudeToken>(
                        p::SetClaudeTokenIn { token },
                        Some(input),
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
                        window,
                        cx,
                    );
                    true
                }
                _ => false,
            },
        };
        if !result {
            self.error = Some("Enter a valid credential.".into());
            cx.notify();
        }
    }
    fn codex_card(
        &self,
        set: bool,
        updated: Option<f64>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut card = v_flex().gap_3()
            .child(div().text_lg().child("Codex"))
            .child(if set { "Set" } else { "Not set" })
            .child("Sign in with ChatGPT using a one-time code. Enable device-code login in your ChatGPT security settings or ask your workspace admin.");
        if let Some(login) = &self.codex_login {
            let uri = login.verification_url.clone();
            card = card
                .child("Open the sign-in page, then enter this code:")
                .child(
                    div()
                        .text_3xl()
                        .font_family("monospace")
                        .child(login.user_code.clone()),
                )
                .child(
                    Button::new("codex-open-sign-in")
                        .primary()
                        .label("Open sign-in page")
                        .on_click(move |_, _, cx| cx.open_url(&uri)),
                )
                .child(
                    Button::new("codex-cancel")
                        .label("Cancel")
                        .on_click(cx.listener(|this, _, _, cx| this.cancel_codex(cx))),
                )
                .child("Waiting for sign-in… This code expires in 15 minutes.");
        } else {
            card = card.child(
                Button::new("codex-connect")
                    .primary()
                    .disabled(self.codex_busy || self.pending)
                    .label(if self.codex_busy || self.pending {
                        "Connecting…"
                    } else if set {
                        "Reconnect Codex"
                    } else {
                        "Connect Codex"
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.connect_codex(cx))),
            );
        }
        card = card.child(
            Button::new("codex-upload-toggle")
                .disabled(self.codex_busy || self.pending)
                .label("Use auth.json instead")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.codex_upload = !this.codex_upload;
                    cx.notify();
                })),
        );
        card = card.children(updated.filter(|at| at.is_finite() && *at >= 0.).map(|at| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64()
                * 1000.;
            let minutes = ((now - at).max(0.) / 60_000.) as u64;
            let label = if minutes < 1 {
                "Just now".into()
            } else if minutes < 60 {
                format!("{minutes} minutes ago")
            } else if minutes < 1440 {
                format!("{} hours ago", minutes / 60)
            } else {
                format!("{} days ago", minutes / 1440)
            };
            div().text_sm().child(format!("Last updated · {label}"))
        }));
        card = card.child(
            Button::new("delete-Codex")
                .label("Remove")
                .disabled(!set || self.pending || self.codex_busy)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.credential_changed = Some(p::CredentialProvider::Codex);
                    this.mutate::<api::DeleteCredential>(
                        p::DeleteCredentialIn {
                            key: "codex.auth_json".into(),
                        },
                        None,
                        window,
                        cx,
                    );
                })),
        );
        if self.codex_upload {
            card = card
                .child(
                    Button::new("upload-codex-auth")
                        .label("Upload auth.json")
                        .disabled(self.codex_busy || self.pending)
                        .on_click(cx.listener(|this, _, window, cx| this.upload_codex(window, cx))),
                )
                .child("Run codex login, then paste ~/.codex/auth.json.")
                .child(
                    Input::new(&self.secret_inputs["Codex"])
                        .id("codex-auth-json")
                        .aria_label("Codex auth.json"),
                )
                .child(
                    Button::new("codex-upload-save")
                        .disabled(self.codex_busy || self.pending)
                        .label("Save")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.save_login("Codex", window, cx)),
                        ),
                );
        }
        card
    }
    fn save_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let mut layer = serde_json::to_value(&project.settings).unwrap_or(json!({}));
        for path in &self.removed_settings {
            remove_segments(&mut layer, path);
        }
        for field in &self.fields {
            if self
                .removed_settings
                .iter()
                .any(|p| field.path.starts_with(p))
            {
                continue;
            }
            let text = field.input.read(cx).value().to_string();
            let value = match &field.original {
                Value::String(_) => Value::String(text),
                Value::Array(_) => Value::Array(
                    text.lines()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| Value::String(s.into()))
                        .collect(),
                ),
                _ => match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => {
                        self.error = Some(format!("Invalid value for {}", field.path.join(".")));
                        cx.notify();
                        return;
                    }
                },
            };
            if value != field.original {
                set_segments(&mut layer, &field.path, &value);
            }
        }
        match serde_json::from_value(layer) {
            Ok(settings) => self.mutate::<api::UpdateProjectSettings>(
                p::UpdateProjectSettingsIn {
                    project_id: project.id,
                    settings,
                },
                None,
                window,
                cx,
            ),
            Err(_) => {
                self.error = Some("Project settings are invalid.".into());
                cx.notify();
            }
        }
    }
    fn add_setting(&mut self, run: bool, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.add_name.read(cx).value().to_string();
        let value = self.add_value.read(cx).value().to_string();
        if name.trim().is_empty() {
            return;
        }
        let path = if run {
            vec![
                "scripts".into(),
                "run".into(),
                name.clone(),
                "command".into(),
            ]
        } else {
            vec!["environment_variables".into(), name]
        };
        self.fields.retain(|f| f.path != path);
        self.fields.push(Field {
            path,
            original: Value::String(String::new()),
            input: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(1, 12)
                    .default_value(value)
            }),
            source: "Tempo".into(),
        });
        if run {
            for (key, value) in [
                ("cwd", Value::String(String::new())),
                ("default", Value::Bool(false)),
            ] {
                let path = vec![
                    "scripts".into(),
                    "run".into(),
                    self.add_name.read(cx).value().to_string(),
                    key.into(),
                ];
                let text = if value.is_string() {
                    String::new()
                } else {
                    "false".into()
                };
                self.fields.push(Field {
                    path,
                    original: value,
                    input: cx.new(|cx| TextareaState::new(window, cx).default_value(text)),
                    source: "Tempo".into(),
                });
            }
        }
        cx.notify();
    }
    fn set_secret(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project_id) = self.project_id.clone() else {
            return;
        };
        let name = self.secret_name.read(cx).value().to_string();
        let value = self.secret_value.read(cx).value().to_string();
        self.mutate::<api::SetProjectSecret>(
            p::SetProjectSecretIn {
                project_id,
                name,
                value,
            },
            Some(self.secret_value.clone()),
            window,
            cx,
        );
    }
}
fn merge_settings(target: &mut Value, layer: &Value) {
    if let Value::Object(fields) = layer {
        for (key, value) in fields {
            merge_settings(&mut target[key], value);
        }
    } else {
        *target = layer.clone();
    }
}
fn project_fields(
    project: &p::Project,
    workspace: Option<&p::WorkspaceDetail>,
    window: &mut Window,
    cx: &mut Context<SettingsForm>,
) -> Vec<Field> {
    let mut effective: Value =
        serde_json::from_str(include_str!("../../resources/settings-defaults.json"))
            .expect("shared defaults");
    if let Some(w) = workspace {
        effective = serde_json::to_value(&w.settings).unwrap_or(effective);
    } else {
        merge_settings(
            &mut effective,
            &serde_json::to_value(&project.settings).unwrap_or(Value::Null),
        );
    }
    let mut values = vec![];
    flatten(&[], &effective, &mut values);
    values
        .into_iter()
        .map(|(path, value)| {
            let text = match &value {
                Value::String(s) => s.clone(),
                Value::Array(a) => a
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => value.to_string(),
            };
            let source = workspace
                .and_then(|w| w.settings_sources.as_ref())
                .and_then(|s| s.get(&path.join(".")))
                .map(ToString::to_string)
                .unwrap_or_else(|| {
                    if workspace.is_some() {
                        "default".into()
                    } else {
                        "Defaults + Tempo overrides; file settings load when a workspace opens"
                            .into()
                    }
                });
            Field {
                path,
                original: value,
                input: cx.new(|cx| {
                    TextareaState::new(window, cx)
                        .auto_grow(1, 12)
                        .default_value(text)
                }),
                source,
            }
        })
        .collect()
}
fn remove_segments(target: &mut Value, path: &[String]) {
    if let Some((first, rest)) = path.split_first()
        && let Some(map) = target.as_object_mut()
    {
        if rest.is_empty() {
            map.remove(first);
        } else if let Some(child) = map.get_mut(first) {
            remove_segments(child, rest);
        }
    }
}
fn flatten(path: &[String], value: &Value, out: &mut Vec<(Vec<String>, Value)>) {
    if let Value::Object(fields) = value {
        for (k, v) in fields {
            let mut path = path.to_vec();
            path.push(k.clone());
            flatten(&path, v, out);
        }
    } else {
        out.push((path.to_vec(), value.clone()));
    }
}
fn set_segments(target: &mut Value, path: &[String], value: &Value) {
    if path.is_empty() {
        return;
    }
    if !target.is_object() {
        *target = json!({});
    }
    if path.len() == 1 {
        target[&path[0]] = value.clone();
    } else {
        set_segments(&mut target[&path[0]], &path[1..], value);
    }
}
#[cfg(test)]
fn set_path(target: &mut Value, path: &str, value: &Value) {
    set_segments(
        target,
        &path.split('.').map(Into::into).collect::<Vec<_>>(),
        value,
    );
}

impl Render for SettingsForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match self.tab {
            0 => v_flex()
                .gap_3()
                .children(
                    ["Claude", "Codex", "OpenRouter", "Anthropic", "OpenAI"]
                        .into_iter()
                        .map(|name| {
                            let set = self
                                .credentials
                                .as_ref()
                                .map(|s| match name {
                                    "Claude" => s.claude.set,
                                    "Codex" => s.codex.set,
                                    "OpenRouter" => s.openrouter.set,
                                    "Anthropic" => s.anthropic.set,
                                    _ => s.openai.set,
                                })
                                .unwrap_or(false);
                            let updated = self.credentials.as_ref().and_then(|s| match name {
                                "Claude" => s.claude.updated_at,
                                "Codex" => s.codex.updated_at,
                                "OpenRouter" => s.openrouter.updated_at,
                                "Anthropic" => s.anthropic.updated_at,
                                _ => s.openai.updated_at,
                            });
                            if name == "Codex" {
                                return self.codex_card(set, updated, cx).into_any_element();
                            }
                            v_flex()
                                .gap_1()
                                .child(format!("{name} · {}", if set { "Set" } else { "Not set" }))
                                .children(updated.filter(|at| at.is_finite() && *at >= 0.).map(
                                    |at| {
                                        let now = std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_secs_f64()
                                            * 1000.;
                                        let minutes = ((now - at).max(0.) / 60_000.) as u64;
                                        let label = if minutes < 1 {
                                            "Just now".into()
                                        } else if minutes < 60 {
                                            format!("{minutes} minutes ago")
                                        } else if minutes < 1440 {
                                            format!("{} hours ago", minutes / 60)
                                        } else {
                                            format!("{} days ago", minutes / 1440)
                                        };
                                        div().text_sm().child(format!("Last updated · {label}"))
                                    },
                                ))
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
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.save_login(name, window, cx)
                                                    },
                                                )),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!(
                                                "delete-{name}"
                                            )))
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
                                                    window,
                                                    cx,
                                                );
                                            })),
                                        ),
                                )
                                .into_any_element()
                        }),
                )
                .into_any_element(),
            1 => v_flex()
                .gap_2()
                .children(
                    crate::app::AppState::try_global(cx)
                        .map(|a| a.read(cx).hub.read(cx).projects.clone())
                        .unwrap_or_default()
                        .into_iter()
                        .map(|p| {
                            Button::new(SharedString::from(format!("project-settings-{}", p.id)))
                                .label(format!("{}/{}", p.owner, p.name))
                                .disabled(self.pending)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.select_project(p.clone(), window, cx)
                                }))
                        }),
                )
                .children(
                    self.project
                        .as_ref()
                        .map(|p| div().child(format!("{}/{}", p.owner, p.name))),
                )
                .children(
                    self.project
                        .is_none()
                        .then(|| div().child("Link a project to edit its settings.")),
                )
                .children(self.fields.iter().enumerate().filter(|(_, field)| {
                    let group = field.path.first().map(String::as_str);
                    match self.section {
                        0 => group == Some("agent"),
                        1 => group == Some("scripts"),
                        2 => matches!(group, Some("environment" | "environment_variables")),
                        3 => group == Some("git"),
                        4 => group == Some("prompts"),
                        _ => false,
                    }
                }).map(|(ix, f)| {
                    let mut path = f.path.clone();
                    if path.len() > 3 && path[0] == "scripts" && path[1] == "run" {
                        path.truncate(3);
                    }
                    let removed = self.removed_settings.iter().any(|p| f.path.starts_with(p));
                    v_flex()
                        .child(format!(
                            "{} · {}",
                            f.path.join("."),
                            if removed {
                                "Use inherited value after save"
                            } else {
                                &f.source
                            }
                        ))
                        .child(Textarea::new(&f.input).disabled(removed || self.pending))
                        .child(
                            Button::new(("reset-setting", ix))
                                .label(if removed {
                                    "Keep override"
                                } else {
                                    "Reset override"
                                })
                                .disabled(self.pending)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if this.removed_settings.contains(&path) {
                                        this.removed_settings.retain(|p| p != &path);
                                    } else {
                                        this.removed_settings.push(path.clone());
                                    }
                                    cx.notify();
                                })),
                        )
                }))
                .children((self.section < 5).then(|| {
                    Button::new("save-project")
                        .label("Save project settings")
                        .disabled(self.project.is_none() || self.pending)
                        .on_click(cx.listener(|this, _, window, cx| this.save_project(window, cx)))
                }))
                .children((self.section == 1 || self.section == 2).then(|| {
                    v_flex()
                        .child(Input::new(&self.add_name))
                        .child(Input::new(&self.add_value))
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    Button::new("add-run-setting")
                                        .label("Add run script")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.add_setting(true, window, cx)
                                        })),
                                )
                                .child(
                                    Button::new("add-env-setting")
                                        .label("Add environment variable")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.add_setting(false, window, cx)
                                        })),
                                ),
                        )
                }))
                .children((self.section == 5).then(|| {
                    v_flex()
                        .child("Project secrets")
                        .children(self.secret_names.iter().map(|name| {
                            let name = name.clone();
                            let label = name.clone();
                            Button::new(SharedString::from(format!("remove-secret-{name}")))
                                .label(format!("Remove {label}"))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if let Some(project_id) = this.project_id.clone() {
                                        this.mutate::<api::DeleteProjectSecret>(
                                            p::DeleteProjectSecretIn {
                                                project_id,
                                                name: name.clone(),
                                            },
                                            None,
                                            window,
                                            cx,
                                        );
                                    }
                                }))
                        }))
                        .child(Input::new(&self.secret_name))
                        .child(Input::new(&self.secret_value))
                        .child(
                            Button::new("set-secret")
                                .label("Set secret")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, window, cx| this.set_secret(window, cx))),
                        )
                }))
                .into_any_element(),
            2 => v_flex()
                .gap_2()
                .child(h_flex().gap_2().child("Theme").children(
                    [
                        ("System", SavedTheme::System),
                        ("Light", SavedTheme::Light),
                        ("Dark", SavedTheme::Dark),
                    ]
                    .map(|(label, theme)| {
                        Button::new(label)
                            .label(label)
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
                ))
                .child(
                    h_flex().gap_2().child("Transcript detail").children(
                        [
                            ("Default", TranscriptDetail::Default),
                            ("Detailed", TranscriptDetail::Detailed),
                        ]
                        .map(|(label, detail)| {
                            let current = cx.global::<Local>().config().transcript_detail;
                            Button::new(SharedString::from(format!("detail-{label}")))
                                .label(label)
                                .selected(current == detail)
                                .on_click(move |_, _, cx| {
                                    cx.global_mut::<Local>()
                                        .update_config(|c| c.transcript_detail = detail);
                                })
                        }),
                    ),
                )
                .into_any_element(),
            _ => {
                let config = cx.global::<Local>().config().clone();
                v_flex()
                    .gap_2()
                    .child(
                        Button::new("notifications")
                            .label(if config.notifications {
                                "Turn notifications off"
                            } else {
                                "Turn notifications on"
                            })
                            .on_click(|_, _, cx| {
                                let enable = !cx.global::<Local>().config().notifications;
                                cx.global_mut::<Local>()
                                    .update_config(|c| c.notifications = enable);
                                if enable {
                                    crate::platform::request_notification_permission(|_| {});
                                }
                            }),
                    )
                    .child(
                        Button::new("notification-sound")
                            .label(if config.sound {
                                "Sound on"
                            } else {
                                "Sound off"
                            })
                            .on_click(|_, _, cx| {
                                cx.global_mut::<Local>()
                                    .update_config(|c| c.sound = !c.sound)
                            }),
                    )
                    .into_any_element()
            }
        };
        v_flex()
            .id("settings-form")
            .size_full()
            .overflow_y_scroll()
            .gap_2()
            .children(self.error.clone().map(|e| div().child(e)))
            .child(body)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editing_a_leaf_preserves_inherited_and_other_overrides() {
        let mut layer = json!({"git":{"branch_prefix":"tempo/"},"scripts":{"setup":"bun install"}});
        set_path(&mut layer, "git.archive_on_merge", &json!(true));
        assert_eq!(layer["git"]["branch_prefix"], "tempo/");
        assert_eq!(layer["scripts"]["setup"], "bun install");
        assert!(layer.get("environment").is_none());
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;
    #[test]
    fn run_ids_with_dots_remain_one_key() {
        let mut layer = json!({});
        set_segments(
            &mut layer,
            &[
                "scripts".into(),
                "run".into(),
                "dev.web".into(),
                "command".into(),
            ],
            &json!("bun dev"),
        );
        assert_eq!(layer["scripts"]["run"]["dev.web"]["command"], "bun dev");
        assert!(layer["scripts"]["run"].get("dev").is_none());
    }
}

#[cfg(test)]
mod defaults_tests {
    use super::*;
    #[test]
    fn native_project_defaults_decode_and_partial_overrides_preserve_inherited_values() {
        let mut effective: Value =
            serde_json::from_str(include_str!("../../resources/settings-defaults.json")).unwrap();
        merge_settings(
            &mut effective,
            &json!({"environment":{"sleep_after_idle_minutes":30},"prompts":{"general":"First line\nSecond line"}}),
        );
        let settings: p::Settings = serde_json::from_value(effective).unwrap();
        assert_eq!(settings.environment.sleep_after_idle_minutes, 30);
        assert_eq!(settings.environment.egress_policy, p::EgressPolicy::Open);
        assert_eq!(settings.prompts.general, "First line\nSecond line");
        let mut layer = json!({"scripts":{"run":{"dev.web":{"command":"bun dev"}}},"environment_variables":{"APP_MODE":"dev","OTHER":"keep"}});
        remove_segments(
            &mut layer,
            &["scripts".into(), "run".into(), "dev.web".into()],
        );
        remove_segments(
            &mut layer,
            &["environment_variables".into(), "APP_MODE".into()],
        );
        let layer: p::SettingsLayer = serde_json::from_value(layer).unwrap();
        assert!(layer.scripts.unwrap().run.unwrap().is_empty());
        assert_eq!(
            layer.environment_variables.unwrap().get("OTHER").unwrap(),
            "keep"
        );
    }
}
