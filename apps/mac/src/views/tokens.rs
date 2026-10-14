//! The colour tokens of 04 mapped to GPUI Kit `ThemeColor` fields, once (07, Window layout).
//! Views read colours only through [`color`]; no colour values in views.
use gpui_kit::component::{ActiveTheme as _, ThemeColor};
use gpui_kit::{App, Hsla};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Token {
    Background,
    Foreground,
    Sidebar,
    SidebarAccent,
    /// `--muted-foreground`
    MutedForeground,
    Muted,
    Panel,
    /// `--primary`
    Primary,
    /// `--destructive`
    Destructive,
    /// `--warning` (04's custom token)
    Warning,
    Border,
    /// `--input`: edges of text fields and the composer, at least 3:1 against every surface.
    Input,
    /// Added lines in the diff view (07, Changes); open PRs and passed checks (04, Indicators).
    Success,
    /// `--merged`: merged PRs (04, Indicators).
    Merged,
}

/// WCAG 2.5.8: icon-only buttons are at least 24 pt. GPUI Kit's small icon size follows the 13 pt rem.
pub const ICON_BUTTON: f32 = 24.;

/// A toggle or choice that is on: primary text on a primary tint, at least 3:1 against the surface (04).
pub trait ToggleOn {
    fn toggle_on(self, on: bool, cx: &App) -> Self;
}

impl ToggleOn for gpui_kit::component::button::Button {
    fn toggle_on(self, on: bool, cx: &App) -> Self {
        use gpui_kit::Styled as _;
        if !on {
            return self;
        }
        let primary = color(Token::Primary, cx);
        self.bg(primary.opacity(0.16)).text_color(primary)
    }
}

pub fn color(token: Token, cx: &App) -> Hsla {
    from_theme(cx.theme(), token)
}

pub fn from_theme(colors: &ThemeColor, token: Token) -> Hsla {
    match token {
        Token::Background => colors.background,
        Token::Foreground => colors.foreground,
        Token::Sidebar => colors.sidebar,
        Token::SidebarAccent => colors.sidebar_accent,
        Token::MutedForeground => colors.muted_foreground,
        Token::Muted => colors.muted,
        Token::Panel => colors.tab_bar,
        Token::Primary => colors.primary,
        Token::Destructive => colors.danger,
        Token::Warning => colors.warning,
        Token::Border => colors.border,
        Token::Input => colors.input,
        Token::Success => colors.success,
        Token::Merged => colors.magenta,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::hsla;

    #[test]
    fn each_token_reads_its_own_field() {
        let mut colors = ThemeColor::default();
        let tokens = [
            Token::Background,
            Token::Foreground,
            Token::Sidebar,
            Token::MutedForeground,
            Token::Primary,
            Token::Destructive,
            Token::Warning,
            Token::Border,
            Token::Success,
            Token::Merged,
        ];
        assert_eq!(from_theme(&colors, Token::Muted), colors.muted);
        colors.background = hsla(0.0, 0.0, 0.0, 1.0);
        colors.foreground = hsla(0.1, 0.0, 0.0, 1.0);
        colors.sidebar = hsla(0.2, 0.0, 0.0, 1.0);
        colors.muted_foreground = hsla(0.3, 0.0, 0.0, 1.0);
        colors.primary = hsla(0.4, 0.0, 0.0, 1.0);
        colors.danger = hsla(0.5, 0.0, 0.0, 1.0);
        colors.warning = hsla(0.6, 0.0, 0.0, 1.0);
        colors.border = hsla(0.7, 0.0, 0.0, 1.0);
        colors.success = hsla(0.8, 0.0, 0.0, 1.0);
        colors.magenta = hsla(0.9, 0.0, 0.0, 1.0);
        for (ix, token) in tokens.into_iter().enumerate() {
            assert_eq!(from_theme(&colors, token).h, ix as f32 / 10.0, "{token:?}");
        }
    }
}

/// Install both palettes so system and manual theme changes keep Tempo's surfaces.
pub fn install(cx: &mut App) {
    use gpui_kit::component::Theme;
    use std::rc::Rc;
    Theme::update(cx, |theme| {
        for (original, dark) in [
            (&mut theme.light_theme, false),
            (&mut theme.dark_theme, true),
        ] {
            let mut config = (**original).clone();
            config.name = "Tempo".into();
            config.font_size = Some(13.);
            config.shadow = Some(true);
            let c = &mut config.colors;
            let (
                background,
                sidebar,
                panel,
                surface,
                popup,
                hover,
                selected,
                text,
                muted,
                border,
                primary,
                on_primary,
                input,
            ) = if dark {
                (
                    "#0f0f0f", "#151515", "#161616", "#222222", "#181818", "#262626", "#242424",
                    "#f2f2f2", "#989898", "#2b2b2b", "#478bfb", "#0a0a0a", "#707070",
                )
            } else {
                (
                    "#ffffff", "#f9f9f9", "#ffffff", "#f5f5f5", "#ffffff", "#f0f0f0", "#ebebeb",
                    "#0a0a0a", "#696969", "#e6e6e6", "#2563eb", "#fafafa", "#858585",
                )
            };
            c.background = Some(background.into());
            c.foreground = Some(text.into());
            c.sidebar = Some(sidebar.into());
            c.sidebar_foreground = Some(text.into());
            c.sidebar_accent = Some(selected.into());
            c.sidebar_accent_foreground = Some(text.into());
            c.sidebar_border = Some(border.into());
            c.sidebar_primary = Some(primary.into());
            c.muted = Some(surface.into());
            c.muted_foreground = Some(muted.into());
            c.popover = Some(popup.into());
            c.popover_foreground = Some(text.into());
            c.accent = Some(hover.into());
            c.accent_foreground = Some(text.into());
            c.border = Some(border.into());
            c.input = Some(input.into());
            c.ring = Some(primary.into());
            c.primary = Some(primary.into());
            c.primary_foreground = Some(on_primary.into());
            c.primary_hover = Some(primary.into());
            c.primary_active = Some(primary.into());
            c.button = Some(surface.into());
            c.button_foreground = Some(text.into());
            c.button_hover = Some(hover.into());
            c.button_active = Some(selected.into());
            c.list = Some(popup.into());
            c.list_hover = Some(hover.into());
            c.list_active = Some(selected.into());
            c.list_active_border = Some(primary.into());
            c.tab_bar = Some(panel.into());
            c.tab = Some(panel.into());
            c.tab_foreground = Some(muted.into());
            c.tab_active = Some(background.into());
            c.tab_active_foreground = Some(text.into());
            c.title_bar = Some(sidebar.into());
            c.title_bar_border = Some(border.into());
            *original = Rc::new(config);
        }
    });
    let mode = Theme::global(cx).mode;
    Theme::change(mode, None, cx);
}

#[cfg(test)]
mod palette_tests {
    use super::*;
    use gpui_kit::component::{Theme, ThemeMode};

    #[gpui_kit::test]
    fn tempo_surfaces_survive_theme_switches(cx: &mut gpui_kit::TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            install(cx);
            for mode in [ThemeMode::Dark, ThemeMode::Light, ThemeMode::Dark] {
                Theme::change(mode, None, cx);
                let c = &Theme::global(cx).colors;
                assert_ne!(c.background, c.sidebar);
                if mode == ThemeMode::Dark {
                    assert_ne!(c.background, c.popover);
                } else {
                    assert_ne!(c.background, c.border);
                }
                assert_ne!(c.popover, c.list_active);
                assert_ne!(c.primary, c.foreground);
                if mode == ThemeMode::Dark {
                    assert_eq!(c.background, gpui_kit::rgb(0x0f0f0f).into());
                    assert_eq!(c.popover, gpui_kit::rgb(0x181818).into());
                }
            }
        });
    }
}
