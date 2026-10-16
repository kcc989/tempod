//! Settings → Models (04; 07): the owner's model list (01, Model list). Each change saves at once.
use super::chat_model::{agent_label, new_chat_agents};
use super::models_model::{model_columns, pick_name, toggle_pick};
use super::tokens::{ICON_BUTTON, Token, color};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::{Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use tempo_client::Client;
use tempo_protocol::{self as p, api};

pub const DESCRIPTION: &str = "Choose which models you want to use.";

pub struct ModelsPage {
    client: Option<Client>,
    credentials: Option<p::CredentialStatus>,
    models: Option<Vec<p::AgentModelOptions>>,
    saved: Option<Vec<p::ModelPick>>,
    picks: Option<Vec<p::ModelPick>>,
    load_error: Option<String>,
    models_error: Option<String>,
}

impl ModelsPage {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let client = crate::app::AppState::try_global(cx).and_then(|a| a.read(cx).client());
        let mut this = Self {
            client,
            credentials: None,
            models: None,
            saved: None,
            picks: None,
            load_error: None,
            models_error: None,
        };
        this.load(window, cx);
        this
    }

    pub(crate) fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = &self.client else {
            return;
        };
        self.load_error = None;
        self.models_error = None;
        let credentials = client.call::<api::GetCredentialStatus>(p::Empty {});
        let list = client.call::<api::GetModelList>(p::Empty {});
        let models = client.call::<api::ListModels>(p::Empty {});
        cx.spawn_in(window, async move |this, cx| {
            let (credentials, list) = (credentials.await, list.await);
            let _ = this.update(cx, |this, cx| {
                match (credentials, list) {
                    (Ok(credentials), Ok(list)) => {
                        this.credentials = Some(credentials);
                        this.saved = Some(list.models.clone());
                        this.picks = Some(list.models);
                    }
                    (Err(e), _) | (_, Err(e)) => {
                        this.load_error = Some(super::toast::error_text(&e, None))
                    }
                }
                cx.notify();
            });
            let models = models.await;
            let _ = this.update(cx, |this, cx| {
                match models {
                    Ok(models) => this.models = Some(models),
                    Err(e) => this.models_error = Some(super::toast::error_text(&e, None)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn change(&mut self, next: Vec<p::ModelPick>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.picks = Some(next.clone());
        cx.notify();
        let request = client.call::<api::SetModelList>(p::SetModelListIn { models: next });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(list) => this.saved = Some(list.models),
                    Err(e) => {
                        this.picks = this.saved.clone();
                        super::toast::error(&e, None, window, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_picks(&self, picks: &[p::ModelPick], cx: &mut Context<Self>) -> AnyElement {
        let muted = color(Token::MutedForeground, cx);
        let models = self.models.clone().unwrap_or_default();
        let header = h_flex()
            .justify_between()
            .child(div().text_sm().child("Your models"))
            .children((!picks.is_empty()).then(|| {
                Button::new("models-show-all")
                    .ghost()
                    .small()
                    .label("Show all models")
                    .on_click(cx.listener(|this, _, window, cx| this.change(vec![], window, cx)))
            }));
        let body = if picks.is_empty() {
            div()
                .text_sm()
                .text_color(muted)
                .child("All reported models are shown.")
                .into_any_element()
        } else {
            h_flex()
                .id("models-picks")
                .role(Role::List)
                .aria_label("Your models")
                .flex_wrap()
                .gap_2()
                .children(picks.iter().enumerate().map(|(row, pick)| {
                    let name = pick_name(pick, &models);
                    let target = pick.clone();
                    h_flex()
                        .id(SharedString::from(format!("models-pick-{row}")))
                        .role(Role::ListItem)
                        .gap_1()
                        .pl_3()
                        .pr_1()
                        .py_1()
                        .rounded_md()
                        .border_1()
                        .border_color(color(Token::Border, cx))
                        .text_sm()
                        .child(name.clone())
                        .child(
                            div()
                                .text_color(muted)
                                .child(format!("· {}", agent_label(pick.agent))),
                        )
                        .child(
                            Button::new(SharedString::from(format!("models-remove-{row}")))
                                .ghost()
                                .small()
                                .size(px(ICON_BUTTON))
                                .icon(IconName::X)
                                .accessibility_label(format!("Remove {name}"))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    let picks = this.picks.clone().unwrap_or_default();
                                    let next = toggle_pick(&picks, target.agent, &target.model);
                                    this.change(next, window, cx)
                                })),
                        )
                }))
                .into_any_element()
        };
        v_flex()
            .gap_2()
            .child(header)
            .child(body)
            .into_any_element()
    }

    fn render_columns(
        &self,
        available: &[p::AgentId],
        picks: &[p::ModelPick],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let muted = color(Token::MutedForeground, cx);
        let Some(models) = &self.models else {
            return match &self.models_error {
                Some(e) => h_flex()
                    .gap_2()
                    .child(div().text_sm().child(e.clone()))
                    .child(
                        Button::new("models-retry")
                            .small()
                            .outline()
                            .label("Retry")
                            .on_click(cx.listener(|this, _, window, cx| this.load(window, cx))),
                    )
                    .into_any_element(),
                None => div()
                    .text_sm()
                    .text_color(muted)
                    .child("Loading models…")
                    .into_any_element(),
            };
        };
        h_flex()
            .flex_wrap()
            .items_start()
            .gap_3()
            .children(
                model_columns(available, models, picks)
                    .into_iter()
                    .map(|(agent, rows)| {
                        v_flex()
                            .id(SharedString::from(format!("models-column-{agent}")))
                            .aria_label(agent_label(agent))
                            .w(px(208.))
                            .rounded_lg()
                            .border_1()
                            .border_color(color(Token::Border, cx))
                            .child(
                                div()
                                    .px_3()
                                    .py_2()
                                    .border_b_1()
                                    .border_color(color(Token::Border, cx))
                                    .text_sm()
                                    .child(agent_label(agent)),
                            )
                            .children(rows.into_iter().enumerate().map(|(ix, row)| {
                                let label = if row.reported {
                                    row.name.clone()
                                } else {
                                    format!("{} · Not reported", row.model)
                                };
                                let model = row.model.clone();
                                div().px_3().py_2().child(
                                    Checkbox::new(SharedString::from(format!(
                                        "models-{agent}-{ix}"
                                    )))
                                    .checked(row.picked)
                                    .label(label)
                                    .on_click(cx.listener(move |this, _: &bool, window, cx| {
                                        let picks = this.picks.clone().unwrap_or_default();
                                        let next = toggle_pick(&picks, agent, &model);
                                        this.change(next, window, cx)
                                    })),
                                )
                            }))
                    }),
            )
            .into_any_element()
    }
}

impl Render for ModelsPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = color(Token::MutedForeground, cx);
        if let Some(e) = &self.load_error {
            return h_flex()
                .gap_2()
                .child(div().text_sm().child(e.clone()))
                .child(
                    Button::new("models-load-retry")
                        .small()
                        .outline()
                        .label("Retry")
                        .on_click(cx.listener(|this, _, window, cx| this.load(window, cx))),
                )
                .into_any_element();
        }
        let (Some(credentials), Some(picks)) = (self.credentials.clone(), self.picks.clone())
        else {
            return div()
                .text_sm()
                .text_color(muted)
                .child("Loading…")
                .into_any_element();
        };
        let available = new_chat_agents(Some(&credentials));
        if available.is_empty() {
            return v_flex()
                .gap_2()
                .child(div().text_sm().child("No agent has a login."))
                .child(
                    Button::new("models-connect")
                        .small()
                        .outline()
                        .label("Connect another agent")
                        .on_click(|_, _, cx| super::settings::open_logins(cx)),
                )
                .into_any_element();
        }
        v_flex()
            .gap_6()
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("Choose which models appear when you create a workspace or chat."),
            )
            .child(self.render_picks(&picks, cx))
            .child(self.render_columns(&available, &picks, cx))
            .into_any_element()
    }
}
