//! Settings → Agents (04; 07 "Same"): the user's agents and an editor (01, Agent profiles).
use super::agents_model::{self, AgentForm, ServerForm};
use super::chat_model::{agent_label, new_chat_agents};
use super::tokens::{Token, color};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{
    Disableable as _, Selectable as _, Sizable as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use std::collections::BTreeMap;
use tempo_protocol::{self as p, AgentId, api};

struct ServerInputs {
    name: Entity<InputState>,
    kind: String,
    command: Entity<InputState>,
    args: Entity<TextareaState>,
    url: Entity<InputState>,
    vars: Entity<TextareaState>,
}

#[derive(Clone, PartialEq)]
enum Selected {
    None,
    New,
    Agent(String),
}

pub struct AgentsSettings {
    client: Option<tempo_client::Client>,
    agents: Vec<p::AgentSummary>,
    credentials: Option<p::CredentialStatus>,
    credentials_rev: u64,
    login_error: Option<String>,
    selected: Selected,
    loaded: Option<String>,
    name: Entity<InputState>,
    handle: Entity<InputState>,
    access: p::AgentAccess,
    output_kind: p::OutputKind,
    project_default: bool,
    description: Entity<InputState>,
    model: Entity<InputState>,
    level: Entity<InputState>,
    prompt: Entity<TextareaState>,
    allow: Entity<InputState>,
    deny: Entity<InputState>,
    base_agent: AgentId,
    playwright: bool,
    servers: Vec<ServerInputs>,
    errors: BTreeMap<String, String>,
    pending: bool,
    error: Option<String>,
}

impl AgentsSettings {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let client = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client());
        let input = |placeholder: &'static str, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder))
        };
        let mut this = Self {
            client,
            agents: vec![],
            credentials: None,
            credentials_rev: 0,
            login_error: None,
            selected: Selected::None,
            loaded: None,
            name: input("Name", window, cx),
            handle: input("Handle", window, cx),
            access: p::AgentAccess::ReadOnly,
            output_kind: p::OutputKind::Note,
            project_default: true,
            description: input("Description", window, cx),
            model: input("Agent default", window, cx),
            level: input("Agent default", window, cx),
            prompt: cx.new(|cx| TextareaState::new(window, cx).auto_grow(4, 16)),
            allow: input("Empty allows every built-in tool", window, cx),
            deny: input("For example Edit, Write", window, cx),
            base_agent: AgentId::Claude,
            playwright: true,
            servers: vec![],
            errors: BTreeMap::new(),
            pending: false,
            error: None,
        };
        this.refresh(cx);
        if let Some(app) = crate::app::AppState::try_global(cx) {
            this.credentials_rev = app.read(cx).credentials_rev;
            cx.observe(&app, |this, app, cx| {
                let rev = app.read(cx).credentials_rev;
                if this.credentials_rev != rev {
                    this.credentials_rev = rev;
                    this.refresh_credentials(cx);
                }
            })
            .detach();
        }
        this.refresh_credentials(cx);
        this
    }

    fn refresh_credentials(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else { return };
        self.credentials = None;
        self.login_error = None;
        let rev = self.credentials_rev;
        let request = client.call::<api::GetCredentialStatus>(p::Empty {});
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                if this.credentials_rev != rev {
                    return;
                }
                match result {
                    Ok(status) => this.credentials = Some(status),
                    Err(error) => this.login_error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else { return };
        let request = client.call::<api::ListAgents>(p::Empty {});
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(agents) => this.agents = agents,
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn server_inputs(s: &ServerForm, window: &mut Window, cx: &mut Context<Self>) -> ServerInputs {
        let text = |v: &str, window: &mut Window, cx: &mut Context<Self>| {
            let v = v.to_string();
            cx.new(|cx| {
                let mut state = InputState::new(window, cx);
                state.set_value(v, window, cx);
                state
            })
        };
        let area = |v: &str, window: &mut Window, cx: &mut Context<Self>| {
            let v = v.to_string();
            cx.new(|cx| {
                let mut state = TextareaState::new(window, cx).auto_grow(2, 6);
                state.set_value(v, window, cx);
                state
            })
        };
        ServerInputs {
            name: text(&s.name, window, cx),
            kind: if s.kind.is_empty() {
                "stdio".into()
            } else {
                s.kind.clone()
            },
            command: text(&s.command, window, cx),
            args: area(&s.args, window, cx),
            url: text(&s.url, window, cx),
            vars: area(&s.vars, window, cx),
        }
    }

    fn fill(&mut self, form: &AgentForm, window: &mut Window, cx: &mut Context<Self>) {
        for (input, value) in [
            (&self.name, &form.name),
            (&self.description, &form.description),
            (&self.model, &form.model),
            (&self.level, &form.thought_level),
            (&self.allow, &form.allow),
            (&self.deny, &form.deny),
        ] {
            let value = value.clone();
            input.update(cx, |i, cx| i.set_value(value, window, cx));
        }
        let prompt = form.system_prompt.clone();
        self.prompt
            .update(cx, |i, cx| i.set_value(prompt, window, cx));
        self.base_agent = form.base_agent;
        self.playwright = form.playwright;
        self.servers = form
            .servers
            .iter()
            .map(|s| Self::server_inputs(s, window, cx))
            .collect();
        self.errors.clear();
        self.error = None;
    }

    fn form(&self, cx: &Context<Self>) -> AgentForm {
        let text = |i: &Entity<InputState>| i.read(cx).value().to_string();
        let area = |i: &Entity<TextareaState>| i.read(cx).value().to_string();
        AgentForm {
            name: text(&self.name),
            description: text(&self.description),
            base_agent: self.base_agent,
            model: text(&self.model),
            thought_level: text(&self.level),
            system_prompt: area(&self.prompt),
            allow: text(&self.allow),
            deny: text(&self.deny),
            playwright: self.playwright,
            servers: self
                .servers
                .iter()
                .map(|s| ServerForm {
                    name: text(&s.name),
                    kind: s.kind.clone(),
                    command: text(&s.command),
                    args: area(&s.args),
                    url: text(&s.url),
                    vars: area(&s.vars),
                })
                .collect(),
        }
    }

    fn select_new(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.selected = Selected::New;
        self.loaded = None;
        self.handle.update(cx, |i, cx| i.set_value("", window, cx));
        self.access = p::AgentAccess::ReadOnly;
        self.output_kind = p::OutputKind::Note;
        self.project_default = false;
        self.fill(&AgentForm::default(), window, cx);
        if let Some(agent) = new_chat_agents(self.credentials.as_ref()).first() {
            self.base_agent = *agent;
        }
        cx.notify();
    }

    fn select(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = &self.client else { return };
        self.selected = Selected::Agent(id.clone());
        let request = client.call::<api::GetAgent>(p::GetAgentIn {
            agent_id: id.clone(),
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.selected != Selected::Agent(id.clone()) {
                    return;
                }
                match result {
                    Ok(agent) => {
                        this.handle.update(cx, |i, cx| {
                            i.set_value(agent.handle.to_string(), window, cx)
                        });
                        this.access = agent.access;
                        this.output_kind = agent.output_kind;
                        this.project_default = agent.base_agent == p::AgentBase::Auto;
                        this.fill(&agents_model::form_from_library_agent(&agent), window, cx);
                        this.loaded = Some(agent.name.to_string());
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn bump_rev(cx: &mut Context<Self>) {
        if let Some(app) = crate::app::AppState::try_global(cx) {
            app.update(cx, |a, cx| {
                a.agent_library_rev += 1;
                cx.notify();
            });
        }
    }

    fn can_save(&self) -> bool {
        if self.selected != Selected::New {
            return true;
        }
        let available = new_chat_agents(self.credentials.as_ref());
        if self.project_default {
            !available.is_empty()
        } else {
            available.contains(&self.base_agent)
        }
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        if !self.can_save() {
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        let definition = match agents_model::validate_library(
            &self.form(cx),
            self.handle.read(cx).value().as_str(),
            self.access,
            self.output_kind,
            self.project_default,
        ) {
            Ok(d) => d,
            Err(errors) => {
                self.errors = errors;
                cx.notify();
                return;
            }
        };
        self.errors.clear();
        self.pending = true;
        let agent_id = match &self.selected {
            Selected::Agent(id) => Some(id.clone()),
            _ => None,
        };
        let request = client.call::<api::SaveAgent>(p::SaveAgentIn {
            agent_id,
            definition,
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(saved) => {
                        this.error = None;
                        this.refresh(cx);
                        Self::bump_rev(cx);
                        this.select(saved.id, window, cx);
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Selected::Agent(id) = self.selected.clone() else {
            return;
        };
        let name = self.loaded.clone().unwrap_or_default();
        let weak = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let weak = weak.clone();
            let id = id.clone();
            alert
                .title(format!("Delete {name}? Open chats keep using it."))
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let _ = weak.update(cx, |this, cx| this.confirm_delete(id.clone(), window, cx));
                    true
                })
        });
    }

    fn confirm_delete(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.pending = true;
        let request = client.call::<api::DeleteAgent>(p::DeleteAgentIn { agent_id: id });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        this.selected = Selected::None;
                        this.loaded = None;
                        this.refresh(cx);
                        Self::bump_rev(cx);
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn field(
        &self,
        label: &str,
        key: &str,
        hint: Option<&str>,
        input: impl IntoElement,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let note = self
            .errors
            .get(key)
            .map(|e| {
                div()
                    .text_sm()
                    .text_color(color(Token::Destructive, cx))
                    .child(e.clone())
            })
            .or_else(|| {
                hint.map(|h| {
                    div()
                        .text_sm()
                        .text_color(color(Token::MutedForeground, cx))
                        .child(h.to_string())
                })
            });
        v_flex()
            .gap_1()
            .child(div().text_sm().child(label.to_string()))
            .child(input)
            .children(note)
    }

    fn editor(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let servers = self.servers.iter().enumerate().map(|(i, s)| {
            let key = |f: &str| format!("server.{i}.{f}");
            let kinds = h_flex()
                .gap_1()
                .children(["stdio", "http", "sse"].map(|kind| {
                    Button::new(SharedString::from(format!("server-{i}-{kind}")))
                        .label(kind)
                        .small()
                        .selected(s.kind == kind)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.servers[i].kind = kind.into();
                            cx.notify();
                        }))
                }));
            let body = if s.kind == "stdio" {
                v_flex()
                    .gap_2()
                    .child(self.field("Command", &key("command"), None, Input::new(&s.command), cx))
                    .child(self.field(
                        "Arguments",
                        &key("args"),
                        Some("One per line."),
                        Textarea::new(&s.args),
                        cx,
                    ))
            } else {
                v_flex().child(self.field("URL", &key("url"), None, Input::new(&s.url), cx))
            };
            v_flex()
                .gap_2()
                .p_2()
                .border_1()
                .rounded_md()
                .border_color(color(Token::Border, cx))
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().flex_1().child(self.field(
                            "Name",
                            &key("name"),
                            None,
                            Input::new(&s.name),
                            cx,
                        )))
                        .child(kinds)
                        .child(
                            Button::new(SharedString::from(format!("server-{i}-remove")))
                                .ghost()
                                .label("Remove")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.servers.remove(i);
                                    cx.notify();
                                })),
                        ),
                )
                .child(body)
                .child(self.field(
                    if s.kind == "stdio" { "Env" } else { "Headers" },
                    &key("vars"),
                    Some("One NAME=${SECRET} per line. Uses a project env var or secret."),
                    Textarea::new(&s.vars),
                    cx,
                ))
        });
        let is_existing = matches!(self.selected, Selected::Agent(_));
        let available = new_chat_agents(self.credentials.as_ref());
        let base = self.field(
            "Base agent",
            "baseAgent",
            None,
            v_flex().gap_1()
                .child(h_flex().gap_1().flex_wrap().child(
                    Button::new("project-default").label("Project default")
                        .selected(self.project_default)
                        .on_click(cx.listener(|this, _, _, cx| { this.project_default = true; cx.notify(); }))
                ).children(available.iter().copied().map(|agent| {
                    let selected = !self.project_default && self.base_agent == agent;
                    Button::new(SharedString::from(format!("base-{agent}")))
                        .label(agent_label(agent))
                        .with_variant(if selected { ButtonVariant::Primary } else { ButtonVariant::Default })
                        .selected(selected)
                        .accessibility_label(format!("{}{}", agent_label(agent), if selected { " (selected)" } else { "" }))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.project_default = false;
                        this.base_agent = agent;
                            cx.notify();
                        }))
                })))
                .child(div().min_h(px(20.)).text_sm().text_color(color(Token::MutedForeground, cx))
                    .children(agents_model::unsupported_note(self.base_agent)))
                .children((self.credentials.is_some() && !available.contains(&self.base_agent)).then(|| {
                    div().text_sm().text_color(color(Token::MutedForeground, cx)).child(format!("{} is not connected. Its saved base agent is unchanged. Connect it in Logins or choose a connected agent.", agent_label(self.base_agent)))
                })),
            cx,
        );
        v_flex()
            .flex_shrink_0()
            .gap_4()
            .child(
                h_flex()
                    .items_start()
                    .gap_4()
                    .child(div().flex_1().min_w_0().child(self.field(
                        "Name",
                        "name",
                        None,
                        Input::new(&self.name),
                        cx,
                    )))
                    .child(div().flex_1().min_w_0().child(base)),
            )
            .child(self.field("Handle", "handle", None, Input::new(&self.handle), cx))
            .child(h_flex().gap_1().children(
                [p::AgentAccess::ReadOnly, p::AgentAccess::Write].map(|value| {
                    Button::new(SharedString::from(format!("access-{value}")))
                        .label(value.to_string())
                        .selected(self.access == value)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.access = value;
                            cx.notify();
                        }))
                }),
            ))
            .child(
                h_flex().gap_1().children(
                    [
                        p::OutputKind::Plan,
                        p::OutputKind::Review,
                        p::OutputKind::Note,
                    ]
                    .map(|value| {
                        Button::new(SharedString::from(format!("output-{value}")))
                            .label(value.to_string())
                            .selected(self.output_kind == value)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.output_kind = value;
                                cx.notify();
                            }))
                    }),
                ),
            )
            .child(
                div().text_sm().child("Definition JSON").child(
                    agents_model::validate_library(
                        &self.form(cx),
                        self.handle.read(cx).value().as_str(),
                        self.access,
                        self.output_kind,
                        self.project_default,
                    )
                    .ok()
                    .and_then(|d| serde_json::to_string_pretty(&d).ok())
                    .unwrap_or_else(|| "Complete the fields to preview the definition.".into()),
                ),
            )
            .children(is_existing.then(|| {
                Button::new("duplicate-agent")
                    .label("Duplicate")
                    .on_click(cx.listener(|this, _, window, cx| {
                        let name = this.name.read(cx).value().to_string();
                        let handle = this.handle.read(cx).value().to_string();
                        this.name.update(cx, |i, cx| {
                            i.set_value(
                                format!("{} copy", name.chars().take(55).collect::<String>()),
                                window,
                                cx,
                            )
                        });
                        this.handle.update(cx, |i, cx| {
                            i.set_value(
                                format!("{}-copy", handle.chars().take(27).collect::<String>()),
                                window,
                                cx,
                            )
                        });
                        this.selected = Selected::New;
                        this.loaded = None;
                        cx.notify();
                    }))
            }))
            .child(self.field(
                "Description",
                "description",
                None,
                Input::new(&self.description),
                cx,
            ))
            .child(
                h_flex()
                    .gap_3()
                    .child(div().flex_1().child(self.field(
                        "Model",
                        "model",
                        Some("The agent reports the choices."),
                        Input::new(&self.model),
                        cx,
                    )))
                    .child(div().flex_1().child(self.field(
                        "Reasoning level",
                        "thoughtLevel",
                        Some("For example low, medium or high."),
                        Input::new(&self.level),
                        cx,
                    ))),
            )
            .child(self.field(
                "System prompt",
                "systemPrompt",
                Some("At most 32,000 characters."),
                Textarea::new(&self.prompt),
                cx,
            ))
            .child(
                h_flex()
                    .gap_4()
                    .child(div().flex_1().min_w_0().child(self.field(
                        "Allowed tools",
                        "allow",
                        Some("Empty allows every built-in tool. Denied wins."),
                        Input::new(&self.allow),
                        cx,
                    )))
                    .child(div().flex_1().min_w_0().child(self.field(
                        "Denied tools",
                        "deny",
                        Some("Use the base agent's tool names, for example Edit."),
                        Input::new(&self.deny),
                        cx,
                    ))),
            )
            .child(
                Switch::new("playwright")
                    .label("Playwright browser")
                    .checked(self.playwright)
                    .on_click(cx.listener(|this, checked: &bool, _, cx| {
                        this.playwright = *checked;
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .border_t_1()
                    .border_color(color(Token::Border, cx))
                    .pt_4()
                    .text_sm()
                    .child("MCP servers"),
            )
            .children(self.errors.get("servers").map(|e| {
                div()
                    .text_sm()
                    .text_color(color(Token::Destructive, cx))
                    .child(e.clone())
            }))
            .children(servers)
            .child(
                Button::new("add-server")
                    .label("Add MCP server")
                    .on_click(cx.listener(|this, _, window, cx| {
                        let inputs = Self::server_inputs(&ServerForm::default(), window, cx);
                        this.servers.push(inputs);
                        cx.notify();
                    })),
            )
            .child(
                h_flex()
                    .border_t_1()
                    .border_color(color(Token::Border, cx))
                    .pt_3()
                    .gap_2()
                    .children(is_existing.then(|| {
                        Button::new("delete-agent")
                            .ghost()
                            .label("Delete")
                            .disabled(self.pending)
                            .on_click(cx.listener(|this, _, window, cx| this.delete(window, cx)))
                    }))
                    .child(div().flex_1())
                    .child(
                        Button::new("cancel-agent")
                            .ghost()
                            .label("Cancel")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.selected = Selected::None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("save-agent")
                            .primary()
                            .label(if self.pending { "Saving…" } else { "Save" })
                            .disabled(self.pending || !self.can_save())
                            .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
                    ),
            )
    }
}

impl Render for AgentsSettings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        let list = self.agents.iter().map(|a| {
            let id = a.id.clone();
            let concrete_base = a.base_agent.to_string().parse::<p::AgentId>().ok();
            let base_label = concrete_base.map(agent_label).unwrap_or("Project default");
            let login = match self.credentials.as_ref() {
                _ if concrete_base.is_none() => "",
                Some(credentials)
                    if concrete_base
                        .is_some_and(|base| new_chat_agents(Some(credentials)).contains(&base)) =>
                {
                    "Connected"
                }
                Some(_) => "Login required",
                None if self.login_error.is_some() => "Login unavailable",
                None => "Checking login…",
            };
            Button::new(SharedString::from(format!("library-agent-{}", a.id)))
                .ghost()
                .w_full()
                .h_auto()
                .py_2()
                .px_3()
                .selected(self.selected == Selected::Agent(a.id.clone()))
                .accessibility_label(format!(
                    "{} · {}",
                    a.name.as_str(),
                    a.base_agent.to_string().as_str()
                ))
                .child(
                    h_flex()
                        .w_full()
                        .gap_3()
                        .items_center()
                        .child(
                            gpui_kit::component::Icon::new(IconName::Bot)
                                .size(px(16.))
                                .text_color(muted),
                        )
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap_1()
                                .text_left()
                                .child(
                                    div()
                                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                        .truncate()
                                        .child(a.name.to_string()),
                                )
                                .children((!a.description.is_empty()).then(|| {
                                    div()
                                        .text_sm()
                                        .text_color(muted)
                                        .truncate()
                                        .child(a.description.to_string())
                                })),
                        )
                        .child(
                            v_flex()
                                .items_end()
                                .gap_1()
                                .text_sm()
                                .text_color(muted)
                                .child(base_label)
                                .children((!login.is_empty()).then(|| div().child(login))),
                        ),
                )
                .on_click(
                    cx.listener(move |this, _, window, cx| this.select(id.clone(), window, cx)),
                )
        });
        v_flex()
            .id("agents-settings")
            .h_full()
            .overflow_y_scroll()
            .gap_3()
            .child(
                h_flex()
                    .justify_between()
                    .child(
                        Button::new("connect-agent")
                            .ghost()
                            .label("Connect another agent")
                            .on_click(cx.listener(|_, _, _, cx| super::settings::open_logins(cx))),
                    )
                    .child(
                        Button::new("new-agent")
                            .with_variant(if self.selected == Selected::None {
                                ButtonVariant::Primary
                            } else {
                                ButtonVariant::Ghost
                            })
                            .icon(IconName::Plus)
                            .label("New agent")
                            .disabled(new_chat_agents(self.credentials.as_ref()).is_empty())
                            .on_click(
                                cx.listener(|this, _, window, cx| this.select_new(window, cx)),
                            ),
                    ),
            )
            .children(
                (self.credentials.is_none() && self.login_error.is_none())
                    .then(|| div().text_sm().text_color(muted).child("Loading logins…")),
            )
            .children(self.login_error.clone().map(|error| {
                h_flex().gap_2().child(div().text_sm().child(error)).child(
                    Button::new("retry-agent-logins")
                        .ghost()
                        .label("Retry loading logins")
                        .on_click(cx.listener(|this, _, _, cx| this.refresh_credentials(cx))),
                )
            }))
            .children(
                (self.credentials.is_some()
                    && new_chat_agents(self.credentials.as_ref()).is_empty())
                .then(|| {
                    div()
                        .text_sm()
                        .text_color(muted)
                        .child("Connect an agent in Logins to create an agent.")
                }),
            )
            .children(self.error.clone().map(|e| {
                div()
                    .text_sm()
                    .text_color(color(Token::Destructive, cx))
                    .child(e)
            }))
            .children(
                (self.agents.is_empty() && self.selected != Selected::New)
                    .then(|| div().text_color(muted).child("No agents yet.")),
            )
            .child(
                v_flex()
                    .flex_shrink_0()
                    .border_b_1()
                    .border_color(color(Token::Border, cx))
                    .children(list),
            )
            .children((self.selected != Selected::None).then(|| self.editor(cx)))
    }
}
