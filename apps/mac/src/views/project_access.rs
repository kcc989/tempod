//! 04, Settings → project → Access, natively (07): visibility and project members for admins;
//! Leave project for other members.

use super::social_model::{self as social, Access};
use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    Subscription, Window, div,
};
use tempo_client::{ApiError, Client};
use tempo_protocol::{self as p, api};

const ROLES: [(p::ProjectRole, &str); 3] = [
    (p::ProjectRole::Read, "Read"),
    (p::ProjectRole::Write, "Write"),
    (p::ProjectRole::Admin, "Admin"),
];

pub struct ProjectAccessView {
    client: Option<Client>,
    project: p::Project,
    members: Vec<p::ProjectMember>,
    new_role: p::ProjectRole,
    /// The Make public confirmation is showing (04, Confirmations).
    confirm_public: bool,
    loading: bool,
    pending: bool,
    left: bool,
    error: Option<String>,
    username: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

fn role_index(role: p::ProjectRole) -> usize {
    ROLES.iter().position(|(r, _)| *r == role).unwrap_or(0)
}

impl ProjectAccessView {
    pub fn new(project: p::Project, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let client = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client());
        let username = cx.new(|cx| InputState::new(window, cx).placeholder("Username".to_string()));
        let subscriptions = vec![cx.observe(&username, |_, _, cx| cx.notify())];
        let mut view = Self {
            client,
            project,
            members: vec![],
            new_role: p::ProjectRole::Write,
            confirm_public: false,
            loading: false,
            pending: false,
            left: false,
            error: None,
            username,
            _subscriptions: subscriptions,
        };
        if view.admin() {
            view.load(cx);
        }
        view
    }

    fn admin(&self) -> bool {
        Access::of_project(&self.project).can_admin()
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        self.loading = true;
        let request = client.call::<api::ListProjectMembers>(p::ListProjectMembersIn {
            project_id: self.project.id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(members) => this.members = members,
                    Err(error) => this.error = Some(super::toast::error_text(&error, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Runs one write, then reloads members; `after` sees the result.
    fn write<T: Send + 'static>(
        &mut self,
        request: impl std::future::Future<Output = Result<T, ApiError>> + Send + 'static,
        after: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(value) => after(this, value, cx),
                    Err(error) => this.error = Some(super::toast::error_text(&error, None)),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn set_visibility(&mut self, visibility: p::ProjectVisibility, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.confirm_public = false;
        let request = client.call::<api::SetProjectVisibility>(p::SetProjectVisibilityIn {
            project_id: self.project.id.clone(),
            visibility,
        });
        self.write(request, |this, project, _| this.project = project, cx);
    }

    fn put_member(&mut self, username: String, role: p::ProjectRole, cx: &mut Context<Self>) {
        let (Some(client), Ok(username)) = (self.client.clone(), username.try_into()) else {
            return;
        };
        let request = client.call::<api::PutProjectMember>(p::PutProjectMemberIn {
            project_id: self.project.id.clone(),
            username,
            role,
        });
        self.write(request, |this, _, cx| this.load(cx), cx);
    }

    fn remove_member(&mut self, user_id: String, leaving: bool, cx: &mut Context<Self>) {
        let (Some(client), Ok(user_id)) = (self.client.clone(), user_id.try_into()) else {
            return;
        };
        let request = client.call::<api::DeleteProjectMember>(p::DeleteProjectMemberIn {
            project_id: self.project.id.clone(),
            user_id,
        });
        self.write(
            request,
            move |this, _, cx| {
                if leaving {
                    this.left = true;
                } else {
                    this.load(cx);
                }
            },
            cx,
        );
    }

    fn leave(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let request = client.session_user_id();
        self.write(
            request,
            |this, user_id, cx| this.remove_member(user_id, true, cx),
            cx,
        );
    }
}

impl Render for ProjectAccessView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let error = self
            .error
            .clone()
            .map(|error| div().text_color(color(Token::Destructive, cx)).child(error));
        if !self.admin() {
            return v_flex()
                .gap_2()
                .child(
                    div()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child("Leave project"),
                )
                .children(error)
                .child(if self.left {
                    div().child("You left this project.").into_any_element()
                } else {
                    Button::new("leave-project")
                        .danger()
                        .label("Leave project")
                        .disabled(self.pending)
                        .on_click(cx.listener(|this, _, _, cx| this.leave(cx)))
                        .into_any_element()
                })
                .into_any_element();
        }
        let _ = window;
        let visibility = self
            .project
            .visibility
            .unwrap_or(p::ProjectVisibility::Private);
        let muted = color(Token::MutedForeground, cx);
        v_flex()
            .gap_4()
            .children(error)
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child("Visibility"),
                    )
                    .child(
                        TabBar::new("project-visibility")
                            .selected_index(usize::from(visibility == p::ProjectVisibility::Public))
                            .on_click(cx.listener(move |this, index: &usize, _, cx| {
                                if *index == 1 && visibility == p::ProjectVisibility::Private {
                                    this.confirm_public = true;
                                    cx.notify();
                                } else if *index == 0 && visibility == p::ProjectVisibility::Public
                                {
                                    this.set_visibility(p::ProjectVisibility::Private, cx);
                                }
                            }))
                            .children(["Private", "Public"].map(|name| Tab::new().label(name))),
                    )
                    .children(self.confirm_public.then(|| {
                        v_flex()
                            .gap_2()
                            .child(div().child(social::MAKE_PUBLIC))
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(
                                        Button::new("confirm-make-public")
                                            .primary()
                                            .label("Make public")
                                            .disabled(self.pending)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.set_visibility(
                                                    p::ProjectVisibility::Public,
                                                    cx,
                                                )
                                            })),
                                    )
                                    .child(
                                        Button::new("cancel-make-public")
                                            .ghost()
                                            .label("Cancel")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.confirm_public = false;
                                                cx.notify();
                                            })),
                                    ),
                            )
                    })),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child("Members"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(muted)
                            .child(social::ORGANIZATION_ROLES_NOTE),
                    )
                    .children(self.loading.then(|| div().child("Loading members…")))
                    .children(self.members.clone().into_iter().enumerate().map(
                        |(index, member)| {
                            let username = member.username.clone();
                            let user_id = member.user_id.clone();
                            h_flex()
                                .gap_2()
                                .child(div().flex_1().child(match &member.username {
                                    Some(username) => format!("{} · {username}", member.name),
                                    None => member.name.clone(),
                                }))
                                .child(
                                    TabBar::new(("member-role", index))
                                        .selected_index(role_index(member.role))
                                        .on_click(cx.listener(move |this, i: &usize, _, cx| {
                                            if let (Some(username), Some((role, _))) =
                                                (username.clone(), ROLES.get(*i))
                                            {
                                                this.put_member(username, *role, cx);
                                            }
                                        }))
                                        .children(ROLES.map(|(_, label)| Tab::new().label(label))),
                                )
                                .child(
                                    Button::new(("remove-member", index))
                                        .ghost()
                                        .label("Remove")
                                        .disabled(self.pending)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.remove_member(user_id.clone(), false, cx)
                                        })),
                                )
                        },
                    ))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Input::new(&self.username)
                                    .aria_label("Username")
                                    .disabled(self.pending),
                            )
                            .child(
                                TabBar::new("new-member-role")
                                    .selected_index(role_index(self.new_role))
                                    .on_click(cx.listener(|this, i: &usize, _, cx| {
                                        if let Some((role, _)) = ROLES.get(*i) {
                                            this.new_role = *role;
                                            cx.notify();
                                        }
                                    }))
                                    .children(ROLES.map(|(_, label)| Tab::new().label(label))),
                            )
                            .child(
                                Button::new("add-member")
                                    .label("Add member")
                                    .disabled(
                                        self.pending
                                            || self.username.read(cx).value().trim().is_empty(),
                                    )
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        let username =
                                            this.username.read(cx).value().trim().to_string();
                                        let role = this.new_role;
                                        this.username.update(cx, |input, cx| {
                                            input.set_value("", window, cx)
                                        });
                                        this.put_member(username, role, cx);
                                    })),
                            ),
                    ),
            )
            .into_any_element()
    }
}
