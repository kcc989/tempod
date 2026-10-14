//! The Mac terminal panel launches the cloud shell in Terminal.app or iTerm.
use super::tokens::{Token, color};
use crate::terminal_launch::{self, TerminalApplication};
use gpui_kit::component::button::Button;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{Context, IntoElement, ParentElement as _, Render, Styled as _, Window, div};

#[derive(Default)]
pub struct TerminalPanel {
    workspace_id: Option<String>,
    selected: usize,
    pending: bool,
    error: Option<&'static str>,
}

impl TerminalPanel {
    pub fn set_workspace(&mut self, workspace: Option<String>) {
        if self.workspace_id != workspace {
            self.workspace_id = workspace;
            self.selected = 0;
            self.error = None;
        }
    }

    fn open(&mut self, app: TerminalApplication, cx: &mut Context<Self>) {
        let Some(workspace) = self.workspace_id.clone() else {
            return;
        };
        if self.pending {
            return;
        }
        let terminal = tempo_client::TERMINAL_IDS[self.selected];
        self.pending = true;
        self.error = None;
        let (send, result) = async_channel::bounded(1);
        let launched_workspace = workspace.clone();
        std::thread::spawn(move || {
            let _ = send.send_blocking(terminal_launch::open(app, &launched_workspace, terminal));
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = result.recv().await {
                let _ = this.update(cx, |panel, cx| {
                    panel.pending = false;
                    if panel.workspace_id.as_ref() == Some(&workspace) {
                        panel.error = result.err();
                    }
                    cx.notify();
                });
            }
        })
        .detach();
        cx.notify();
    }
}

impl Render for TerminalPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let disabled = self.workspace_id.is_none() || self.pending;
        v_flex()
            .size_full()
            .gap_3()
            .p_3()
            .child(
                TabBar::new("local-terminal-tabs")
                    .selected_index(self.selected)
                    .on_click(cx.listener(|this, index: &usize, _, cx| {
                        this.selected = *index;
                        cx.notify();
                    }))
                    .children(tempo_client::TERMINAL_IDS.map(|id| Tab::new().label(id))),
            )
            .child(div().text_sm().child(if self.workspace_id.is_some() {
                "Open the cloud shell in your Mac terminal. Ctrl+] disconnects."
            } else {
                "Select a workspace to open its terminal."
            }))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("open-terminal-app")
                            .label("Open in Terminal")
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.open(TerminalApplication::Terminal, cx)
                            })),
                    )
                    .child(
                        Button::new("open-iterm-app")
                            .label("Open in iTerm")
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.open(TerminalApplication::ITerm, cx)
                            })),
                    ),
            )
            .children(self.error.map(|error| {
                div()
                    .text_sm()
                    .text_color(color(Token::Destructive, cx))
                    .child(error)
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changing_workspaces_resets_the_terminal_picker_and_old_error() {
        let mut panel = TerminalPanel::default();
        panel.set_workspace(Some("workspace1".into()));
        panel.selected = 4;
        panel.error = Some("old error");
        panel.set_workspace(Some("workspace1".into()));
        assert_eq!(panel.selected, 4);
        panel.set_workspace(Some("workspace2".into()));
        assert_eq!(panel.selected, 0);
        assert_eq!(panel.error, None);
    }
}
