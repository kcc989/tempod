//! 04, `/organizations`, natively (07): the caller's organizations, invitations with Accept and
//! Decline, and New organization. Members and namespace pages open in the default browser.

use super::tokens::{Token, color};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    Subscription, Window, div,
};
use tempo_client::{Client, Organization, UserInvitation, slug_from_name};

pub struct OrganizationsView {
    client: Client,
    server_url: Option<String>,
    organizations: Vec<Organization>,
    invitations: Vec<UserInvitation>,
    loading: bool,
    pending: bool,
    slug_edited: bool,
    error: Option<String>,
    name: Entity<InputState>,
    slug: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

impl OrganizationsView {
    pub fn new(
        client: Client,
        server_url: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("Name".to_string()));
        let slug = cx.new(|cx| InputState::new(window, cx).placeholder("Slug".to_string()));
        let subscriptions = vec![
            cx.subscribe_in(&name, window, |this: &mut Self, _, event, window, cx| {
                if matches!(event, gpui_kit::component::input::InputEvent::Change)
                    && !this.slug_edited
                {
                    let suggested = slug_from_name(&this.name.read(cx).value());
                    this.slug
                        .update(cx, |input, cx| input.set_value(suggested, window, cx));
                }
                cx.notify();
            }),
            cx.subscribe_in(&slug, window, |this: &mut Self, input, event, _, cx| {
                if matches!(event, gpui_kit::component::input::InputEvent::Change) {
                    let suggested = slug_from_name(&this.name.read(cx).value());
                    this.slug_edited = input.read(cx).value() != suggested;
                }
                cx.notify();
            }),
        ];
        let mut view = Self {
            client,
            server_url,
            organizations: vec![],
            invitations: vec![],
            loading: false,
            pending: false,
            slug_edited: false,
            error: None,
            name,
            slug,
            _subscriptions: subscriptions,
        };
        view.refresh(cx);
        view
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        let organizations = self.client.organizations();
        let invitations = self.client.user_invitations();
        cx.spawn(async move |this, cx| {
            let (organizations, invitations) = (organizations.await, invitations.await);
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match (organizations, invitations) {
                    (Ok(organizations), Ok(invitations)) => {
                        this.organizations = organizations;
                        this.invitations = invitations;
                    }
                    (Err(error), _) | (_, Err(error)) => {
                        this.error = Some(super::toast::error_text(&error, None))
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.name.read(cx).value().trim().to_string();
        let slug = self.slug.read(cx).value().trim().to_string();
        if self.pending || name.is_empty() || slug.is_empty() {
            return;
        }
        self.pending = true;
        self.error = None;
        let request = self.client.create_organization(&name, &slug);
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                match result {
                    Ok(_) => {
                        this.slug_edited = false;
                        this.name
                            .update(cx, |input, cx| input.set_value("", window, cx));
                        this.slug
                            .update(cx, |input, cx| input.set_value("", window, cx));
                        this.refresh(cx);
                    }
                    Err(error) => this.error = Some(super::toast::error_text(&error, None)),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn answer(&mut self, invitation_id: String, accept: bool, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        let request = self.client.answer_invitation(&invitation_id, accept);
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(()) => this.refresh(cx),
                    Err(error) => this.error = Some(super::toast::error_text(&error, None)),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for OrganizationsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let origin = self
            .server_url
            .clone()
            .map(|url| url.trim_end_matches('/').to_string());
        v_flex()
            .gap_4()
            .children(
                self.error
                    .clone()
                    .map(|error| div().text_color(color(Token::Destructive, cx)).child(error)),
            )
            .children((!self.invitations.is_empty()).then(|| {
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child("Invitations"),
                    )
                    .children(self.invitations.clone().into_iter().enumerate().map(
                        |(index, invitation)| {
                            let (accept_id, decline_id) =
                                (invitation.id.clone(), invitation.id.clone());
                            h_flex()
                                .gap_2()
                                .child(div().flex_1().child(invitation.organization_name.clone()))
                                .child(
                                    div()
                                        .text_color(color(Token::MutedForeground, cx))
                                        .child(invitation.role.clone()),
                                )
                                .child(
                                    Button::new(("accept-invitation", index))
                                        .primary()
                                        .label("Accept")
                                        .disabled(self.pending)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.answer(accept_id.clone(), true, cx)
                                        })),
                                )
                                .child(
                                    Button::new(("decline-invitation", index))
                                        .ghost()
                                        .label("Decline")
                                        .disabled(self.pending)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.answer(decline_id.clone(), false, cx)
                                        })),
                                )
                        },
                    ))
            }))
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child("Your organizations"),
                    )
                    .children(self.loading.then(|| div().child("Loading organizations…")))
                    .children((!self.loading && self.organizations.is_empty()).then(|| {
                        div()
                            .text_color(color(Token::MutedForeground, cx))
                            .child("You are not in an organization yet.")
                    }))
                    .children(self.organizations.clone().into_iter().enumerate().map(
                        |(index, organization)| {
                            let url = origin
                                .as_ref()
                                .map(|origin| format!("{origin}/{}", organization.slug));
                            h_flex()
                                .gap_2()
                                .child(div().flex_1().child(organization.name.clone()))
                                .child(
                                    div()
                                        .text_color(color(Token::MutedForeground, cx))
                                        .child(organization.slug.clone()),
                                )
                                .children(url.map(|url| {
                                    Button::new(("open-organization", index))
                                        .ghost()
                                        .label("Members and projects")
                                        .on_click(move |_, _, cx| cx.open_url(&url))
                                }))
                        },
                    )),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child("New organization"),
                    )
                    .child("Name")
                    .child(
                        Input::new(&self.name)
                            .aria_label("Organization name")
                            .disabled(self.pending),
                    )
                    .child("Slug")
                    .child(
                        Input::new(&self.slug)
                            .aria_label("Organization slug")
                            .disabled(self.pending),
                    )
                    .child(
                        Button::new("create-organization")
                            .primary()
                            .label(if self.pending {
                                "Creating…"
                            } else {
                                "New organization"
                            })
                            .disabled(
                                self.pending
                                    || self.name.read(cx).value().trim().is_empty()
                                    || self.slug.read(cx).value().trim().is_empty(),
                            )
                            .on_click(cx.listener(|this, _, window, cx| this.create(window, cx))),
                    ),
            )
    }
}
