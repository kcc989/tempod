use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, StatefulInteractiveElement as _, Styled as _, Window, div,
};
use tempo_protocol::{self as p, api};

pub struct RolesSettings {
    client: Option<tempo_client::Client>,
    workspace_id: Option<String>,
    roles: Vec<p::RoleInfo>,
    selected: Option<p::RoleInfo>,
    name: Entity<InputState>,
    text: Entity<TextareaState>,
    adding: bool,
    pending: bool,
    error: Option<String>,
    loaded: bool,
}
impl RolesSettings {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            workspace_id: None,
            client: crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client()),
            roles: vec![],
            selected: None,
            name: cx.new(|cx| InputState::new(window, cx).placeholder("Role name")),
            text: cx.new(|cx| TextareaState::new(window, cx).auto_grow(8, 24)),
            adding: false,
            pending: false,
            error: None,
            loaded: false,
        }
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else { return };
        self.loaded = true;
        let request = client.call::<api::ListRoles>(p::ListRolesIn {
            workspace_id: self.workspace_id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(roles) => {
                        this.roles = roles;
                        this.error = None;
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn reload_repo(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else { return };
        let Some(workspace_id) = &self.workspace_id else {
            return;
        };
        self.pending = true;
        let request = client.call::<api::ReloadRoles>(p::ReloadRolesIn {
            workspace_id: workspace_id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(roles) => {
                        this.roles = roles;
                        this.selected = None;
                        this.error = None;
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn select(&mut self, role: p::RoleInfo, window: &mut Window, cx: &mut Context<Self>) {
        self.adding = false;
        self.pending = true;
        self.selected = Some(role.clone());
        self.name
            .update(cx, |i, cx| i.set_value(role.name.clone(), window, cx));
        let Some(client) = &self.client else { return };
        let request = client.call::<api::GetRoleText>(p::GetRoleTextIn {
            name: p::RoleName(role.name),
            scope: role.scope,
            workspace_id: self.workspace_id.clone(),
        });
        let selected = self.selected.as_ref().map(|r| (r.name.clone(), r.scope));
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.selected.as_ref().map(|r| (r.name.clone(), r.scope)) != selected {
                    return;
                }
                this.pending = false;
                match result {
                    Ok(file) => {
                        this.text
                            .update(cx, |i, cx| i.set_value(file.text, window, cx));
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else { return };
        let input = p::PutUserRoleIn {
            name: self.name.read(cx).value().to_string(),
            text: self.text.read(cx).value().to_string(),
        };
        self.pending = true;
        let request = client.call::<api::PutUserRole>(input);
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(role) => {
                        this.selected = Some(role);
                        this.adding = false;
                        this.refresh(cx);
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn delete(&mut self, cx: &mut Context<Self>) {
        let Some(role) = &self.selected else { return };
        let Some(client) = &self.client else { return };
        self.pending = true;
        let request = client.call::<api::DeleteUserRole>(p::DeleteUserRoleIn {
            name: p::RoleName(role.name.clone()),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        this.selected = None;
                        this.refresh(cx);
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
impl Render for RolesSettings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let current =
            crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).active_workspace.clone());
        if current != self.workspace_id {
            self.workspace_id = current;
            self.loaded = false;
            self.selected = None;
            self.adding = false;
        }
        if !self.loaded {
            self.refresh(cx);
        }
        let editable = self.adding
            || self
                .selected
                .as_ref()
                .is_some_and(|r| r.scope == p::RoleScope::User);
        let actions = h_flex().gap_2()
            .child(Button::new("new-role").label("Add role").on_click(cx.listener(|this, _, window, cx| {
                this.selected = None;
                this.adding = true;
                this.error = None;
                this.name.update(cx, |input, cx| input.set_value("", window, cx));
                this.text.update(cx, |input, cx| input.set_value(
                    "---\ndescription: Describe the job\naccess: read-only\nrequestable: true\n---\nDescribe what the agent should do.\n",
                    window, cx,
                ));
                cx.notify();
            })))
            .child(Button::new("refresh-roles").ghost().label("Refresh")
                .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))))
            .children(self.workspace_id.is_some().then(|| {
                Button::new("reload-repo-roles").ghost().label("Reload repo roles")
                    .disabled(self.pending)
                    .on_click(cx.listener(|this, _, _, cx| this.reload_repo(cx)))
            }));
        let roles = self.roles.clone().into_iter().enumerate().map(|(n, role)| {
            let detail = role
                .error
                .as_deref()
                .map(|error| format!(" · {error}"))
                .unwrap_or_else(|| {
                    role.shadowed_by
                        .map(|scope| format!(" · Shadowed by {scope}"))
                        .unwrap_or_default()
                });
            let label = format!("{} · {}{}", role.name, role.scope, detail);
            Button::new(("role", n)).ghost().label(label).on_click(
                cx.listener(move |this, _, window, cx| this.select(role.clone(), window, cx)),
            )
        });
        let editor = (self.adding || self.selected.is_some()).then(|| {
            v_flex()
                .gap_2()
                .child(div().child("Name"))
                .child(Input::new(&self.name).disabled(!self.adding || self.pending))
                .child(div().child("Role file"))
                .child(Textarea::new(&self.text).disabled(!editable || self.pending))
                .children(editable.then(|| {
                    Button::new("save-role")
                        .label("Save")
                        .disabled(self.pending)
                        .on_click(cx.listener(|this, _, _, cx| this.save(cx)))
                }))
                .children(
                    self.selected
                        .as_ref()
                        .is_some_and(|role| role.scope == p::RoleScope::User)
                        .then(|| {
                            Button::new("delete-role")
                                .ghost()
                                .label("Delete")
                                .disabled(self.pending)
                                .on_click(cx.listener(|this, _, _, cx| this.delete(cx)))
                        }),
                )
        });
        v_flex()
            .id("roles-settings")
            .size_full()
            .overflow_y_scroll()
            .gap_3()
            .p_4()
            .child(actions)
            .children(roles)
            .children(editor)
            .children(self.error.clone().map(|error| div().child(error)))
    }
}

pub struct EventsView {
    client: tempo_client::Client,
    workspace_id: String,
    change: Entity<InputState>,
    events: Vec<p::LifecycleLogEvent>,
    trace: String,
    error: Option<String>,
}
impl EventsView {
    pub fn new(
        client: tempo_client::Client,
        workspace_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            client,
            workspace_id,
            change: cx.new(|cx| InputState::new(window, cx).placeholder("Change ID")),
            events: vec![],
            trace: String::new(),
            error: None,
        }
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let change = self.change.read(cx).value().trim().to_string();
        let request = self
            .client
            .call::<api::ListLifecycleEvents>(p::ListLifecycleEventsIn {
                workspace_id: self.workspace_id.clone(),
                change_id: (!change.is_empty()).then_some(change),
                before_seq: None,
                limit: Some(500.),
            });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(page) => {
                        this.events = page.events;
                        this.error = None;
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let workspace_id = self.workspace_id.clone();
        cx.spawn(async move |this, cx| {
            let result = client
                .call::<api::GetTrace>(p::GetTraceIn {
                    workspace_id: workspace_id.clone(),
                    event_id: id,
                })
                .await;
            let roles = client
                .call::<api::ListRoles>(p::ListRolesIn {
                    workspace_id: Some(workspace_id),
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(trace) => {
                        this.trace = format!(
                            "Trace\n{}\nRole filters\n{}",
                            serde_json::to_string_pretty(&trace).unwrap_or_default(),
                            serde_json::to_string_pretty(&roles.ok()).unwrap_or_default()
                        )
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
impl Render for EventsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("lifecycle-events")
            .size_full()
            .overflow_y_scroll()
            .gap_2()
            .child(
                h_flex().gap_2().child(Input::new(&self.change)).child(
                    Button::new("refresh-events")
                        .label("Refresh")
                        .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                ),
            )
            .children(
                self.events
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(i, event)| {
                        let value = serde_json::to_value(&event.event).unwrap_or_default();
                        let id = value["id"].as_str().unwrap_or_default().to_string();
                        let label = format!(
                            "{} · {} · {}",
                            event.seq,
                            value["type"].as_str().unwrap_or_default(),
                            value["changeId"].as_str().unwrap_or("No change")
                        );
                        Button::new(("event", i)).ghost().label(label).on_click(
                            cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)),
                        )
                    }),
            )
            .child(div().font_family("monospace").child(self.trace.clone()))
            .children(self.error.clone().map(|e| div().child(e)))
    }
}
